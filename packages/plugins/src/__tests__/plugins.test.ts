import { describe, expect, it } from "vitest";
import {
  parsePlugin,
  type PluginAccount,
  type PluginManifestInput,
} from "../manifest.js";
import { DuplicatePluginError, PluginRegistry } from "../registry.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function plugin(
  id: string,
  overrides: Partial<PluginManifestInput> = {},
): PluginManifestInput {
  return { schemaVersion: 1, id, name: id, ...overrides };
}

function account(accountType: string, id = `acc-${accountType}`): PluginAccount {
  return {
    id,
    accountType,
    label: `${accountType} account`,
    credentialReference: `cred_${accountType}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const gmail = plugin("gmail", {
  name: "Gmail",
  authentication: { kind: "oauth", accountType: "google", scopes: ["mail.read"] },
});
const drive = plugin("drive", {
  name: "Drive",
  authentication: { kind: "oauth", accountType: "google" },
});
const github = plugin("github", {
  name: "GitHub",
  authentication: { kind: "apiKey", accountType: "github" },
});
const localTool = plugin("local", { name: "Local", authentication: { kind: "none" } });

describe("plugin manifests", () => {
  it("fills in defaults", () => {
    const parsed = parsePlugin(plugin("gmail"));
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.authentication.kind).toBe("none");
    expect(parsed.tools).toEqual([]);
  });

  it("rejects an unusable id", () => {
    expect(() => parsePlugin(plugin("Not Valid"))).toThrow();
  });

  it("keeps a manifest free of secrets by construction", () => {
    const parsed = parsePlugin(gmail);
    // Authentication describes how to connect, never the credential itself.
    expect(Object.keys(parsed.authentication)).toEqual(
      expect.not.arrayContaining(["secret", "token", "apiKey"]),
    );
  });
});

describe("PluginRegistry", () => {
  function registry(): PluginRegistry {
    const instance = new PluginRegistry({ logger: nullLogger });
    instance.register(gmail);
    instance.register(drive);
    instance.register(github);
    instance.register(localTool);
    return instance;
  }

  it("refuses a duplicate id", () => {
    const instance = registry();
    expect(() => instance.register(gmail)).toThrow(DuplicatePluginError);
  });

  it("lists the plugins one account would serve", () => {
    expect(registry().servedBy("google").map((entry) => entry.id)).toEqual([
      "drive",
      "gmail",
    ]);
  });

  it("serves several plugins from a single account", () => {
    const resolved = registry().resolve(
      {
        global: [
          { pluginId: "gmail", enabled: true },
          { pluginId: "drive", enabled: true },
        ],
      },
      [account("google")],
    );

    expect(resolved).toHaveLength(2);
    // One sign-in, both plugins usable.
    expect(resolved.every((entry) => entry.usable)).toBe(true);
    expect(new Set(resolved.map((entry) => entry.account?.id))).toEqual(
      new Set(["acc-google"]),
    );
  });

  it("marks a plugin without an account as not usable instead of hiding it", () => {
    const resolved = registry().resolve(
      { global: [{ pluginId: "github", enabled: true }] },
      [account("google")],
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.usable).toBe(false);
    expect(resolved[0]?.account).toBeNull();
  });

  it("needs no account for a plugin that authenticates with nothing", () => {
    const resolved = registry().resolve(
      { global: [{ pluginId: "local", enabled: true }] },
      [],
    );
    expect(resolved[0]?.usable).toBe(true);
  });

  it("lets a session switch off a workspace plugin", () => {
    const resolved = registry().resolve(
      {
        workspace: [{ pluginId: "gmail", enabled: true }],
        session: [{ pluginId: "gmail", enabled: false }],
      },
      [account("google")],
    );
    expect(resolved).toEqual([]);
  });

  it("lets a team agent narrow what a session allows", () => {
    const resolved = registry().resolve(
      {
        session: [
          { pluginId: "gmail", enabled: true },
          { pluginId: "drive", enabled: true },
        ],
        agent: [{ pluginId: "drive", enabled: false }],
      },
      [account("google")],
    );

    expect(resolved.map((entry) => entry.plugin.id)).toEqual(["gmail"]);
    expect(resolved[0]?.decidedBy).toBe("session");
  });

  it("ignores a scope entry for a plugin that no longer exists", () => {
    const resolved = registry().resolve(
      { session: [{ pluginId: "gone", enabled: true }] },
      [],
    );
    expect(resolved).toEqual([]);
  });
});
