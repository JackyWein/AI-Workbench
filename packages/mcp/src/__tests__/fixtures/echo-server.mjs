#!/usr/bin/env node
// Test fixture: a minimal MCP server over stdio, so the manager can be verified
// against a real protocol implementation rather than a stub.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-server", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Returns the text it was given",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);

server.registerTool(
  "add",
  {
    description: "Adds two numbers",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "explode",
  { description: "Always fails", inputSchema: {} },
  async () => {
    throw new Error("tool exploded");
  },
);

await server.connect(new StdioServerTransport());
