import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@ai-workbench/shared";
import { MockProviderAdapter } from "../adapter.js";

const context = {
  config: {
    id: "mock",
    adapterId: "mock",
    transport: "in-process" as const,
    authType: "none" as const,
  },
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => context.logger,
  },
  stateDirectory: "/tmp/mock-provider",
};

async function createAdapter(): Promise<MockProviderAdapter> {
  const adapter = new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 });
  await adapter.initialize(context);
  return adapter;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("MockProvider", () => {
  it("reports installation, capabilities and models", async () => {
    const adapter = await createAdapter();

    expect((await adapter.detectInstallation()).state).toBe("installed");
    expect((await adapter.getCapabilities()).supported).toContain("streaming");
    expect((await adapter.listModels()).length).toBeGreaterThan(0);
  });

  it("streams deltas and finishes with usage", async () => {
    const adapter = await createAdapter();
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
    });

    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: info.providerSessionId },
        { text: "hello" },
      ),
    );

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(1);

    const text = deltas.map((event) => ("text" in event ? event.text : "")).join("");
    expect(text).toContain("hello");

    expect(events.at(-1)).toEqual({ type: "completed", reason: "finished" });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });

  it("falls back to the default model when an unknown one is requested", async () => {
    const adapter = await createAdapter();
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
      modelId: "does-not-exist",
    });
    expect(info.modelId).toBe("mock-standard");
  });

  it("emits a normalized error instead of throwing", async () => {
    const adapter = await createAdapter();
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
    });

    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: info.providerSessionId },
        { text: "please /error now" },
      ),
    );

    const error = events.find((event) => event.type === "error");
    expect(error).toBeDefined();
    expect(events.at(-1)).toEqual({ type: "completed", reason: "failed" });
  });

  it("emits a tool call and its result", async () => {
    const adapter = await createAdapter();
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
    });

    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: info.providerSessionId },
        { text: "run /tool" },
      ),
    );

    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    const result = events.find((event) => event.type === "tool_result");
    expect(result && "toolCall" in result ? result.toolCall.state : null).toBe(
      "completed",
    );
  });

  it("stops streaming when cancelled", async () => {
    const adapter = new MockProviderAdapter({ chunkDelayMs: 5, startupDelayMs: 5 });
    await adapter.initialize(context);
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
    });
    const handle = { sessionId: "s1", providerSessionId: info.providerSessionId };

    const events: ProviderEvent[] = [];
    for await (const event of adapter.sendMessage(handle, { text: "long answer" })) {
      events.push(event);
      if (events.filter((entry) => entry.type === "text_delta").length === 2) {
        await adapter.cancel(handle);
      }
    }

    expect(events.at(-1)).toEqual({ type: "completed", reason: "cancelled" });
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.length).toBeLessThan(20);
  });

  it("resumes a provider session the process has never seen", async () => {
    const adapter = await createAdapter();
    const resumed = await adapter.resumeSession("mock-restored", {
      sessionId: "s1",
      workingDirectory: "/tmp",
    });

    expect(resumed.providerSessionId).toBe("mock-restored");
    expect(resumed.resumable).toBe(true);

    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "mock-restored" },
        { text: "still here?" },
      ),
    );
    expect(events.at(-1)).toEqual({ type: "completed", reason: "finished" });
  });

  it("reports context information that grows with the conversation", async () => {
    const adapter = await createAdapter();
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
    });
    const handle = { sessionId: "s1", providerSessionId: info.providerSessionId };

    const first = await collect(adapter.sendMessage(handle, { text: "hello" }));
    const firstUsage = first.find((event) => event.type === "usage");
    const firstContext =
      firstUsage && "usage" in firstUsage ? firstUsage.usage.contextTokens : 0;

    expect(firstContext).toBeGreaterThan(0);
    expect(
      firstUsage && "usage" in firstUsage ? firstUsage.usage.contextWindow : 0,
    ).toBe(200_000);

    const second = await collect(adapter.sendMessage(handle, { text: "and again" }));
    const secondUsage = second.find((event) => event.type === "usage");
    const secondContext =
      secondUsage && "usage" in secondUsage ? secondUsage.usage.contextTokens : 0;

    // Context accumulates across turns rather than being reported per turn.
    expect(secondContext).toBeGreaterThan(firstContext ?? 0);
  });

  it("counts usage against its own quota", async () => {
    const adapter = await createAdapter();
    const before = await adapter.getUsage();
    expect(before.state).toBe("available");
    const usedBefore = before.limits[0]?.used ?? 0;

    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: "/tmp",
    });
    await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: info.providerSessionId },
        { text: "hi" },
      ),
    );

    const after = await adapter.getUsage();
    expect(after.limits[0]?.used).toBe(usedBefore + 1);
  });
  it("reaches the limit of the account a prompt names, and only from the new message", async () => {
    const adapter = await createAdapter();
    const info = await adapter.createSession({ sessionId: "limit", workingDirectory: "/tmp" });
    const handle = { sessionId: "limit", providerSessionId: info.providerSessionId };

    const limited = await collect(adapter.sendMessage(handle, { text: "/limit@mock hello" }));
    const error = limited.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.kind).toBe("rateLimit");
    expect(error?.type === "error" && error.error.resetsAt).toBeInstanceOf(Date);

    // Another entry's limit, and a limit only mentioned in a handed-over
    // conversation, leave this one answering.
    const other = await collect(adapter.sendMessage(handle, { text: "/limit@mock@spare hello" }));
    expect(other.some((event) => event.type === "error")).toBe(false);
    const handedOver = await collect(
      adapter.sendMessage(handle, {
        text: [
          "<conversation-so-far>",
          "[person]\n/limit@mock",
          "[assistant]\nGiven so far: <conversation-so-far>[person] hi</conversation-so-far> /limit@mock",
          "</conversation-so-far>",
          "",
          "/recall",
        ].join("\n"),
      }),
    );
    expect(handedOver.some((event) => event.type === "error")).toBe(false);
    const recalled = handedOver
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.text : ""))
      .join("");
    expect(recalled).toContain("/limit@mock@spare hello");
  });
});
