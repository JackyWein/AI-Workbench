import { describe, expect, it } from "vitest";
import { ProviderError, ProviderRegistry } from "@ai-workbench/provider-base";
import type { Logger, ProviderEvent, StoredProviderConfig } from "@ai-workbench/shared";
import { createOpenAiCompatibleAdapter, mergeModels } from "../adapter.js";
import {
  createCustomProfile,
  formatCustomModels,
  normalizeBaseUrl,
  parseCustomModels,
  parseOpenAiCompatibleProfile,
  slugifyCustomProviderId,
} from "../profile.js";
import { registerCustomProviders } from "../registration.js";
import {
  OpenAiCompatibleTransport,
  parseServerSentEvents,
  redactEndpoint,
  type FetchFn,
} from "../transport.js";

function testLogger(
  recorded: Array<{ message: string; fields?: Record<string, unknown> }> = [],
): Logger {
  const logger: Logger = {
    debug: (message, fields) => {
      recorded.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    info: (message, fields) => {
      recorded.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    warn: (message, fields) => {
      recorded.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    error: (message, fields) => {
      recorded.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    child: () => logger,
  };
  return logger;
}

function sseResponse(body: string, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-line on purpose: parsing must work across chunk borders.
        for (const size of [11, 7, 29, 5]) {
          if (body.length === 0) {
            break;
          }
          controller.enqueue(encoder.encode(body.slice(0, size)));
          body = body.slice(size);
        }
        if (body.length > 0) {
          controller.enqueue(encoder.encode(body));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream", ...headers } },
  );
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const profileInput = {
  schemaVersion: 1 as const,
  id: "custom-demo",
  displayName: "Demo",
  baseUrl: "http://localhost:11434/v1",
  models: [{ id: "test-model", displayName: "Test Model", isDefault: true }],
};

describe("openai-compatible profile", () => {
  it("parses a valid profile with defaults", () => {
    const profile = parseOpenAiCompatibleProfile(profileInput);
    expect(profile.schemaVersion).toBe(1);
    expect(profile.timeoutMs).toBe(120_000);
    expect(profile.models).toHaveLength(1);
  });

  it("rejects a missing schema version, a wrong one and a bad URL", () => {
    expect(() => parseOpenAiCompatibleProfile({ ...profileInput, schemaVersion: undefined })).toThrow();
    expect(() => parseOpenAiCompatibleProfile({ ...profileInput, schemaVersion: 2 })).toThrow();
    expect(() =>
      parseOpenAiCompatibleProfile({ ...profileInput, baseUrl: "not a url" }),
    ).toThrow();
    expect(() => parseOpenAiCompatibleProfile({ ...profileInput, id: "" })).toThrow();
  });

  it("slugifies names and normalizes base URLs", () => {
    expect(slugifyCustomProviderId("My Local LLM!")).toBe("custom-my-local-llm");
    expect(normalizeBaseUrl("http://localhost:11434/v1///")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("ftp://example.com")).toBeNull();
    expect(normalizeBaseUrl("  ")).toBeNull();
  });

  it("builds a custom profile from form fields", () => {
    const profile = createCustomProfile({
      displayName: "  Local Llama ",
      baseUrl: "http://localhost:11434/v1/",
      models: parseCustomModels("llama = Llama\nqwen"),
    });
    expect(profile.id).toBe("custom-local-llama");
    expect(profile.baseUrl).toBe("http://localhost:11434/v1");
    expect(profile.models[0]).toMatchObject({ id: "llama", isDefault: true });
    expect(profile.defaultModel).toBe("llama");
  });

  it("refuses an unusable form with a readable message", () => {
    expect(() =>
      createCustomProfile({ displayName: "", baseUrl: "http://x/v1", models: [] }),
    ).toThrow("name");
    expect(() =>
      createCustomProfile({
        displayName: "X",
        baseUrl: "notaurl",
        models: [{ id: "m", displayName: "M" }],
      }),
    ).toThrow("base URL");
    expect(() =>
      createCustomProfile({ displayName: "X", baseUrl: "http://x/v1", models: [] }),
    ).toThrow("model");
  });

  it("round-trips models through the one-per-line format", () => {
    const models = parseCustomModels("gpt-5 = GPT 5\nmini");
    expect(formatCustomModels(models)).toBe("gpt-5 = GPT 5\nmini");
    expect(models[0]).toMatchObject({ id: "gpt-5", displayName: "GPT 5", isDefault: true });
    expect(models[1]).toMatchObject({ id: "mini", displayName: "mini" });
  });
});

describe("endpoint redaction", () => {
  it("keeps origin and path, drops everything else", () => {
    expect(redactEndpoint("https://user:pass@example.com:8080/v1/models?key=secret#frag")).toBe(
      "https://example.com:8080/v1/models",
    );
    expect(redactEndpoint("garbage")).toBe("unparseable-endpoint");
  });
});

describe("server-sent events", () => {
  it("parses chunks split mid-line, skips comments and stops at [DONE]", async () => {
    const body = sseResponse(
      ': ping\n\ndata: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    );
    const events: unknown[] = [];
    for await (const event of parseServerSentEvents(body.body!)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ choices: [{ delta: { content: "Hel" } }] });
    expect(events[1]).toMatchObject({ choices: [{ delta: { content: "lo" } }] });
  });
});

describe("openai-compatible transport", () => {
  it("lists models with an authorization header", async () => {
    let seenAuth: string | null = null;
    const fetchFn: FetchFn = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const transport = new OpenAiCompatibleTransport({
      baseUrl: "http://localhost:11434/v1/",
      apiKey: "sk-test",
      fetchFn,
      logger: testLogger(),
    });
    await expect(transport.listModels()).resolves.toEqual(["a", "b"]);
    expect(seenAuth).toBe("Bearer sk-test");
  });

  it("maps failures to normalized error kinds", async () => {
    const status = (code: number): FetchFn => async () =>
      new Response(JSON.stringify({ error: { message: `refused ${code}` } }), { status: code });
    for (const [code, kind] of [
      [401, "authentication"],
      [403, "authentication"],
      [429, "rateLimit"],
      [500, "provider"],
    ] as const) {
      const transport = new OpenAiCompatibleTransport({ baseUrl: "http://x/v1", fetchFn: status(code) });
      const error = await transport.listModels().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(kind);
    }
    const unreachable: FetchFn = async () => {
      throw new Error("socket hang up");
    };
    const unreachableError = await new OpenAiCompatibleTransport({
      baseUrl: "http://x/v1",
      fetchFn: unreachable,
    })
      .listModels()
      .catch((cause: unknown) => cause);
    expect((unreachableError as ProviderError).kind).toBe("transport");
  });

  it("times out instead of hanging", async () => {
    const hanging: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const reason = init.signal?.reason;
            const error = new Error("timed out");
            error.name = reason instanceof Error ? reason.name : "TimeoutError";
            reject(error);
          },
          { once: true },
        );
      });
    const transport = new OpenAiCompatibleTransport({
      baseUrl: "http://x/v1",
      timeoutMs: 50,
      fetchFn: hanging,
    });
    const error = await transport.listModels().catch((cause: unknown) => cause);
    expect((error as ProviderError).kind).toBe("timeout");
  });

  it("never logs the secret", async () => {
    const apiKey = "sk-live-SECRET-abcdef";
    const recorded: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const fetchFn: FetchFn = async (url) =>
      String(url).endsWith("/models")
        ? new Response(JSON.stringify({ data: [] }), {
            headers: { "content-type": "application/json" },
          })
        : sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    const transport = new OpenAiCompatibleTransport({
      baseUrl: "http://localhost:11434/v1",
      apiKey,
      fetchFn,
      logger: testLogger(recorded),
    });
    await transport.listModels();
    await transport.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(JSON.stringify(recorded)).not.toContain(apiKey);
  });
});

describe("openai-compatible adapter", () => {
  const router: FetchFn = async (input, _init) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/chat/completions")) {
      return sseResponse(
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
          "data: [DONE]\n\n",
        { "x-ratelimit-remaining-requests": "99", "x-ratelimit-limit-requests": "100" },
      );
    }
    return new Response("not found", { status: 404 });
  };

  async function boot() {
    const logger = testLogger();
    const adapter = createOpenAiCompatibleAdapter(profileInput, { fetchFn: router });
    const context = {
      config: {
        id: "custom-demo",
        adapterId: "custom-demo",
        transport: "openai-compatible" as const,
        authType: "none" as const,
      },
      logger,
      stateDirectory: "",
    };
    await adapter.initialize(context);
    return adapter;
  }

  it("streams an answer and reports usage from body and headers", async () => {
    const adapter = await boot();
    expect((await adapter.detectInstallation()).state).toBe("installed");
    expect(await adapter.getAuthenticationStatus()).toMatchObject({ state: "notApplicable" });

    const session = await adapter.createSession({ sessionId: "s1", workingDirectory: "/tmp" });
    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: session.providerSessionId, modelId: "test-model" },
        { text: "hi" },
      ),
    );
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.text : ""))
      .join("");
    expect(text).toBe("Hello");
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(events[events.length - 1]).toMatchObject({ type: "completed", reason: "finished" });

    const snapshot = await adapter.getUsage();
    expect(snapshot.state).toBe("available");
    expect(snapshot.limits).toMatchObject([{ id: "requests", remaining: 99, total: 100 }]);
    await adapter.dispose();
  });

  it("keeps conversation context across turns of one session", async () => {
    const seen: string[] = [];
    const spy: FetchFn = async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        seen.push(String(init?.body));
      }
      return router(input, init);
    };
    const adapter = createOpenAiCompatibleAdapter(profileInput, { fetchFn: spy });
    await adapter.initialize({
      config: {
        id: "custom-demo",
        adapterId: "custom-demo",
        transport: "openai-compatible",
        authType: "none",
      },
      logger: testLogger(),
      stateDirectory: "",
    });
    const session = await adapter.createSession({ sessionId: "s2", workingDirectory: "/tmp" });
    const handle = { sessionId: "s2", providerSessionId: session.providerSessionId, modelId: "test-model" };
    await collect(adapter.sendMessage(handle, { text: "first" }));
    await adapter.resumeSession(session.providerSessionId, {
      sessionId: "s2",
      workingDirectory: "/tmp",
    });
    await collect(adapter.sendMessage(handle, { text: "second" }));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("first");
    expect(seen[1]).toContain("Hello");
    await adapter.dispose();
  });

  it("reports a missing base URL as a failed turn, not a crash", async () => {
    const adapter = createOpenAiCompatibleAdapter(profileInput, { fetchFn: router });
    await adapter.initialize({
      config: {
        id: "custom-demo",
        adapterId: "custom-demo",
        transport: "openai-compatible",
        authType: "none",
        baseUrl: "",
      },
      logger: testLogger(),
      stateDirectory: "",
    });
    const events = await collect(
      adapter.sendMessage({ sessionId: "s3", providerSessionId: "oac:s3" }, { text: "hi" }),
    );
    expect(events[0]).toMatchObject({ type: "error", error: { kind: "transport" } });
    expect(events[events.length - 1]).toMatchObject({ type: "completed", reason: "failed" });
    await adapter.dispose();
  });

  it("merges user, server and profile models with one default", () => {
    const merged = mergeModels(
      [{ id: "user-model", displayName: "Mine" }],
      [{ id: "server-model", displayName: "server-model" }],
      [{ id: "profile-model", displayName: "Profile", isDefault: true }],
    );
    expect(merged.map((model) => model.id)).toEqual(["user-model", "server-model", "profile-model"]);
    // The explicitly marked default wins; priority only orders the list.
    expect(merged.filter((model) => model.isDefault)).toHaveLength(1);
    expect(merged[2]).toMatchObject({ id: "profile-model", isDefault: true });
    expect(merged[0]).toMatchObject({ id: "user-model", isDefault: false });
  });
});

