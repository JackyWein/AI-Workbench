import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpGateway } from "../gateway.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

describe("the combined gateway endpoint", () => {
  let gateway: McpGateway | null = null;
  afterEach(async () => {
    await gateway?.stop();
    gateway = null;
  });

  it("passes on what each server says about using it", async () => {
    gateway = new McpGateway({
      logger: nullLogger,
      route: async () => null,
      tools: {
        list: (ids) =>
          ids.map((serverId) => ({
            serverId,
            name: "search",
            description: "Search",
            inputSchema: {},
          })),
        call: async () => ({ content: [] }),
        instructions: (ids) =>
          ids.includes("memory")
            ? [{ serverId: "memory", instructions: "Search the memory before you start." }]
            : [],
      },
    });
    await gateway.start();

    const endpoint = gateway.endpointForAll(["memory", "other"]);
    const client = new Client({ name: "check", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
    try {
      expect(client.getInstructions()).toBe(
        "Tools named memory__*: Search the memory before you start.",
      );
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "memory__search",
        "other__search",
      ]);
    } finally {
      await client.close();
    }
  });
});
