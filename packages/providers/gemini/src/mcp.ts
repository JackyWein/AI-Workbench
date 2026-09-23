import type { ProviderToolAccess } from "@ai-workbench/provider-base";

/** What the bridge in the Gemini extension reads to reach the gateway. */
export const MCP_URL_ENV = "AI_WORKBENCH_MCP_URL";

/**
 * Gemini CLI takes MCP servers only from settings files, and its system
 * layers only from files an administrator owns — a safeguard of the tool's,
 * not one to work around. So the servers reach it through the extension this
 * application installs with Gemini CLI's own installer: it declares one MCP
 * server, a small bridge Gemini CLI starts itself, which serves the session's
 * servers from the gateway's combined endpoint named here. Gemini CLI hands
 * the servers it starts its environment minus anything named or shaped like
 * a credential; the endpoint's address is its own key, so none is needed.
 */
export function geminiMcpLaunch(
  _servers: ProviderToolAccess["mcpServers"],
  _context: unknown,
  combined?: ProviderToolAccess["combined"],
): { args: string[]; env: Record<string, string> } {
  if (!combined) {
    return { args: [], env: {} };
  }
  return { args: [], env: { [MCP_URL_ENV]: combined.url } };
}
