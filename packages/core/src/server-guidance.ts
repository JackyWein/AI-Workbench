import type { ProviderToolAccess } from "@ai-workbench/provider-base";

/** What connected MCP servers say about how to use them, by server id. */
export type ServerInstructionsLookup = (
  serverIds: readonly string[],
) => ReadonlyArray<{ readonly serverId: string; readonly instructions: string }>;

/**
 * Adds the usage instructions of the MCP servers a session may use to its
 * own instructions.
 *
 * MCP carries them in the server's initialize answer, but not every tool
 * shows them to its model; a server whose tools are there without any word on
 * when to use them — the shared memory above all — then simply goes unused.
 * Writing them into the session's instructions reaches every tool the same
 * way, whatever it does with the protocol field. Provider-independent: it
 * only reads what the servers themselves said.
 */
export function withServerGuidance(
  base: string | undefined,
  access: ProviderToolAccess | null | undefined,
  lookup: ServerInstructionsLookup | undefined,
): string | undefined {
  if (!access || !lookup || access.mcpServers.length === 0) {
    return base;
  }
  const names = new Map(access.mcpServers.map((server) => [server.id, server.name]));
  let found: ReadonlyArray<{ readonly serverId: string; readonly instructions: string }> = [];
  try {
    found = lookup([...names.keys()]);
  } catch {
    return base;
  }
  if (found.length === 0) {
    return base;
  }
  const guidance = [
    "CONNECTED TOOLS",
    ...found.map((entry) => `${names.get(entry.serverId) ?? entry.serverId}: ${entry.instructions}`),
  ].join("\n");
  return base && base.trim().length > 0 ? `${base}\n\n${guidance}` : guidance;
}
