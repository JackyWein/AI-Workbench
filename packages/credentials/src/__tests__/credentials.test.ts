import { describe, expect, it } from "vitest";
import {
  CredentialManager,
  InMemoryCredentialStorage,
} from "../manager.js";
import { EncryptionUnavailableError, InMemoryEncryption } from "../store.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function createManager(available = true): CredentialManager {
  return new CredentialManager({
    encryption: new InMemoryEncryption(available),
    storage: new InMemoryCredentialStorage(),
    logger: nullLogger,
  });
}

describe("CredentialManager", () => {
  it("returns a reference and resolves it back to the secret", async () => {
    const manager = createManager();
    const descriptor = await manager.store({
      label: "Example account",
      kind: "oauth",
      secret: "super-secret-token",
    });

    expect(descriptor.reference).toMatch(/^cred_/);
    expect(await manager.resolve(descriptor.reference)).toBe("super-secret-token");
  });

  it("never exposes secrets when listing", async () => {
    const manager = createManager();
    await manager.store({ label: "A", kind: "apiKey", secret: "value-a" });

    const listed = await manager.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("value-a");
    expect(Object.keys(listed[0] ?? {})).not.toContain("secret");
  });

  it("replaces a secret while keeping its reference and creation time", async () => {
    const manager = createManager();
    const first = await manager.store({ label: "A", kind: "apiKey", secret: "one" });

    const second = await manager.store({
      label: "A renamed",
      kind: "apiKey",
      secret: "two",
      reference: first.reference,
    });

    expect(second.reference).toBe(first.reference);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(await manager.resolve(first.reference)).toBe("two");
    expect(await manager.list()).toHaveLength(1);
  });

  it("reports an unknown reference rather than throwing", async () => {
    const manager = createManager();
    expect(await manager.resolve("cred_missing")).toBeNull();
    expect(await manager.has("cred_missing")).toBe(false);
    expect(await manager.delete("cred_missing")).toBe(false);
  });

  it("deletes a credential", async () => {
    const manager = createManager();
    const descriptor = await manager.store({ label: "A", kind: "apiKey", secret: "x" });

    expect(await manager.delete(descriptor.reference)).toBe(true);
    expect(await manager.resolve(descriptor.reference)).toBeNull();
  });

  it("refuses to store anything when the platform has no secure storage", async () => {
    const manager = createManager(false);
    expect(manager.isAvailable()).toBe(false);
    await expect(
      manager.store({ label: "A", kind: "apiKey", secret: "x" }),
    ).rejects.toBeInstanceOf(EncryptionUnavailableError);
  });
});