describe("custom provider registration", () => {
  const storedCustom: StoredProviderConfig = {
    providerId: "custom-demo",
    enabled: true,
    executablePath: null,
    arguments: [],
    baseUrl: "http://localhost:11434/v1",
    credentialReference: null,
    defaultModel: "test-model",
    settings: {
      openaiCompatible: { schemaVersion: 1, displayName: "Demo" },
      models: [{ id: "test-model", displayName: "Test Model", isDefault: true }],
    },
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const storedCli: StoredProviderConfig = {
    providerId: "claude-code",
    enabled: true,
    executablePath: null,
    arguments: [],
    baseUrl: null,
    credentialReference: null,
    defaultModel: null,
    // User models alone must never mark a CLI entry as a custom provider.
    settings: { models: [{ id: "opus", displayName: "Opus" }] },
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("registers customs from stored configs without core edits", async () => {
    const registry = new ProviderRegistry({ logger: testLogger() });
    const first = registerCustomProviders(registry, [storedCustom, storedCli]);
    expect(first.registered).toEqual(["custom-demo"]);
    expect(first.rejected).toEqual([]);

    const summaries = await registry.describeAll();
    expect(summaries.map((summary) => summary.metadata.id)).toEqual(["custom-demo"]);
    expect(summaries[0]?.metadata.transportTypes).toContain("openai-compatible");

    const second = registerCustomProviders(registry, [storedCustom, storedCli]);
    expect(second.registered).toEqual([]);
    expect(second.skipped).toEqual(["custom-demo"]);
  });

  it("rejects a custom entry without a base URL instead of guessing one", () => {
    const registry = new ProviderRegistry({ logger: testLogger() });
    const broken: StoredProviderConfig = {
      ...storedCustom,
      providerId: "custom-broken",
      baseUrl: null,
      settings: { openaiCompatible: { schemaVersion: 1 } },
    };
    const result = registerCustomProviders(registry, [broken]);
    expect(result.registered).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.providerId).toBe("custom-broken");
  });
});
