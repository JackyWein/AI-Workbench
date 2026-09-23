import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeTempDirectory,
  removeTempDirectory,
  startSshTestServer,
  type SshTestServer,
} from "@ai-workbench/test-support";
import { PathBoundaryError } from "@ai-workbench/workspace-fs";
import {
  SshConnectionPool,
  SshHostKeyChangedError,
  SshWorkspaceFileSystem,
  remoteRoot,
  type SshTarget,
} from "../index.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

let directory: string;
let outside: string;
let server: SshTestServer;
const pools: SshConnectionPool[] = [];

function connect(overrides: Partial<SshTarget> = {}): {
  files: SshWorkspaceFileSystem;
  pool: SshConnectionPool;
  learned: string[];
} {
  const learned: string[] = [];
  const pool = new SshConnectionPool({
    logger: nullLogger,
    onHostKeyLearned: (_id, fingerprint) => learned.push(fingerprint),
    connectTimeoutMs: 10_000,
  });
  pools.push(pool);
  const target: SshTarget = {
    id: "conn_1",
    host: server.host,
    port: server.port,
    username: server.username,
    auth: "password",
    secret: server.password,
    hostKeyFingerprint: null,
    ...overrides,
  };
  const files = new SshWorkspaceFileSystem({
    logger: nullLogger,
    pool,
    resolveTarget: async () => target,
    maxReadBytes: 64,
    maxWriteBytes: 128,
  });
  return { files, pool, learned };
}

const root = (): string => remoteRoot("conn_1", directory);

/**
 * The server in this test serves this computer's disk as the remote machine.
 * The remote side of a workspace is a POSIX machine; on Windows the served
 * paths would be drive paths no SSH server hands out, and the symlink below
 * needs administrator rights there. So this runs where the stand-in can be
 * what it stands in for.
 */
