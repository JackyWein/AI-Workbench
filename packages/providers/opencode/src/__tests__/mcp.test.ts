import { describe, expect, it } from "vitest";
import { opencodeMcpLaunch } from "../mcp.js";

describe("connectors for OpenCode", () => {
  it("writes local and remote servers in OpenCode's own shape", () => {
    const launch = opencodeMcpLaunch([
      { id: "local", name: "Local", transport: "stdio", command: "npx", args: ["server"], env: { A: "1" } },
      {
        id: "signed",
        name: "Signed",
        transport: "http",
        url: "http://127.0.0.1:9/mcp/signed",
        headers: { Authorization: "Bearer gateway-key" },
      },
      { id: "open", name: "Open", transport: "http", url: "https://open.example/mcp" },
    ]);
    expect(JSON.parse(launch.env["OPENCODE_CONFIG_CONTENT"] ?? "{}")).toEqual({
      mcp: {
        local: { type: "local", command: ["npx", "server"], enabled: true, environment: { A: "1" } },
        // Reached with the gateway's key: OpenCode's own sign-in stays off.
        signed: {
          type: "remote",
          url: "http://127.0.0.1:9/mcp/signed",
          enabled: true,
          headers: { Authorization: "Bearer gateway-key" },
          oauth: false,
        },
        open: { type: "remote", url: "https://open.example/mcp", enabled: true },
      },
    });
    expect(opencodeMcpLaunch([])).toEqual({ args: [], env: {} });
  });
});
