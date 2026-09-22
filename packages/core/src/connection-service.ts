import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { sshConnections, workspaces, type SshConnectionRow } from "@ai-workbench/database";
import type { CredentialManager } from "@ai-workbench/credentials";
import type {
  CreateSshConnectionInput,
  Logger,
  SshConnection,
  SshConnectionTest,
  UpdateSshConnectionInput,
} from "@ai-workbench/shared";
import type { EventBus } from "./event-bus.js";
import { createId } from "./ids.js";

export class SshConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`Connection "${id}" does not exist`);
    this.name = "SshConnectionNotFoundError";
  }
}

export class SshConnectionInUseError extends Error {
  readonly workspaceNames: readonly string[];

  constructor(names: readonly string[]) {
    super(
      `This connection is still used by ${names.length === 1 ? "the workspace" : "the workspaces"} ` +
        names.map((name) => `"${name}"`).join(", "),
    );
    this.name = "SshConnectionInUseError";
    this.workspaceNames = names;
  }
}

/** What the service needs from the SSH side, without depending on it. */
export interface SshProbe {
  /** Opens a connection and answers with the home directory the host resolved. */
  homeDirectory(connectionId: string): Promise<string>;
  /** Closes a connection, so changed settings are picked up next time. */
  disconnect(connectionId: string): void;
}

export interface ConnectionServiceOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly credentials: CredentialManager;
  /** Supplied after construction, because the SSH side needs this service. */
  readonly probe?: SshProbe;
}

/**
 * The machines a workspace can live on (spec §25).
 *
 * The secret never lives here: it goes into the credential store on the way
 * in and is only ever read back inside the main process, by the SSH transport
 * itself. Everything this service returns is safe to hand to the renderer,
 * which is why it returns rows rather than anything resembling a credential.
 */
export class ConnectionService {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #credentials: CredentialManager;
  #probe: SshProbe | null;

  constructor(options: ConnectionServiceOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("CONNECTION");
    this.#credentials = options.credentials;
    this.#probe = options.probe ?? null;
  }

  /** The SSH side is handed over once both exist, breaking the cycle. */
  useProbe(probe: SshProbe): void {
    this.#probe = probe;
  }

  async list(): Promise<SshConnection[]> {
    const rows = await this.#db.select().from(sshConnections);
    return rows.map(toConnection).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<SshConnection | null> {
    const [row] = await this.#db
      .select()
      .from(sshConnections)
      .where(eq(sshConnections.id, id))
      .limit(1);
    return row ? toConnection(row) : null;
  }

  async require(id: string): Promise<SshConnection> {
    const connection = await this.get(id);
    if (!connection) {
      throw new SshConnectionNotFoundError(id);
    }
    return connection;
  }

  async create(input: CreateSshConnectionInput): Promise<SshConnection> {
    const id = createId("conn");
    const credentialReference =
      input.auth === "agent" || !input.secret
        ? null
        : (
            await this.#credentials.store({
              label: `${input.username}@${input.host}`,
              kind: input.auth === "password" ? "ssh-password" : "ssh-key",
              secret: input.secret,
            })
          ).reference;

    const now = new Date();
    const row: SshConnectionRow = {
      id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      auth: input.auth,
      credentialReference,
      // Nothing is trusted yet: the first successful connection records what
      // the machine offered, and every later one has to match it.
      hostKeyFingerprint: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.insert(sshConnections).values(row);
    const connection = toConnection(row);
    this.#logger.info("Connection created", { connectionId: id, host: input.host });
    this.#events.publish({ type: "connection.changed", connectionId: id });
    return connection;
  }

