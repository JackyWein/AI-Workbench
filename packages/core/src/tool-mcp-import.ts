import { createHash } from "node:crypto";
import type { ImportableMcpServer } from "@ai-workbench/provider-base";
import type {
  DiscoveredMcpServer,
  McpServerConfig,
  McpServerSaveInput,
} from "@ai-workbench/shared";
import type { ProviderManager } from "./provider-manager.js";

/** One MCP server a tool has, with the tool it came from. Main process only. */
export interface ToolMcpFinding {
  readonly key: string;
  readonly server: ImportableMcpServer;
  readonly providerId: string;
  readonly providerName: string;
}

/** Variable and header names that carry secrets by the look of them. */
const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential|cookie|session)/i;
/** Arguments whose next value is a secret, e.g. `--api-key abc`. */
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|password|auth)[\w-]*$/i;

/**
 * Every MCP server the registered tools are configured with (spec §31, §37),
 * asked of each tool's own adapter. The same server kept by two tools — or by
 * two accounts of one — is offered once, under the first tool that has it.
 */
export async function discoverToolMcpServers(
  providers: ProviderManager,
  workspacePath: string | undefined,
): Promise<ToolMcpFinding[]> {
  const found = new Map<string, ToolMcpFinding>();
  for (const summary of await providers.describeAll()) {
    const adapter = providers.get(summary.metadata.id);
    if (!adapter?.discoverImportables) {
      continue;
    }
    const importables = await adapter
      .discoverImportables(workspacePath ? { workspacePath } : {})
      .catch(() => ({ skills: [], mcpServers: [] }));
    for (const server of importables.mcpServers) {
      const name = server.name.trim().toLowerCase();
      if (found.has(name)) {
        continue;
      }
      found.set(name, {
        key: findingKey(summary.metadata.id, server),
        server,
        providerId: summary.metadata.id,
        providerName: summary.metadata.displayName,
      });
    }
  }
  return [...found.values()];
}

/** What the window may see of a finding: names of secrets, never their values. */
export function describeFinding(
  finding: ToolMcpFinding,
  existing: readonly McpServerConfig[],
): DiscoveredMcpServer {
  const { server } = finding;
  const names = new Set(existing.map((config) => config.name.trim().toLowerCase()));
  const ids = new Set(existing.map((config) => config.id));
  return {
    key: finding.key,
    name: server.name,
    source: server.source,
    providerId: finding.providerId,
    providerName: finding.providerName,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    args: redactArgs(server.args),
    ...(server.url ? { url: server.url } : {}),
    secretNames: [
      ...Object.keys(server.env).filter((name) => SECRET_NAME.test(name)),
      ...Object.keys(server.headers),
    ],
    imported: names.has(server.name.trim().toLowerCase()) || ids.has(serverId(server.name)),
  };
}

/**
 * The server as the application saves it. A remote server's key header
 * becomes a stored key (encrypted by the credential store on save); an
 * environment variable that holds a secret is not carried over in plain text
 * — it is named in the notes so the person can set it, rather than silently
 * written to the database.
 */
export function toSaveInput(
  finding: ToolMcpFinding,
  takenIds: ReadonlySet<string>,
): { input: McpServerSaveInput; notes: string[] } {
  const { server } = finding;
  const notes: string[] = [];
  const id = uniqueId(serverId(server.name), takenIds);

  if (server.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.env)) {
      if (SECRET_NAME.test(name)) {
        notes.push(`${name} holds a secret and was not copied; set it in the server's settings.`);
      } else {
        env[name] = value;
      }
    }
    return {
      input: {
        id,
        name: server.name,
        transport: "stdio",
        ...(server.command ? { command: server.command } : {}),
        args: [...server.args],
        env,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        enabled: true,
        availability: "everywhere",
      },
      notes,
    };
  }

  const headers = Object.entries(server.headers);
  const key =
    headers.find(([name]) => name.toLowerCase() === "authorization") ?? headers[0];
  for (const [name] of headers) {
    if (name !== key?.[0]) {
      notes.push(`The header ${name} was not copied; only one key header can be kept.`);
    }
  }
  return {
    input: {
      id,
      name: server.name,
      transport: server.transport,
      ...(server.url ? { url: server.url } : {}),
      args: [],
      env: {},
      enabled: true,
      availability: "everywhere",
      ...(key
        ? {
            apiKey: key[1],
            ...(key[0].toLowerCase() === "authorization" ? {} : { apiKeyHeader: key[0] }),
          }
        : {}),
    },
    notes,
  };
}

/** A server id from its name: lowercase letters, digits and hyphens. */
export function serverId(name: string): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return value.length > 0 ? value : "server";
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    if (!taken.has(`${base}-${index}`)) {
      return `${base}-${index}`;
    }
  }
}

/** A stable key for one finding, the same between discovering and importing. */
function findingKey(providerId: string, server: ImportableMcpServer): string {
  return createHash("sha256")
    .update([providerId, server.source, server.name, server.command ?? "", server.url ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

function redactArgs(args: readonly string[]): string[] {
  const shown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const inline = /^(--?[\w-]*(?:key|token|secret|password|auth)[\w-]*)=/i.exec(arg);
    if (inline) {
      shown.push(`${inline[1]}=••••`);
      continue;
    }
    shown.push(arg);
    if (SECRET_FLAG.test(arg) && index + 1 < args.length) {
      shown.push("••••");
      index += 1;
    }
  }
  return shown;
}
