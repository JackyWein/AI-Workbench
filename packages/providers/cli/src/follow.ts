import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Upper bound read per poll, so a huge log never blocks the main process. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Reads a newline-delimited JSON file as it grows (spec §55): every call
 * returns only the records written since the last one. A line still being
 * written is kept until its newline arrives, and a file that shrank — a tool
 * that rewrote its log — is read again from the start.
 */
export class JsonLinesFollower {
  readonly #path: string;
  #offset = 0;
  #partial = "";

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /** Records appended since the last call; malformed lines are skipped. */
  async readNew(): Promise<unknown[]> {
    let size: number;
    try {
      size = (await stat(this.#path)).size;
    } catch {
      return [];
    }
    if (size < this.#offset) {
      this.#offset = 0;
      this.#partial = "";
    }
    if (size === this.#offset) {
      return [];
    }

    const length = Math.min(size - this.#offset, MAX_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(this.#path, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
      this.#offset += bytesRead;
      const text = this.#partial + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      this.#partial = lines.pop() ?? "";
      return lines.flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return [];
        }
        try {
          const record: unknown = JSON.parse(trimmed);
          return [record];
        } catch {
          return [];
        }
      });
    } finally {
      await handle.close();
    }
  }
}

/** Reads a whole JSON file; null when it is missing or not (yet) valid JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  try {
    const handle = await open(path, "r");
    try {
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      return parsed;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Modification time of a file in milliseconds, or null when it is missing. */
export async function modifiedAt(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Entries of a directory, or none when it cannot be read. */
export async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** Joins and lists in one step; the full paths of the entries. */
export async function listPaths(path: string): Promise<string[]> {
  return (await listDirectory(path)).map((entry) => join(path, entry));
}

/**
 * Calls `tick` every `intervalMs` until stopped, never overlapping two runs
 * and never letting a failure escape. The first run happens at once.
 */
export function poll(tick: () => Promise<void>, intervalMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      await tick();
    } catch {
      // A tool that is mid-write or gone is simply asked again next time.
    }
    if (!stopped) {
      timer = setTimeout(() => void run(), intervalMs);
      timer.unref?.();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

/** Compares two paths the way Windows does: case and separators ignored. */
export function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** A number at a field of a record, or undefined. */
export function numberField(value: unknown, ...path: string[]): number | undefined {
  const found = field(value, ...path);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

/** A non-empty string at a field of a record, or undefined. */
export function stringField(value: unknown, ...path: string[]): string | undefined {
  const found = field(value, ...path);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

/** The value at a path of nested records, or undefined. */
export function field(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
}
