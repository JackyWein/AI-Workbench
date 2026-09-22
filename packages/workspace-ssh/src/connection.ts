import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import type { Logger, SshAuthMethod } from "@ai-workbench/shared";

// ssh2 is CommonJS, so its exports are reached through the default import
// rather than named ones, which an ESM build would not find.
const { Client } = ssh2;
type Client = ssh2.Client;
type SFTPWrapper = ssh2.SFTPWrapper;

/** How a connection is opened, with the secret already resolved. */
export interface SshTarget {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: SshAuthMethod;
  /** The password, or the private key, or null for agent authentication. */
  readonly secret: string | null;
  /**
   * The host key this connection is known by, as a SHA-256 fingerprint. Null
   * means nothing is known yet and whatever the machine offers is learned.
   */
  readonly hostKeyFingerprint: string | null;
}

export class SshConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshConnectionError";
  }
}

/**
 * A machine offering a different host key than the one this connection is
 * known by. That is either a rebuilt server or someone in the middle, and the
 * two are indistinguishable from here, so it is refused and the user decides.
 */
export class SshHostKeyChangedError extends SshConnectionError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      `The host key changed. Expected ${expected} but the server offered ${actual}. ` +
        "If this machine was genuinely rebuilt, forget its key and connect again.",
    );
    this.name = "SshHostKeyChangedError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** The fingerprint format every SSH client shows, so it can be compared by eye. */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

export interface SshConnectionPoolOptions {
  readonly logger: Logger;
  /** Called when a connection learns a host key it did not have before. */
  readonly onHostKeyLearned?: (connectionId: string, fingerprint: string) => void;
  readonly connectTimeoutMs?: number;
  /** How long an unused connection is kept before it is closed. */
  readonly idleMs?: number;
}

interface PooledConnection {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
  /** Connections are shared, so the last use decides when it may be closed. */
  lastUsedAt: number;
  inFlight: number;
}

/**
 * Keeps one SSH connection per configured machine and hands out its SFTP
 * channel (spec §25). Opening an SSH connection costs a round trip and a key
 * exchange, so a file browser that opened one per click would be unusable;
 * sharing one is what makes a remote workspace feel like a local one.
 *
 * A connection that drops is not an error to report upward: the next call
 * opens a new one, because a dropped connection is normal on a laptop that
 * slept.
 */
