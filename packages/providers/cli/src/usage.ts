import {
  providerUsageSnapshotSchema,
  type Logger,
  type ProviderUsageSnapshot,
  type UsageLimit,
} from "@ai-workbench/shared";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface UsageStoreOptions {
  readonly providerId: string;
  readonly logger: Logger;
  /**
   * Reads the account's limits without spending a turn. Absent when the tool
   * cannot; then only what a turn reports is known. Must not throw.
   */
  readonly read?: (() => Promise<ProviderUsageSnapshot | null>) | undefined;
  /** Called when what `get` would return has changed. */
  readonly onChange: () => void;
  /** A snapshot older than this is refreshed in the background. */
  readonly staleAfterMs?: number;
  /** How long a caller waits for the very first reading before being told "unavailable". */
  readonly firstReadWaitMs?: number;
  readonly now?: () => number;
}

const TURN_NOTE = "Usage is reported while the tool works; it has not reported any yet.";
const USAGE_FILE = "usage.json";
const FAILED_NOTE = "The tool did not report its usage.";
const PENDING_NOTE = "Usage is still being read from the tool.";

/**
 * Reads `opencode stats --json`: lifetime token counts and cost. Only what
 * the tool prints becomes a limit — no quota is assumed, so these render as
 * consumed amounts, never as remaining percentages (spec §55, §56).
 */
export function parseOpencodeStatsUsage(stdout: string): UsageLimit[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = z
    .object({
      tokens: z
        .object({
          input: z.number().nonnegative().optional(),
          output: z.number().nonnegative().optional(),
          reasoning: z.number().nonnegative().optional(),
        })
        .optional(),
      cost: z.number().nonnegative().optional(),
    })
    .safeParse(data);
  if (!parsed.success) {
    return null;
  }
  const limits: UsageLimit[] = [];
  const tokens = parsed.data.tokens;
  if (tokens) {
    const used =
      (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0);
    limits.push({ id: "tokens", label: "Tokens", used, unit: "tokens" });
  }
  if (parsed.data.cost !== undefined) {
    limits.push({ id: "cost", label: "Cost", used: parsed.data.cost, unit: "usd" });
  }
  return limits.length > 0 ? limits : null;
}

/**
 * What is known about one entry's usage limits (spec §55, §56, §108).
 *
 * Two sources feed it: a reading the tool gives without spending a turn, and
 * the limits a turn reports on the way. The newer one is served. A reading is
 * refreshed in the background once it is older than a few minutes — callers
 * get the last known snapshot at once instead of waiting for a process, and
 * the tool is asked at most once per interval, never once per caller.
 */
export class UsageStore {
  readonly #options: UsageStoreOptions;
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  #reading: ProviderUsageSnapshot | null = null;
  #turn: ProviderUsageSnapshot | null = null;
  #inFlight: Promise<void> | null = null;
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  #failed = false;
  /** Bumped by `reset`, so a reading that started before it is not applied. */
  #epoch = 0;
  /** Where the last known snapshot is kept between runs; null until loaded. */
  #file: string | null = null;

  constructor(options: UsageStoreOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#staleAfterMs = options.staleAfterMs ?? 3 * 60_000;
  }

