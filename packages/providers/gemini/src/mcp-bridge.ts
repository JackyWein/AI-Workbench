/**
 * The MCP server the Gemini extension declares: a small Node script that
 * Gemini CLI starts over stdio and that passes each message to the gateway's
 * combined endpoint named in its environment. Outside AI Workbench, with no
 * endpoint named, it is an MCP server with no tools, so Gemini CLI started
 * by hand is not disturbed.
 *
 * Plain Node with no dependencies: Gemini CLI runs on Node, so it is there.
 */
export const MCP_BRIDGE_SCRIPT = String.raw`// AI Workbench: gives Gemini CLI the connectors of the session it runs in.
// Does nothing outside AI Workbench.
"use strict";
const url = process.env.AI_WORKBENCH_MCP_URL;
let session = null;
let protocol = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

async function forward(message) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  if (protocol) headers["mcp-protocol-version"] = protocol;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  const id = response.headers.get("mcp-session-id");
  if (id) session = id;
  if (response.status === 202 || message.id === undefined) return;
  const type = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok && !type.includes("json") && !type.includes("event-stream")) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "AI Workbench: " + response.status + " " + text.slice(0, 200) } });
    return;
  }
  if (type.includes("event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) send(JSON.parse(line.slice(5)));
    }
  } else if (text) {
    send(JSON.parse(text));
  }
}

function answerAlone(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params && message.params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ai-workbench", version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  } else if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not available outside AI Workbench" } });
  }
}

let pending = 0;
let ended = false;
const settle = () => { if (ended && pending === 0) process.exit(0); };
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize" && message.params) protocol = message.params.protocolVersion || null;
    if (!url) { answerAlone(message); continue; }
    pending += 1;
    forward(message).catch((error) => {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "AI Workbench is not reachable: " + error.message } });
    }).finally(() => { pending -= 1; settle(); });
  }
});
// Answers still on their way are written before the bridge ends.
process.stdin.on("end", () => { ended = true; settle(); });
`;
