import type { McpServerConfig, McpServerStatus, McpTool } from "@ai-workbench/shared";
import type { ProviderCapabilities } from "@ai-workbench/shared";

/**
 * How tools reach a provider (spec §36).
 *
 * The core asks which bridge is available for a session, never which provider
 * brand is in use: a provider that speaks MCP is told about the servers, one
 * that only has tool calls gets host-executed tools, and one with neither is
 * honestly given nothing.
 */
export type ToolBridgeKind = "provider-mcp" | "host-mediated" | "none";

export interface HostTool {
  readonly serverId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolBridgePlan {
  readonly kind: ToolBridgeKind;
  /** Servers the provider should connect to itself. */
  readonly mcpServers: McpServerConfig[];
  /** Tools the application executes on the provider's behalf. */
  readonly hostTools: HostTool[];
  /** Servers that are enabled but not usable, with the reason. */
  readonly unavailable: Array<{ id: string; reason: string }>;
  readonly reason: string;
}

export interface ToolBridgeInput {
  readonly capabilities: ProviderCapabilities;
  /** Servers the session is allowed to use (spec §38). */
  readonly enabledServerIds: readonly string[];
  readonly configs: readonly McpServerConfig[];
  readonly statuses: readonly McpServerStatus[];
  readonly toolsFor: (serverIds: readonly string[]) => Array<McpTool & { serverId: string }>;
}

export class ToolBridge {
  /** Works out the bridge for one session, without naming any provider. */
  plan(input: ToolBridgeInput): ToolBridgePlan {
    const byId = new Map(input.configs.map((config) => [config.id, config]));
    const statusById = new Map(input.statuses.map((status) => [status.id, status]));

    const usable: McpServerConfig[] = [];
    const unavailable: Array<{ id: string; reason: string }> = [];

    for (const id of input.enabledServerIds) {
      const config = byId.get(id);
      if (!config) {
        unavailable.push({ id, reason: "The server is no longer configured" });
        continue;
      }
      if (!config.enabled) {
        unavailable.push({ id, reason: "The server is switched off" });
        continue;
      }
      const status = statusById.get(id);
      if (status && status.state !== "connected") {
        unavailable.push({
          id,
          reason: status.detail ?? `The server is ${status.state}`,
        });
        continue;
      }
      usable.push(config);
    }

    if (usable.length === 0) {
      return {
        kind: "none",
        mcpServers: [],
        hostTools: [],
        unavailable,
        reason: "No usable MCP server is enabled for this session",
      };
    }

    const supports = (capability: ProviderCapabilities["supported"][number]): boolean =>
      input.capabilities.supported.includes(capability);

    if (supports("mcp")) {
      return {
        kind: "provider-mcp",
        mcpServers: usable,
        hostTools: [],
        unavailable,
        reason: "The provider connects to MCP servers itself",
      };
    }

    if (supports("toolCalls") || supports("nativeTools")) {
      const hostTools = input
        .toolsFor(usable.map((config) => config.id))
        .map((tool) => ({
          serverId: tool.serverId,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));

      return {
        kind: "host-mediated",
        mcpServers: [],
        hostTools,
        unavailable,
        reason: "The application executes MCP tools for the provider",
      };
    }

    return {
      kind: "none",
      mcpServers: [],
      hostTools: [],
      unavailable,
      reason: "The provider cannot use tools",
    };
  }
}
