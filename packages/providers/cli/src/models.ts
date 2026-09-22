import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { modelInfoSchema, type Logger, type ModelInfo } from "@ai-workbench/shared";

const CACHE_FILE = "models.json";

const cacheFileSchema = z.object({
  updatedAt: z.string().datetime({ offset: true }),
  models: z.array(modelInfoSchema),
});

/** Keeps only entries that are valid models; anything else is dropped, not guessed at. */
export function validModels(input: unknown): ModelInfo[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const parsed = modelInfoSchema.safeParse(entry);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      models.push(parsed.data);
    }
  }
  return models;
}

/** Reads a model list a tool printed as JSON, in the shapes tools use. */
function parseModelJson(stdout: string): ModelInfo[] | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // `[...]`, `{data:[...]}` and `{models:[...]}` are all in use.
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? ((payload as Record<string, unknown>)["data"] ??
        (payload as Record<string, unknown>)["models"])
      : undefined;
  if (!Array.isArray(list)) {
    return null;
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const entry of list) {
    const id =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null
          ? String(
              (entry as Record<string, unknown>)["id"] ??
                (entry as Record<string, unknown>)["name"] ??
                "",
            )
          : "";
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    const named =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)["displayName"] ??
          (entry as Record<string, unknown>)["display_name"] ??
          (entry as Record<string, unknown>)["label"]
        : undefined;
    seen.add(id);
    models.push({
      id,
      displayName: typeof named === "string" && named.length > 0 ? named : id,
    });
  }
  return models.length > 0 ? models : null;
}

/** A line that is a heading, a rule, or prose rather than a model. */
function isNoise(line: string): boolean {
  if (line.length === 0) {
    return true;
  }
  // Separator rules and box drawing.
  if (/^[-=_~|+\s]+$/.test(line)) {
    return true;
  }
  // A sentence: several words, no token that could be an id.
  return !/[A-Za-z0-9][A-Za-z0-9._:/-]*/.test(line);
}

/**
 * Parses a tool's model list.
 *
 * Tools print these lists very differently, and a list that cannot be read is
 * the same to the user as a tool with no list at all — so this accepts the
 * shapes they actually use rather than one:
 *
 *   claude-opus-5
 *   anthropic/claude-opus-5            provider-qualified ids
 *   gemini-3-pro\tGemini 3 Pro          a tab before a display name
 *   gemini-3-pro    Gemini 3 Pro       aligned columns
 *   * gpt-5.5 (default)                bullets and annotations
 *   {"data":[{"id":"…"}]}              JSON
 *
 * Headings, rules and prose are skipped. Anything left becomes a model with
 * its own id as the display name, which is honest: the id is what the tool
 * gave us.
 */
export function parseModelLines(stdout: string): ModelInfo[] {
  const fromJson = parseModelJson(stdout);
  if (fromJson) {
    return fromJson;
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const raw of stdout.split("\n")) {
    // Strip a bullet, then split on a tab or a run of spaces used as a column.
    const line = raw.replace(/\r$/, "").trim().replace(/^[*\u2022-]\s+/, "");
    if (isNoise(line)) {
      continue;
    }

    const [rawId = "", ...rest] = line.split(/\t|\s{2,}/);
    const id = rawId.trim();
    // An id has no spaces; a line whose first field does is a sentence.
    if (id.length === 0 || /\s/.test(id) || seen.has(id)) {
      continue;
    }

    const displayName = rest.join(" ").replace(/\s+/g, " ").trim();
    seen.add(id);
    models.push({ id, displayName: displayName.length > 0 ? displayName : id });
  }
  return models;
}

/**
 * The models a provider entry offers, from three sources of different weight
 * (spec §56 applies to models too: only what the tool reports is a fact).
 *
 * - discovered  what the tool itself reported, remembered on disk so a restart
 *               shows the last known list at once
 * - user        entered on the Providers screen: adds models the tool did not
 *               report, or renames one it did
 * - profile     shipped defaults, used only when neither of the others exists
 */