export class SshConnectionPool {
  readonly #logger: Logger;
  readonly #connections = new Map<string, PooledConnection>();
  readonly #pending = new Map<string, Promise<PooledConnection>>();
  readonly #onHostKeyLearned: ((id: string, fingerprint: string) => void) | null;
  readonly #connectTimeoutMs: number;
  readonly #idleMs: number;
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: SshConnectionPoolOptions) {
    this.#logger = options.logger.child("SSH");
    this.#onHostKeyLearned = options.onHostKeyLearned ?? null;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#idleMs = options.idleMs ?? 5 * 60_000;
  }

  /**
   * Runs one piece of work against a machine's SFTP channel. Everything goes
   * through here so a dropped connection is retried once in one place rather
   * than at every call site.
   */
  async withSftp<T>(target: SshTarget, work: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const connection = await this.#acquire(target);
    connection.inFlight += 1;
    try {
      const result = await work(connection.sftp);
      connection.lastUsedAt = Date.now();
      return result;
    } catch (error) {
      if (!isConnectionLost(error)) {
        throw error;
      }
      // The connection died under us. A second attempt on a fresh one is the
      // honest answer; a second failure is reported as itself.
      this.#logger.debug("Reconnecting after a lost connection", { connectionId: target.id });
      this.#drop(target.id);
      const fresh = await this.#acquire(target);
      fresh.inFlight += 1;
      try {
        const result = await work(fresh.sftp);
        fresh.lastUsedAt = Date.now();
        return result;
      } finally {
        fresh.inFlight -= 1;
      }
    } finally {
      connection.inFlight -= 1;
    }
  }

  /** Closes a machine's connection, so the next use reconnects. */
  disconnect(connectionId: string): void {
    this.#drop(connectionId);
  }

  dispose(): void {
    if (this.#sweeper) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
    for (const id of [...this.#connections.keys()]) {
      this.#drop(id);
    }
  }

  async #acquire(target: SshTarget): Promise<PooledConnection> {
    const existing = this.#connections.get(target.id);
    if (existing) {
      return existing;
    }
    // Two file operations starting at once must share one connection rather
    // than racing to open two, which would leave one of them orphaned.
    const pending = this.#pending.get(target.id);
    if (pending) {
      return pending;
    }
    const attempt = this.#open(target)
      .then((connection) => {
        this.#connections.set(target.id, connection);
        this.#startSweeper();
        return connection;
      })
      .finally(() => {
        this.#pending.delete(target.id);
      });
    this.#pending.set(target.id, attempt);
    return attempt;
  }

  async #open(target: SshTarget): Promise<PooledConnection> {
    const client = new Client();
    let offered: string | null = null;

    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy();
        reject(new SshConnectionError(`${target.host} did not answer in time`));
      }, this.#connectTimeoutMs);

      client
        .on("ready", () => {
          clearTimeout(timer);
          resolve();
        })
        .on("error", (error: Error) => {
          clearTimeout(timer);
          reject(describe(error, target));
        });

      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        ...authOf(target),
        readyTimeout: this.#connectTimeoutMs,
        // A workspace is browsed in bursts with long pauses between them, so
        // the connection is kept alive rather than silently dying mid-session.
        keepaliveInterval: 20_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          offered = fingerprintOf(key);
          if (target.hostKeyFingerprint === null) {
            return true;
          }
          return offered === target.hostKeyFingerprint;
        },
      });
    });

    try {
      await connected;
    } catch (error) {
      client.destroy();
      // A rejected host key surfaces from ssh2 as a plain handshake failure,
      // which would send the user looking at their password. Naming the real
      // reason is the difference between a fixable error and a mystery.
      if (
        target.hostKeyFingerprint !== null &&
        offered !== null &&
        offered !== target.hostKeyFingerprint
      ) {
        throw new SshHostKeyChangedError(target.hostKeyFingerprint, offered);
      }
      throw error;
    }

    if (target.hostKeyFingerprint === null && offered !== null) {
      this.#logger.info("Learned a host key", { connectionId: target.id, fingerprint: offered });
      this.#onHostKeyLearned?.(target.id, offered);
    }

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, channel) => {
        if (error) {
          reject(new SshConnectionError(`SFTP is not available: ${error.message}`));
          return;
        }
        resolve(channel);
      });
    }).catch((error: unknown) => {
      client.destroy();
      throw error;
    });

    client.on("close", () => {
      // Only forget this exact connection: a reconnect may already have put a
      // newer one in its place, and dropping that would close a live channel.
      const current = this.#connections.get(target.id);
      if (current?.client === client) {
        this.#connections.delete(target.id);
      }
    });

    this.#logger.info("Connected", {
      connectionId: target.id,
      host: target.host,
      port: target.port,
    });
    return { client, sftp, lastUsedAt: Date.now(), inFlight: 0 };
  }

  #drop(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      return;
    }
    this.#connections.delete(connectionId);
    try {
      connection.client.end();
    } catch {
      // Already gone; nothing to close.
    }
  }

  /** Closes connections nobody has used for a while, so idle machines let go. */
  #startSweeper(): void {
    if (this.#sweeper) {
      return;
    }
    this.#sweeper = setInterval(() => {
      const cutoff = Date.now() - this.#idleMs;
      for (const [id, connection] of this.#connections) {
        if (connection.inFlight === 0 && connection.lastUsedAt < cutoff) {
          this.#logger.debug("Closing an idle connection", { connectionId: id });
          this.#drop(id);
        }
      }
      if (this.#connections.size === 0 && this.#sweeper) {
        clearInterval(this.#sweeper);
        this.#sweeper = null;
      }
    }, 60_000);
    this.#sweeper.unref?.();
  }
}

function authOf(target: SshTarget): Record<string, unknown> {
  if (target.auth === "agent") {
    const agent = process.env["SSH_AUTH_SOCK"];
    if (!agent) {
      throw new SshConnectionError(
        "No SSH agent is running, so there is nothing to authenticate with.",
      );
    }
    return { agent };
  }
  if (target.secret === null || target.secret === "") {
    throw new SshConnectionError(
      target.auth === "password"
        ? "No password is stored for this connection."
        : "No private key is stored for this connection.",
    );
  }
  return target.auth === "password"
    ? { password: target.secret }
    : { privateKey: target.secret };
}

/** Turns ssh2's terse failures into something a person can act on. */
function describe(error: Error, target: SshTarget): SshConnectionError {
  const message = error.message || String(error);
  if (/All configured authentication methods failed/i.test(message)) {
    return new SshConnectionError(
      `${target.username}@${target.host} rejected the credentials for this connection.`,
    );
  }
  if (/ECONNREFUSED/i.test(message)) {
    return new SshConnectionError(`Nothing is listening on ${target.host}:${target.port}.`);
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new SshConnectionError(`The name "${target.host}" could not be resolved.`);
  }
  if (/ETIMEDOUT|timed out/i.test(message)) {
    return new SshConnectionError(`${target.host} did not answer in time.`);
  }
  return new SshConnectionError(message);
}

/**
 * Whether a failure means the connection is gone rather than the operation
 * being wrong. Only these are worth retrying; a missing file is not.
 */
function isConnectionLost(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /No response from server|not connected|channel closed|ECONNRESET|EPIPE|closed by the remote/i.test(
    error.message,
  );
}
