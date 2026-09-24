import { describe, expect, it } from "vitest";
import type { ProviderToolAccess } from "@ai-workbench/provider-base";
import { withServerGuidance } from "../server-guidance.js";

const access: ProviderToolAccess = {
  kind: "provider-mcp",
  mcpServers: [
    { id: "obsidian-memory", name: "Obsidian memory", transport: "stdio" },
    { id: "files", name: "Files", transport: "stdio" },
  ],
  hostTools: [],
};

const lookup = (ids: readonly string[]) =>
  ids.includes("obsidian-memory")
    ? [{ serverId: "obsidian-memory", instructions: "Search the memory before you start." }]
    : [];

describe("guidance from connected servers", () => {
  it("adds what a server says about using it after the session's own instructions", () => {
    expect(withServerGuidance("Use the project's style.", access, lookup)).toBe(
      "Use the project's style.\n\nCONNECTED TOOLS\nObsidian memory: Search the memory before you start.",
    );
  });

  it("gives a session without skills the guidance alone", () => {
    expect(withServerGuidance(undefined, access, lookup)).toBe(
      "CONNECTED TOOLS\nObsidian memory: Search the memory before you start.",
    );
  });

  it("leaves the instructions alone when no server says anything or none is connected", () => {
    expect(withServerGuidance("Base", access, () => [])).toBe("Base");
    expect(withServerGuidance("Base", null, lookup)).toBe("Base");
    expect(withServerGuidance("Base", access, undefined)).toBe("Base");
    expect(
      withServerGuidance("Base", access, () => {
        throw new Error("gone");
      }),
    ).toBe("Base");
  });
});