describe.runIf(process.platform !== "win32")("over SSH, against a POSIX machine", () => {
  beforeAll(async () => {
    directory = await makeTempDirectory("ssh-fs");
    outside = await makeTempDirectory("ssh-outside");
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "notes.md"), "# Notes\n");
    await writeFile(join(directory, "src", "app.ts"), "export const answer = 42;\n");
    await writeFile(join(directory, "picture.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(join(outside, "secrets.txt"), "not yours\n");
    await symlink(outside, join(directory, "escape"), "dir");
    server = await startSshTestServer({ directory });
  });

  afterEach(() => {
    for (const pool of pools.splice(0)) {
      pool.dispose();
    }
  });

  afterAll(async () => {
    await server.close();
    await removeTempDirectory(directory);
    await removeTempDirectory(outside);
  });

  describe("a workspace on another machine", () => {
    it("lists a directory the way a local one is listed", async () => {
      const { files } = connect();
      const entries = await files.list(root());

      // Directories first, then files, both by name — and the symlinked
      // directory is described as a directory, exactly as locally.
      expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
        "directory:escape",
        "directory:src",
        "file:notes.md",
        "file:picture.bin",
      ]);
    });

    it("reads a file and reports where it is, relative to the root", async () => {
      const { files } = connect();
      const file = await files.readText(root(), "src/app.ts");

      expect(file.content).toBe("export const answer = 42;\n");
      expect(file.path).toBe("src/app.ts");
      expect(file.binary).toBe(false);
      expect(file.truncated).toBe(false);
    });

    it("writes a file and can read back what it wrote", async () => {
      const { files } = connect();
      const written = await files.writeText(root(), "src/app.ts", "export const answer = 7;\n");

      expect(written.path).toBe("src/app.ts");
      expect((await files.readText(root(), "src/app.ts")).content).toBe(
        "export const answer = 7;\n",
      );
    });

    it("creates a file that was not there before", async () => {
      const { files } = connect();
      await files.writeText(root(), "src/new.ts", "export const fresh = true;\n");

      expect((await files.readText(root(), "src/new.ts")).content).toBe(
        "export const fresh = true;\n",
      );
      expect(await files.exists(root(), "src/new.ts")).toBe(true);
    });

    it("never returns binary content as text", async () => {
      const { files } = connect();
      const file = await files.readText(root(), "picture.bin");

      expect(file.binary).toBe(true);
      expect(file.content).toBe("");
    });

    it("refuses to write binary content", async () => {
      const { files } = connect();
      await expect(files.writeText(root(), "bad.bin", "a\u0000b")).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it("caps a read and says it was cut short", async () => {
      const { files } = connect();
      await files.writeText(root(), "long.txt", "x".repeat(100));
      const file = await files.readText(root(), "long.txt");

      expect(file.content).toHaveLength(64);
      expect(file.truncated).toBe(true);
      expect(file.size).toBe(100);
    });

    it("refuses a write larger than the cap", async () => {
      const { files } = connect();
      await expect(
        files.writeText(root(), "huge.txt", "x".repeat(200)),
      ).rejects.toBeInstanceOf(PathBoundaryError);
    });

    it("says a directory is not a file rather than returning nothing", async () => {
      const { files } = connect();
      await expect(files.readText(root(), "src")).rejects.toBeInstanceOf(PathBoundaryError);
    });
  });

  describe("the boundary of a remote root", () => {
    it("refuses a path that climbs out of the root", async () => {
      const { files } = connect();
      await expect(files.readText(root(), "../secrets.txt")).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it("refuses an absolute path outside the root", async () => {
      const { files } = connect();
      await expect(
        files.readText(root(), join(outside, "secrets.txt")),
      ).rejects.toBeInstanceOf(PathBoundaryError);
    });

    it("refuses a symbolic link that leaves the root", async () => {
      const { files } = connect();
      // The link looks innocent and lists as a directory; following it does not.
      await expect(files.readText(root(), "escape/secrets.txt")).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it("refuses to write through a link that leaves the root", async () => {
      const { files } = connect();
      await expect(
        files.writeText(root(), "escape/planted.txt", "owned"),
      ).rejects.toBeInstanceOf(PathBoundaryError);
    });
  });

  describe("connecting to a machine", () => {
    it("reports wrong credentials as such, instead of a protocol error", async () => {
      const { files } = connect({ secret: "wrong" });
      await expect(files.list(root())).rejects.toThrow(/rejected the credentials/);
    });

    it("reports a machine that is not listening", async () => {
      const { files } = connect({ port: 1 });
      await expect(files.list(root())).rejects.toThrow(
        /Nothing is listening|did not answer in time/,
      );
    });

    it("learns the host key the first time and reports it", async () => {
      const { files, learned } = connect();
      await files.list(root());

      expect(learned).toEqual([server.fingerprint]);
    });

    it("refuses a machine whose host key changed", async () => {
      const { files } = connect({ hostKeyFingerprint: "SHA256:somethingelse" });
      await expect(files.list(root())).rejects.toBeInstanceOf(SshHostKeyChangedError);
    });

    it("accepts the machine it already knows", async () => {
      const { files, learned } = connect({ hostKeyFingerprint: server.fingerprint });
      await files.list(root());

      // Nothing new to learn: it was already known.
      expect(learned).toEqual([]);
    });

    it("reuses one connection for many operations", async () => {
      const before = server.connectionCount();
      const { files } = connect();
      await Promise.all([
        files.list(root()),
        files.readText(root(), "notes.md"),
        files.list(root(), "src"),
      ]);
      await files.readText(root(), "notes.md");

      expect(server.connectionCount()).toBe(before + 1);
    });

    it("confirms a directory before a workspace is put on it", async () => {
      const { files } = connect();
      await expect(files.verifyDirectory("conn_1", join(directory, "src"))).resolves.toContain(
        "src",
      );
      await expect(
        files.verifyDirectory("conn_1", join(directory, "notes.md")),
      ).rejects.toBeInstanceOf(PathBoundaryError);
    });
  });
});
