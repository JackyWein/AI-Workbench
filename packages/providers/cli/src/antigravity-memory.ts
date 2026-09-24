import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execCli, findExecutable } from "@ai-workbench/transport-cli";
import type { McpServerConfig } from "@ai-workbench/shared";

/** Antigravity reads its global MCP file, including for runs outside Workbench. */
const SERVER_NAME = "ai-workbench-obsidian-memory";
const OWNER_MARKER = "AI_WORKBENCH_OBSIDIAN_MEMORY";

export type AntigravityMemoryState = "configured" | "unavailable" | "conflict" | "not-configured" | "error";
export interface AntigravityMemoryStatus {
  readonly state: AntigravityMemoryState;
  readonly detail: string;
}

export interface AntigravityMemoryOptions {
  readonly executablePath?: string | null;
  readonly expectedCommand?: string;
  readonly expectedScript?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Tests replace the CLI process; output is intentionally never logged. */
  readonly run?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string }>;
}

/**
 * Antigravity has no per-run MCP flag. Its own `agy mcp add` command updates the
 * global configuration used by its CLI and IDE. Only our marked entry is ever
 * changed or removed; other servers and their credentials stay untouched.
 */
export class AntigravityMemoryBridge {
  readonly #options: AntigravityMemoryOptions;
  #updates: Promise<void> = Promise.resolve();

  constructor(options: AntigravityMemoryOptions = {}) {
    this.#options = options;
  }

  async status(server: McpServerConfig | null): Promise<AntigravityMemoryStatus> {
    if (!server?.enabled) return { state: "not-configured", detail: "Choose a vault to enable shared memory." };
    if ((this.#options.expectedCommand && !samePath(server.command, this.#options.expectedCommand)) ||
      (this.#options.expectedScript && !samePath(server.args[0], this.#options.expectedScript))) {
      return { state: "error", detail: "The shared memory connector does not use the bundled server." };
    }
    const executable = await this.#executable();
    if (!executable) return { state: "unavailable", detail: "Antigravity CLI is not installed." };
    const current = await this.#entry();
    if (current && !owned(current)) {
      return { state: "conflict", detail: "An existing Antigravity MCP server uses the Workbench memory name." };
    }
    if (!current) return { state: "not-configured", detail: "Antigravity has not registered this vault yet." };
    if (matches(current, server)) return { state: "configured", detail: "Antigravity can use the shared vault." };
    return { state: "not-configured", detail: "Antigravity's memory registration needs updating." };
  }

  async reconcile(server: McpServerConfig | null): Promise<AntigravityMemoryStatus> {
    // Startup reconciliation and a vault change may arrive together. Preserve
    // their order so an older vault can never win the final CLI configuration.
    const task = this.#updates.then(() => this.#reconcile(server));
    this.#updates = task.then(() => undefined, () => undefined);
    return task;
  }

  async #reconcile(server: McpServerConfig | null): Promise<AntigravityMemoryStatus> {
    const executable = await this.#executable();
    if (!executable) return { state: "unavailable", detail: "Antigravity CLI is not installed." };
    const current = await this.#entry();
    if (current && !owned(current)) {
      return { state: "conflict", detail: "An existing Antigravity MCP server uses the Workbench memory name." };
    }
    if (!server?.enabled) {
      if (current) await this.#command(executable, ["mcp", "remove", SERVER_NAME]);
      return { state: "not-configured", detail: "Shared memory is not configured." };
    }
    if (server.transport !== "stdio" || !server.command || server.args.length < 2 || !server.env["ELECTRON_RUN_AS_NODE"]) {
      return { state: "error", detail: "The shared memory connector is incomplete." };
    }
    if ((this.#options.expectedCommand && !samePath(server.command, this.#options.expectedCommand)) ||
      (this.#options.expectedScript && !samePath(server.args[0], this.#options.expectedScript))) {
      return { state: "error", detail: "The shared memory connector does not use the bundled server." };
    }
    if (!matches(current, server)) {
      await this.#command(executable, [
        "mcp", "add", "--env", `${OWNER_MARKER}=1`, "--env", "ELECTRON_RUN_AS_NODE=1",
        SERVER_NAME, server.command, ...server.args,
      ]);
    }
    const registered = await this.#entry();
    if (!matches(registered, server)) {
      return { state: "error", detail: "Antigravity did not save the shared memory server." };
    }
    return { state: "configured", detail: "Antigravity can use the shared vault." };
  }

  async #executable(): Promise<string | null> {
    const located = await findExecutable("agy", {
      ...(this.#options.executablePath ? { configuredPath: this.#options.executablePath } : {}),
      knownLocations: ["%LOCALAPPDATA%/agy/bin/agy.exe"],
      env: this.#options.env ?? process.env,
    });
    return located?.path ?? null;
  }

  async #command(executable: string, args: string[]): Promise<void> {
    const env = this.#options.env ?? process.env;
    const result = this.#options.run
      ? await this.#options.run(executable, args, env)
      : await execCli({ executablePath: executable, args, env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ), timeoutMs: 8_000 })
          .then(({ stdout, exit }) => ({ code: exit.code, stdout }));
    if (result.code !== 0) {
      // The tool may echo another server's credential on failure. Never include
      // its stdout/stderr in an error surfaced to the renderer or a log.
      throw new Error("Antigravity could not update its MCP configuration.");
    }
  }

  async #entry(): Promise<Record<string, unknown> | null> {
    const home = this.#options.home ?? homedir();
    // Google documents both paths for CLI releases. `agy mcp add` currently
    // writes the shared config path; checking both protects older installs.
    for (const path of [
      join(home, ".gemini", "config", "mcp_config.json"),
      join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
    ]) {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw new Error("Antigravity's MCP configuration could not be read.");
      }
      let config: unknown;
      try {
        config = JSON.parse(raw);
      } catch {
        throw new Error("Antigravity's MCP configuration is not valid JSON.");
      }
      if (!record(config) || !record(config["mcpServers"])) continue;
      const entry = config["mcpServers"][SERVER_NAME];
      if (record(entry)) return entry;
    }
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owned(entry: Record<string, unknown>): boolean {
  return record(entry["env"]) && entry["env"][OWNER_MARKER] === "1";
}

function matches(entry: Record<string, unknown> | null, server: McpServerConfig): boolean {
  return entry !== null && owned(entry) && entry["command"] === server.command &&
    Array.isArray(entry["args"]) && JSON.stringify(entry["args"]) === JSON.stringify(server.args) &&
    record(entry["env"]) && entry["env"]["ELECTRON_RUN_AS_NODE"] === "1";
}

function samePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const normalized = (value: string): string => process.platform === "win32"
    ? resolve(value).toLowerCase() : resolve(value);
  return normalized(left) === normalized(right);
}
