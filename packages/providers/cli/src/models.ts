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

/**
 * Parses a tool's model list: one `provider/model` id per line, as printed by
 * commands like `opencode models`. Blank lines and surrounding whitespace are
 * ignored; anything else becomes a model with its own id as display name.
 */
export function parseModelLines(stdout: string): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const line of stdout.split("\n")) {
    const id = line.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ id, displayName: id });
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
