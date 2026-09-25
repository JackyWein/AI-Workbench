import { describe, expect, it } from "vitest";
import type { ProviderSummary } from "@ai-workbench/shared";
import { usageAccounts, usageSourceLabel } from "../usage.js";

function provider(
  id: string,
  fields: Partial<ProviderSummary> & { readonly transport?: string; readonly reportsUsage?: boolean } = {},
): ProviderSummary {
  const { transport = "cli", reportsUsage = true, ...rest } = fields;
  return {
    metadata: { id, displayName: id, adapterVersion: "1", authMethods: ["none"], transportTypes: [transport] },
    enabled: true,
    installation: { state: "installed" },
    auth: { state: "authenticated", method: "cli" },
    capabilities: { supported: reportsUsage ? ["chat", "usage"] : ["chat"] },
    models: [],
    ...rest,
  } as unknown as ProviderSummary;
}

describe("the accounts the Usage screen lists", () => {
  it("lists a tool that reports no usage, marked as such, instead of leaving it out", () => {
    const listed = usageAccounts([provider("reports"), provider("silent", { reportsUsage: false })], false);
    expect(listed.map(({ provider: entry, reports }) => [entry.metadata.id, reports])).toEqual([
      ["reports", true],
      ["silent", false],
    ]);
  });

  it("leaves out tools that are off or not installed", () => {
    const listed = usageAccounts(
      [
        provider("off", { enabled: false }),
        provider("missing", { installation: { state: "notInstalled" } }),
        provider("ready"),
      ],
      false,
    );
    expect(listed.map(({ provider: entry }) => entry.metadata.id)).toEqual(["ready"]);
  });

  it("shows the simulated provider only in developer mode", () => {
    const tools = [provider("mock", { transport: "in-process" }), provider("real")];
    expect(usageAccounts(tools, false).map(({ provider: entry }) => entry.metadata.id)).toEqual(["real"]);
    expect(usageAccounts(tools, true).map(({ provider: entry }) => entry.metadata.id)).toEqual(["mock", "real"]);
  });

  it("says where each report came from", () => {
    expect(usageSourceLabel("provider")).toBe("Reported by the tool");
    expect(usageSourceLabel("cli")).toBe("Read from the tool's command");
    expect(usageSourceLabel("api")).toBe("From the provider's service");
    expect(usageSourceLabel("estimated")).toBe("Estimated");
  });
});
