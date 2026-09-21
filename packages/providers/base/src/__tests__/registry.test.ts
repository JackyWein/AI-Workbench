import { describe, expect, it } from "vitest";
import type { AIProviderAdapter } from "../adapter.js";
import { ProviderRegistry } from "../registry.js";
import { ProviderError, normalizeError } from "../errors.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function stubAdapter(id: string, overrides: Partial<AIProviderAdapter> = {}): AIProviderAdapter {
  return {
    metadata: {
      id,
      displayName: id,
      adapterVersion: "1.0.0",
      authMethods: ["none"],
      transportTypes: ["in-process"],
    },
    initialize: async () => {},
    dispose: async () => {},
    detectInstallation: async () => ({ state: "installed" }),
    getAuthenticationStatus: async () => ({ state: "notApplicable" }),
    getCapabilities: async () => ({ supported: ["chat"] }),
    listModels: async () => [],
    createSession: async () => ({ providerSessionId: "p1", resumable: false }),
    sendMessage: async function* () {},
    cancel: async () => {},
    destroySession: async () => {},
    ...overrides,
  } as AIProviderAdapter;
}

describe("ProviderRegistry", () => {
  it("registers, looks up and unregisters adapters", () => {
    const registry = new ProviderRegistry({ logger: nullLogger });
    registry.register(stubAdapter("alpha"));

    expect(registry.has("alpha")).toBe(true);
    expect(registry.get("alpha")?.metadata.id).toBe("alpha");
    expect(registry.list()).toHaveLength(1);
    expect(registry.unregister("alpha")).toBe(true);
    expect(registry.get("alpha")).toBeUndefined();
  });

  it("refuses a duplicate id", () => {
    const registry = new ProviderRegistry({ logger: nullLogger });
    registry.register(stubAdapter("alpha"));
    expect(() => registry.register(stubAdapter("alpha"))).toThrow(/already registered/);
  });

  it("reports only installed adapters as available", async () => {
    const registry = new ProviderRegistry({ logger: nullLogger });
    registry.register(stubAdapter("installed"));
    registry.register(
      stubAdapter("missing", {
        detectInstallation: async () => ({ state: "notInstalled" }),
      }),
    );

    const available = await registry.getAvailable();
    expect(available.map((adapter) => adapter.metadata.id)).toEqual(["installed"]);
  });

  it("keeps a failing adapter from breaking the provider list", async () => {
    const registry = new ProviderRegistry({ logger: nullLogger });
    registry.register(stubAdapter("healthy"));
    registry.register(
      stubAdapter("broken", {
        detectInstallation: async () => {
          throw new Error("CLI exploded");
        },
        listModels: async () => {
          throw new Error("no models");
        },
      }),
    );

    const summaries = await registry.describeAll();
    expect(summaries).toHaveLength(2);

    const broken = summaries.find((entry) => entry.metadata.id === "broken");
    expect(broken?.installation.state).toBe("unknown");
    expect(broken?.models).toEqual([]);

    // A broken neighbour must not affect the healthy provider.
    const healthy = summaries.find((entry) => entry.metadata.id === "healthy");
    expect(healthy?.installation.state).toBe("installed");
  });
});

describe("error normalization", () => {
  it("keeps the kind of a provider error", () => {
    const error = new ProviderError("authentication", "Login expired", {
      retryable: true,
    });
    expect(error.toNormalized()).toEqual({
      kind: "authentication",
      message: "Login expired",
      retryable: true,
    });
  });

  it("maps an abort into a cancellation", () => {
    const abort = new Error("Cancelled");
    abort.name = "AbortError";
    expect(normalizeError(abort).kind).toBe("cancelled");
  });

  it("never throws on unexpected values", () => {
    expect(normalizeError("boom").kind).toBe("unknown");
    expect(normalizeError(undefined).message).toBeTruthy();
  });
});
