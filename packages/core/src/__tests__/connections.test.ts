import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { CredentialManager, InMemoryEncryption } from "@ai-workbench/credentials";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { SqlCredentialStorage } from "../credential-storage.js";
import {
  ConnectionService,
  SshConnectionInUseError,
  SshKeyError,
  type SshKeyCheck,
} from "../connection-service.js";
import { WorkspaceManager } from "../workspace-manager.js";

let directory: string;
let database: DatabaseHandle;
let connections: ConnectionService;
let workspaces: WorkspaceManager;
let credentials: CredentialManager;

beforeEach(async () => {
  directory = await makeTempDirectory("connections");
  database = createDatabase({ file: join(directory, "app.db") });
  await runMigrations(database.client);

  const events = new EventBus();
  const logger = createNullLogger();
  credentials = new CredentialManager({
    encryption: new InMemoryEncryption(),
    storage: new SqlCredentialStorage(database.db),
    logger,
  });
  connections = new ConnectionService({ db: database.db, events, logger, credentials });
  workspaces = new WorkspaceManager({
    db: database.db,
    events,
    logger,
    // The machine is not contacted here; only the bookkeeping is under test.
    checkRemoteDirectory: async (_id, path) => path,
  });
});

afterEach(async () => {
  database.close();
  await removeTempDirectory(directory);
});

const input = {
  name: "Build box",
  host: "build.example.com",
  port: 22,
  username: "dev",
  auth: "password" as const,
  secret: "hunter2",
};

