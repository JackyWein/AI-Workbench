import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { CredentialManager, InMemoryEncryption } from "@ai-workbench/credentials";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { SqlCredentialStorage } from "../credential-storage.js";
import { ConnectionService, SshConnectionInUseError } from "../connection-service.js";
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
    expect(await connections.secretFor(created.id)).toBe("hunter2");
  });

  it("stores nothing of its own for agent authentication", async () => {
    const created = await connections.create({ ...input, auth: "agent", secret: undefined });

    expect(created.credentialReference).toBeNull();
    expect(await connections.secretFor(created.id)).toBeNull();
  });

  it("replaces a secret in place rather than leaving the old one behind", async () => {
    const created = await connections.create(input);
    const reference = created.credentialReference;

    await connections.update({ id: created.id, secret: "newpassword" });

    expect((await connections.require(created.id)).credentialReference).toBe(reference);
    expect(await connections.secretFor(created.id)).toBe("newpassword");
  });

  it("leaves the stored secret alone when the update does not mention one", async () => {
    const created = await connections.create(input);
    await connections.update({ id: created.id, name: "Renamed" });

    expect((await connections.require(created.id)).name).toBe("Renamed");
    expect(await connections.secretFor(created.id)).toBe("hunter2");
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
