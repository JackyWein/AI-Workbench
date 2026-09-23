import type { ConnectionService } from "@ai-workbench/core";
import type { Logger, Workspace } from "@ai-workbench/shared";
import type { WorkspaceFileSystem } from "@ai-workbench/workspace-fs";
import {
  SshConnectionPool,
  SshWorkspaceFileSystem,
  remoteRoot,
  type SshTarget,
} from "@ai-workbench/workspace-ssh";

export interface WorkspaceAccessOptions {
  readonly logger: Logger;
  readonly connections: ConnectionService;
  /** The file system for workspaces on this computer. */
  readonly local: WorkspaceFileSystem;
}

/**
 * Decides which file system a workspace is reached through, and what its root
 * string is (spec §25).
 *
 * Everything above this — the file browser, the editor, the IPC handlers —
 * asks for a workspace's file system and a root, and never learns whether the
 * answer came from this computer or from a machine across the network. That
 * is the whole point of the split: adding SSH did not add a branch to any of
 * them.
 */
export class WorkspaceAccess {
  readonly #local: WorkspaceFileSystem;
  readonly #connections: ConnectionService;
  readonly #pool: SshConnectionPool;
  readonly #remote: SshWorkspaceFileSystem;

  constructor(options: WorkspaceAccessOptions) {
    this.#local = options.local;
    this.#connections = options.connections;

    this.#pool = new SshConnectionPool({
      logger: options.logger,
      onHostKeyLearned: (connectionId, fingerprint) => {
        // Trust on first use: the key a machine was first seen with is
        // written down, and every later connection has to match it.
        void this.#connections
          .rememberHostKey(connectionId, fingerprint)
          .catch((error: unknown) =>
            options.logger.warn("Could not remember a host key", {
              connectionId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      },
    });

    this.#remote = new SshWorkspaceFileSystem({
      logger: options.logger,
      pool: this.#pool,
      resolveTarget: (connectionId) => this.#targetFor(connectionId),
    });
  }

  /** The file system a workspace is reached through. */
  fileSystemFor(workspace: Workspace): WorkspaceFileSystem {
    return workspace.connectionId === null ? this.#local : this.#remote;
  }

  /**
   * The root string that file system expects. A local root is the path; a
   * remote one also says which machine, because the same path on two hosts is
   * two different places.
   */
  rootFor(workspace: Workspace): string {
    return workspace.connectionId === null
      ? workspace.path
      : remoteRoot(workspace.connectionId, workspace.path);
  }

  /**
   * The root for a session, which works inside its workspace. A session on a
   * remote workspace has a working directory on the other machine, so the
   * connection comes from the workspace rather than from the session.
   */
  rootForSession(workspace: Workspace, workingDirectory: string): string {
    return workspace.connectionId === null
      ? workingDirectory
      : remoteRoot(workspace.connectionId, workingDirectory);
  }

  /**
   * The remote file system itself, for browsing a machine before any
   * workspace exists on it.
   */
  remoteFileSystem(): SshWorkspaceFileSystem {
    return this.#remote;
  }

  /** Confirms a directory exists on a machine, before a workspace uses it. */
  async verifyRemoteDirectory(connectionId: string, path: string): Promise<string> {
    return this.#remote.verifyDirectory(connectionId, path);
  }

  /** Opens a connection far enough to prove it works, for the test button. */
  async homeDirectory(connectionId: string): Promise<string> {
    return this.#remote.homeDirectory(connectionId);
  }

  disconnect(connectionId: string): void {
    this.#pool.disconnect(connectionId);
  }

  dispose(): void {
    this.#pool.dispose();
  }

  async #targetFor(connectionId: string): Promise<SshTarget> {
    const connection = await this.#connections.require(connectionId);
    // The secret is resolved here, in the main process, at the moment it is
    // needed. It is never held on the connection record and never travels to
    // the renderer.
    const { secret, passphrase } = await this.#connections.credentialsFor(connectionId);
    return {
      id: connection.id,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      auth: connection.auth,
      secret,
      passphrase,
      hostKeyFingerprint: connection.hostKeyFingerprint,
    };
  }
}