describe("the machines a workspace can live on", () => {
  it("keeps the secret out of everything it hands back", async () => {
    const created = await connections.create(input);
    const listed = await connections.list();

    // Only a reference travels; the secret itself never appears in a record
    // that the renderer is allowed to see.
    expect(JSON.stringify(created)).not.toContain("hunter2");
    expect(JSON.stringify(listed)).not.toContain("hunter2");
    expect(created.credentialReference).not.toBeNull();
    // And it really was stored, rather than dropped.
    expect((await connections.credentialsFor(created.id)).secret).toBe("hunter2");
  });

  it("stores nothing of its own for agent authentication", async () => {
    const created = await connections.create({ ...input, auth: "agent", secret: undefined });

    expect(created.credentialReference).toBeNull();
    expect((await connections.credentialsFor(created.id)).secret).toBeNull();
  });

  it("replaces a secret in place rather than leaving the old one behind", async () => {
    const created = await connections.create(input);
    const reference = created.credentialReference;

    await connections.update({ id: created.id, secret: "newpassword" });

    expect((await connections.require(created.id)).credentialReference).toBe(reference);
    expect((await connections.credentialsFor(created.id)).secret).toBe("newpassword");
  });

  it("leaves the stored secret alone when the update does not mention one", async () => {
    const created = await connections.create(input);
    await connections.update({ id: created.id, name: "Renamed" });

    expect((await connections.require(created.id)).name).toBe("Renamed");
    expect((await connections.credentialsFor(created.id)).secret).toBe("hunter2");
  });

  it("drops the stored secret when it switches to the agent", async () => {
    const created = await connections.create(input);
    const reference = created.credentialReference!;

    const updated = await connections.update({ id: created.id, auth: "agent" });

    expect(updated.credentialReference).toBeNull();
    // Nothing is left in the store for a connection that no longer uses it.
    expect(await credentials.has(reference)).toBe(false);
  });

  it("trusts a host key on first use and keeps it", async () => {
    const created = await connections.create(input);
    expect(created.hostKeyFingerprint).toBeNull();

    await connections.rememberHostKey(created.id, "SHA256:abc");
    expect((await connections.require(created.id)).hostKeyFingerprint).toBe("SHA256:abc");

    // Forgetting is explicit, so a rebuilt machine can be accepted again.
    const forgotten = await connections.update({ id: created.id, forgetHostKey: true });
    expect(forgotten.hostKeyFingerprint).toBeNull();
  });

  it("refuses to remove a connection that still carries workspaces", async () => {
    const created = await connections.create(input);
    await workspaces.create({
      name: "Remote project",
      path: "/srv/app",
      connectionId: created.id,
    });

    await expect(connections.delete(created.id)).rejects.toBeInstanceOf(
      SshConnectionInUseError,
    );
    // And it is still there, rather than half-removed.
    expect(await connections.get(created.id)).not.toBeNull();
  });

  it("removes a connection nobody uses, and its secret with it", async () => {
    const created = await connections.create(input);
    const reference = created.credentialReference!;

    expect(await connections.delete(created.id)).toBe(true);
    expect(await connections.get(created.id)).toBeNull();
    expect(await credentials.has(reference)).toBe(false);
  });

  it("reports a failed test instead of throwing it away", async () => {
    const created = await connections.create(input);
    connections.useProbe({
      homeDirectory: () => Promise.reject(new Error("the machine refused the credentials")),
      disconnect: () => undefined,
    });

    const result = await connections.test(created.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("refused the credentials");
  });

  it("says when a test taught it the host key", async () => {
    const created = await connections.create(input);
    connections.useProbe({
      homeDirectory: async (id) => {
        await connections.rememberHostKey(id, "SHA256:learned");
        return "/home/dev";
      },
      disconnect: () => undefined,
    });

    const first = await connections.test(created.id);
    expect(first).toMatchObject({
      ok: true,
      learnedHostKey: true,
      fingerprint: "SHA256:learned",
      homeDirectory: "/home/dev",
    });

    // The second test recognises the machine rather than learning it again.
    expect((await connections.test(created.id)).learnedHostKey).toBe(false);
  });
});

describe("a workspace that is not on this computer", () => {
  it("remembers which machine it is on", async () => {
    const connection = await connections.create(input);
    const workspace = await workspaces.create({
      name: "Remote project",
      path: "/srv/app",
      connectionId: connection.id,
    });

    expect(workspace.connectionId).toBe(connection.id);
    expect(workspace.path).toBe("/srv/app");
  });

  it("treats the same path on two machines as two workspaces", async () => {
    const first = await connections.create(input);
    const second = await connections.create({ ...input, name: "Other box" });

    const one = await workspaces.create({
      name: "App",
      path: "/srv/app",
      connectionId: first.id,
    });
    const two = await workspaces.create({
      name: "App",
      path: "/srv/app",
      connectionId: second.id,
    });

    expect(one.id).not.toBe(two.id);
    // And adding the same one again still selects what is already there.
    const again = await workspaces.create({
      name: "App",
      path: "/srv/app",
      connectionId: first.id,
    });
    expect(again.id).toBe(one.id);
  });

  it("refuses a relative path on a machine, where it means nothing", async () => {
    const connection = await connections.create(input);
    await expect(
      workspaces.create({ name: "App", path: "srv/app", connectionId: connection.id }),
    ).rejects.toThrow(/must be absolute/);
  });

  it("refuses a remote workspace where connections are not available", async () => {
    const events = new EventBus();
    const withoutSsh = new WorkspaceManager({
      db: database.db,
      events,
      logger: createNullLogger(),
    });
    const connection = await connections.create(input);

    await expect(
      withoutSsh.create({ name: "App", path: "/srv/app", connectionId: connection.id }),
    ).rejects.toThrow(/not available in this process/);
  });
});

describe("signing in with a private key", () => {
  const keyInput = { ...input, auth: "key" as const, secret: undefined };
  /** Stands in for the SSH side: "LOCKED" keys open with "pw" only. */
  const checkKey = (text: string, passphrase: string | null): SshKeyCheck => {
    if (text.includes("PUBLIC")) {
      return { ok: false, error: "This is a public key.", needsPassphrase: false };
    }
    if (text.includes("LOCKED")) {
      return passphrase === "pw"
        ? { ok: true, privateKey: text.trim(), encrypted: true }
        : { ok: false, error: "The passphrase doesn't open this key.", needsPassphrase: true };
    }
    return { ok: true, privateKey: text.trim(), encrypted: false };
  };

  beforeEach(() => {
    connections.useProbe({
      homeDirectory: async () => "/home/dev",
      disconnect: () => undefined,
      checkKey,
    });
  });

  it("keeps a key with its passphrase, and the key as the SSH side read it", async () => {
    const created = await connections.create({ ...keyInput, secret: "  LOCKED KEY \r\n", passphrase: "pw" });
    expect(await connections.credentialsFor(created.id)).toEqual({
      secret: "LOCKED KEY",
      passphrase: "pw",
    });
    expect(JSON.stringify(created)).not.toContain("LOCKED");
  });

  it("does not keep a passphrase a key does not need", async () => {
    const created = await connections.create({ ...keyInput, secret: "OPEN KEY", passphrase: "pw" });
    expect(await connections.credentialsFor(created.id)).toEqual({ secret: "OPEN KEY", passphrase: null });
  });

  it("refuses a key that cannot work, with the reason", async () => {
    await expect(connections.create({ ...keyInput, secret: "PUBLIC KEY" })).rejects.toThrow(
      "This is a public key.",
    );
    const locked = await connections
      .create({ ...keyInput, secret: "LOCKED KEY", passphrase: "nope" })
      .catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(SshKeyError);
    expect((locked as SshKeyError).needsPassphrase).toBe(true);
    expect(await connections.list()).toHaveLength(0);
  });

  it("reads a key file in place of a pasted key", async () => {
    const file = join(directory, "id_test");
    await writeFile(file, "OPEN KEY FROM FILE\n");
    const created = await connections.create({ ...keyInput, keyFile: file });
    expect((await connections.credentialsFor(created.id)).secret).toBe("OPEN KEY FROM FILE");
  });

  it("changes only the passphrase of a stored key", async () => {
    const created = await connections.create({ ...keyInput, secret: "LOCKED KEY", passphrase: "pw" });
    await expect(connections.update({ id: created.id, passphrase: "other" })).rejects.toThrow(
      /passphrase/,
    );
    await connections.update({ id: created.id, name: "Renamed" });
    expect(await connections.credentialsFor(created.id)).toEqual({ secret: "LOCKED KEY", passphrase: "pw" });
  });

  it("still reads a key stored before passphrases were kept with it", async () => {
    const created = await connections.create({ ...input, auth: "key", secret: "OLD KEY" });
    // Written the old way: the bare key text as the stored secret.
    await credentials.store({
      label: "dev@build.example.com",
      kind: "ssh-key",
      secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nold\n",
      reference: created.credentialReference!,
    });
    expect(await connections.credentialsFor(created.id)).toEqual({
      secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nold\n",
      passphrase: null,
    });
  });

  it("asks for the new secret when the sign-in method changes", async () => {
    const created = await connections.create(input);
    await expect(connections.update({ id: created.id, auth: "key" })).rejects.toThrow(
      /Give the private key/,
    );
  });
});