  async update(input: UpdateSshConnectionInput): Promise<SshConnection> {
    const existing = await this.require(input.id);

    let credentialReference = existing.credentialReference;
    if (input.secret !== undefined && input.secret !== "") {
      const auth = input.auth ?? existing.auth;
      credentialReference = (
        await this.#credentials.store({
          label: `${input.username ?? existing.username}@${input.host ?? existing.host}`,
          kind: auth === "password" ? "ssh-password" : "ssh-key",
          secret: input.secret,
          ...(existing.credentialReference
            ? { reference: existing.credentialReference }
            : {}),
        })
      ).reference;
    }
    // Switching to the agent leaves nothing of this connection's own to keep,
    // so the stored secret goes rather than lingering unused.
    if (input.auth === "agent" && credentialReference) {
      await this.#credentials.delete(credentialReference);
      credentialReference = null;
    }

    const updated: SshConnection = {
      ...existing,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.username === undefined ? {} : { username: input.username }),
      ...(input.auth === undefined ? {} : { auth: input.auth }),
      credentialReference,
      ...(input.forgetHostKey ? { hostKeyFingerprint: null } : {}),
      updatedAt: new Date(),
    };

    await this.#db
      .update(sshConnections)
      .set({
        name: updated.name,
        host: updated.host,
        port: updated.port,
        username: updated.username,
        auth: updated.auth,
        credentialReference: updated.credentialReference,
        hostKeyFingerprint: updated.hostKeyFingerprint,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sshConnections.id, updated.id));

    // Anything changed here changes how the machine is reached, so the open
    // connection is dropped rather than left serving the old settings.
    this.#probe?.disconnect(updated.id);
    this.#events.publish({ type: "connection.changed", connectionId: updated.id });
    return updated;
  }

  /**
   * Records the key a machine was first seen with. Called by the transport,
   * not by the user: this is the moment trust is established.
   */
  async rememberHostKey(id: string, fingerprint: string): Promise<void> {
    await this.#db
      .update(sshConnections)
      .set({ hostKeyFingerprint: fingerprint, updatedAt: new Date() })
      .where(eq(sshConnections.id, id));
    this.#events.publish({ type: "connection.changed", connectionId: id });
  }

  /**
   * Removes a connection. A connection still carrying workspaces is refused
   * rather than deleted: the alternative is workspaces that point at a machine
   * the application no longer knows how to reach.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) {
      return false;
    }
    const attached = await this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.connectionId, id));
    if (attached.length > 0) {
      throw new SshConnectionInUseError(attached.map((workspace) => workspace.name));
    }

    this.#probe?.disconnect(id);
    await this.#db.delete(sshConnections).where(eq(sshConnections.id, id));
    if (existing.credentialReference) {
      await this.#credentials.delete(existing.credentialReference);
    }
    this.#logger.info("Connection deleted", { connectionId: id });
    this.#events.publish({ type: "connection.changed", connectionId: id });
    return true;
  }

  /** Resolves the secret for the transport. Main process only. */
  async secretFor(id: string): Promise<string | null> {
    const connection = await this.require(id);
    if (!connection.credentialReference) {
      return null;
    }
    return this.#credentials.resolve(connection.credentialReference);
  }

  /**
   * Tries a connection and reports what happened, including the fingerprint,
   * so the user can compare it with what the machine's administrator says it
   * should be. A failure is an answer, not an exception: the reason is the
   * whole point of testing.
   */
  async test(id: string): Promise<SshConnectionTest> {
    const before = await this.require(id);
    if (!this.#probe) {
      return {
        ok: false,
        fingerprint: before.hostKeyFingerprint,
        learnedHostKey: false,
        homeDirectory: null,
        error: "Connections are not available in this process.",
      };
    }
    // A test is a test of the settings as they are now, not of a connection
    // opened minutes ago under the old ones.
    this.#probe.disconnect(id);
    try {
      const homeDirectory = await this.#probe.homeDirectory(id);
      const after = await this.require(id);
      return {
        ok: true,
        fingerprint: after.hostKeyFingerprint,
        learnedHostKey: before.hostKeyFingerprint === null && after.hostKeyFingerprint !== null,
        homeDirectory,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        fingerprint: before.hostKeyFingerprint,
        learnedHostKey: false,
        homeDirectory: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function toConnection(row: SshConnectionRow): SshConnection {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    auth: row.auth,
    credentialReference: row.credentialReference ?? null,
    hostKeyFingerprint: row.hostKeyFingerprint ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
