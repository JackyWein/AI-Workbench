import { describe, expect, it } from "vitest";
import { CODEX_HOOK_EVENTS, codexDialect, codexHookArgs } from "../attention.js";

describe("Codex hooks", () => {
  it("adds one hook per event as a session override, only the permission hook in order", () => {
    const args = codexHookArgs((event) => `/bin/sh '/state/hook-bridge.sh' ${event} observe`);
    expect(args.filter((arg) => arg === "-c")).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(args).toContain(
      `hooks.PermissionRequest=[{matcher="",hooks=[{type="command",command="/bin/sh '/state/hook-bridge.sh' PermissionRequest observe",timeout=30}]}]`,
    );
    expect(args).toContain(
      `hooks.Stop=[{matcher="",hooks=[{type="command",command="/bin/sh '/state/hook-bridge.sh' Stop observe",async=true}]}]`,
    );
  });

  it("writes Windows paths and quotes as valid TOML", () => {
    const [, override] = codexHookArgs(
      () => 'powershell -File "C:\\Users\\me\\hook.ps1" "Stop" "observe"',
    );
    expect(override).toContain('command="powershell -File \\"C:\\\\Users\\\\me\\\\hook.ps1\\" \\"Stop\\" \\"observe\\""');
  });

  it("answers a command with the keys of Codex's own dialog, and nothing else", () => {
    const attention = codexDialect.describe("1", "Bash", { command: "touch x" }, new Date(0));
    expect(attention).toMatchObject({ kind: "permission", summary: "touch x", answerable: true });
    const request = { attention, tool: "Bash", input: { command: "touch x" } };
    expect(codexDialect.answer(request, { decision: "allow" })).toBe("y");
    expect(codexDialect.answer(request, { decision: "deny" })).toBe("\u001b");
    expect(codexDialect.answer(request, { choice: "0" })).toBeNull();
    // Only the command dialog was measured; anything else is answered in the tile.
    expect(codexDialect.describe("2", "mcp__server__tool", {}, new Date(0)).answerable).toBe(false);
  });
});
