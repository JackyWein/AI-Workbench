import { describe, expect, it } from "vitest";
import { ipcChannels, ipcContract, isIpcChannel } from "../ipc/contract.js";
import { providerEventSchema } from "../events/provider-events.js";
import { appSettingsSchema, defaultAppSettings } from "../domain/settings.js";

describe("ipc contract", () => {
  it("declares an input and output schema for every channel", () => {
    for (const channel of ipcChannels) {
      expect(ipcContract[channel].input).toBeDefined();
      expect(ipcContract[channel].output).toBeDefined();
    }
  });

  it("recognizes only declared channels", () => {
    expect(isIpcChannel("session.sendMessage")).toBe(true);
    expect(isIpcChannel("shell.execute")).toBe(false);
  });

  it("rejects payloads that do not match the channel schema", () => {
    const schema = ipcContract["session.sendMessage"].input;
    expect(schema.safeParse({ sessionId: "s1", text: "hello" }).success).toBe(true);
    expect(schema.safeParse({ sessionId: "", text: "hello" }).success).toBe(false);
    expect(schema.safeParse({ sessionId: "s1" }).success).toBe(false);
    expect(schema.safeParse("not an object").success).toBe(false);
  });

  it("caps message length so the renderer cannot post unbounded input", () => {
    const schema = ipcContract["session.sendMessage"].input;
    const tooLong = { sessionId: "s1", text: "x".repeat(100_001) };
    expect(schema.safeParse(tooLong).success).toBe(false);
  });
});

describe("normalized provider events", () => {
  it("accepts every declared event type", () => {
    const events = [
      { type: "text_delta", text: "hi" },
      { type: "status", status: "thinking" },
      { type: "usage", usage: { limits: [] } },
      { type: "error", error: { kind: "provider", message: "no", retryable: false } },
      { type: "completed", reason: "finished" },
    ];
    for (const event of events) {
      expect(providerEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("rejects an unknown event type", () => {
    expect(providerEventSchema.safeParse({ type: "stdout", text: "raw" }).success).toBe(
      false,
    );
  });
});

describe("settings", () => {
  it("parses its own defaults", () => {
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(defaultAppSettings);
  });
});