export class ModelStore {
  readonly #logger: Logger;
  readonly #onChange: () => void;
  #discovered: ModelInfo[] | null = null;
  #updatedAt: Date | null = null;
  #file: string | null = null;
  #inFlight: Promise<void> | null = null;
  /** Bumped by `reset`, so a discovery that started before it is not applied. */
  #epoch = 0;

  /** `onChange` is called when a discovery changed the list. */
  constructor(logger: Logger, onChange: () => void) {
    this.#logger = logger;
    this.#onChange = onChange;
  }

  /** When the tool last reported its models; null if it never has. */
  get updatedAt(): Date | null {
    return this.#updatedAt;
  }

  /** Points the store at a state directory and loads what was remembered there. */
  async load(stateDirectory: string): Promise<void> {
    this.reset();
    this.#file = join(stateDirectory, CACHE_FILE);
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch {
      return; // Nothing remembered yet.
    }
    try {
      const parsed = cacheFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.models.length > 0) {
        this.#discovered = parsed.data.models.map(asDiscovered);
        this.#updatedAt = new Date(parsed.data.updatedAt);
        return;
      }
    } catch {
      // Unreadable JSON is handled like an invalid file below.
    }
    this.#logger.warn("Ignoring an unreadable model cache", { file: this.#file });
  }

  /** Forgets a discovery in progress, e.g. when the entry is disposed. */
  reset(): void {
    this.#epoch += 1;
    this.#inFlight = null;
  }

  /**
   * Asks the tool, once at a time. A discovery that reports nothing keeps the
   * previous list: an empty answer from a tool that lists models is a failure
   * to read them, not a fact. `discover` must not throw.
   */
  refresh(discover: () => Promise<ModelInfo[] | null>): Promise<void> {
    if (this.#inFlight) {
      return this.#inFlight;
    }
    const epoch = this.#epoch;
    const pending = (async (): Promise<void> => {
      const reported = validModels(await discover());
      if (epoch !== this.#epoch || reported.length === 0) {
        return;
      }
      const models = reported.map(asDiscovered);
      const changed = JSON.stringify(models) !== JSON.stringify(this.#discovered);
      this.#discovered = models;
      this.#updatedAt = new Date();
      await this.#persist(models, this.#updatedAt);
      if (changed) {
        try {
          this.#onChange();
        } catch (error) {
          this.#logger.debug("Change notification failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

  /** The list to offer, given the user's own entries and the profile's defaults. */
  list(userModels: readonly ModelInfo[], profileModels: readonly ModelInfo[]): ModelInfo[] {
    const discovered = this.#discovered ?? [];
    if (discovered.length === 0 && userModels.length === 0) {
      return profileModels.map((model) => ({ ...model, source: "profile" }));
    }

    // An entry that only repeats the id is not a name the user chose.
    const renames = new Map(
      userModels
        .filter((model) => model.displayName !== model.id)
        .map((model) => [model.id, model.displayName]),
    );
    const reported = new Set(discovered.map((model) => model.id));
    return [
      ...discovered.map((model) => {
        const name = renames.get(model.id);
        return name ? { ...model, displayName: name } : { ...model };
      }),
      ...userModels
        .filter((model) => !reported.has(model.id))
        .map((model): ModelInfo => ({ ...model, source: "user" })),
    ];
  }

  async #persist(models: ModelInfo[], updatedAt: Date): Promise<void> {
    if (!this.#file) {
      return;
    }
    const file = this.#file;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        temporary,
        `${JSON.stringify({ updatedAt: updatedAt.toISOString(), models }, null, 2)}\n`,
        "utf8",
      );
      // Written aside and renamed, so a crash never leaves half a file behind.
      await rename(temporary, file);
    } catch (error) {
      this.#logger.warn("Could not remember the model list", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function asDiscovered(model: ModelInfo): ModelInfo {
  return { ...model, source: "provider" };
}