  async get(): Promise<ProviderUsageSnapshot> {
    const known = this.#freshest();
    if (!this.#options.read) {
      return known ?? this.#unavailable(TURN_NOTE);
    }

    const now = this.#now();
    if (known) {
      if (
        now - known.updatedAt.getTime() >= this.#staleAfterMs &&
        now - this.#lastAttemptAt >= this.#staleAfterMs
      ) {
        void this.#refresh();
      }
      return known;
    }

    // Nothing known yet. A reading that just failed is not repeated for every
    // caller; the next attempt waits for the interval like a refresh does.
    if (!this.#inFlight && now - this.#lastAttemptAt < this.#staleAfterMs) {
      return this.#unavailable(this.#failed ? FAILED_NOTE : PENDING_NOTE);
    }

    const reading = this.#refresh();
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#options.firstReadWaitMs ?? 20_000);
      timer.unref?.();
    });
    await Promise.race([reading, waited]);
    clearTimeout(timer);

    return (
      this.#freshest() ??
      this.#unavailable(this.#inFlight ? PENDING_NOTE : FAILED_NOTE)
    );
  }

  /**
   * Restores the last snapshot the tool reported, so usage is known from the
   * first moment after a restart. It keeps its original time: the person sees
   * how old it is, and a reading refreshes it once it is stale.
   */
  async load(stateDirectory: string): Promise<void> {
    this.#file = join(stateDirectory, USAGE_FILE);
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch {
      return; // Nothing remembered yet.
    }
    const parsed = providerUsageSnapshotSchema.safeParse(reviveDates(safeJson(raw)));
    if (!parsed.success || parsed.data.state === "unavailable") {
      this.#options.logger.debug("Ignoring an unreadable usage file", { file: this.#file });
      return;
    }
    const restored = { ...parsed.data, providerId: this.#options.providerId };
    if (!this.#reading || this.#reading.updatedAt.getTime() < restored.updatedAt.getTime()) {
      this.#reading = restored;
    }
  }

  /** Records the limits a turn reported. */
  observeTurn(limits: readonly UsageLimit[], at: Date = new Date(this.#now())): void {
    if (limits.length === 0) {
      return;
    }
    const before = signature(this.#freshest());
    const plan = this.#reading?.plan;
    this.#turn = {
      providerId: this.#options.providerId,
      state: "available",
      limits: [...limits],
      updatedAt: at,
      source: "cli",
      // The plan does not change between turns; a turn just does not say it.
      ...(plan === undefined ? {} : { plan }),
    };
    if (signature(this.#freshest()) !== before) {
      this.#notify();
    }
  }

  /** Forgets any reading in progress, e.g. after the configuration changed. */
  reset(): void {
    this.#epoch += 1;
    this.#inFlight = null;
    this.#lastAttemptAt = Number.NEGATIVE_INFINITY;
    this.#failed = false;
  }

  #refresh(): Promise<void> {
    const read = this.#options.read;
    if (!read) {
      return Promise.resolve();
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }
    this.#lastAttemptAt = this.#now();
    const epoch = this.#epoch;

    const pending = (async (): Promise<void> => {
      const snapshot = await read();
      if (epoch !== this.#epoch) {
        return;
      }
      const parsed = snapshot === null ? null : providerUsageSnapshotSchema.safeParse(snapshot);
      if (!parsed?.success) {
        if (parsed) {
          this.#options.logger.warn("Ignoring a usage reading that is not valid", {
            providerId: this.#options.providerId,
            issue: parsed.error.issues[0]?.message,
          });
        }
        this.#failed = true;
        return;
      }
      this.#failed = false;
      const before = signature(this.#freshest());
      this.#reading = { ...parsed.data, providerId: this.#options.providerId };
      if (signature(this.#freshest()) !== before) {
        this.#notify();
      }
    })();

    const settled = pending.finally(() => {
      if (this.#inFlight === settled) {
        this.#inFlight = null;
      }
    });
    this.#inFlight = settled;
    return settled;
  }

  /** The newer of the two sources; a reading wins a tie, it says more. */
  #freshest(): ProviderUsageSnapshot | null {
    const reading = this.#reading;
    const turn = this.#turn;
    if (!reading || !turn) {
      return reading ?? turn;
    }
    return turn.updatedAt.getTime() > reading.updatedAt.getTime() ? turn : reading;
  }

  #unavailable(note: string): ProviderUsageSnapshot {
    return {
      providerId: this.#options.providerId,
      state: "unavailable",
      limits: [],
      updatedAt: new Date(this.#now()),
      source: "cli",
      note,
    };
  }

  #notify(): void {
    void this.#persist(this.#freshest());
    try {
      this.#options.onChange();
    } catch (error) {
      this.#options.logger.debug("Change notification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #persist(snapshot: ProviderUsageSnapshot | null): Promise<void> {
    const file = this.#file;
    if (!file || !snapshot || snapshot.state === "unavailable") {
      return;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}
`, "utf8");
      // Written aside and renamed, so a crash never leaves half a file behind.
      await rename(temporary, file);
    } catch (error) {
      this.#options.logger.debug("Could not remember usage", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Turns the ISO strings a snapshot was saved with back into dates. */
function reviveDates(record: unknown): unknown {
  if (!isRecord(record)) {
    return record;
  }
  const limits = Array.isArray(record["limits"])
    ? record["limits"].map((entry: unknown) => {
        if (!isRecord(entry)) {
          return entry;
        }
        const resetsAt = entry["resetsAt"];
        return typeof resetsAt === "string" ? { ...entry, resetsAt: new Date(resetsAt) } : entry;
      })
    : record["limits"];
  const updatedAt = record["updatedAt"];
  return {
    ...record,
    limits,
    updatedAt: typeof updatedAt === "string" ? new Date(updatedAt) : updatedAt,
  };
}

/** What a caller would see, without the time it was read. */
function signature(snapshot: ProviderUsageSnapshot | null): string {
  if (!snapshot) {
    return "";
  }
  const { state, limits, plan, note } = snapshot;
  return JSON.stringify({ state, limits, plan, note });
}
