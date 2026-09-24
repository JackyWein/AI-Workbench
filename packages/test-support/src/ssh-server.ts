import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  close as closeFd,
  open as openFd,
  read as readFd,
  write as writeFd,
} from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import ssh2 from "ssh2";
import { generateEd25519KeyPair } from "./ssh-keys.js";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export interface SshTestServerOptions {
  /** The directory the server serves. Paths outside it are still served: the
   *  point of the tests is that the *client* refuses to leave its root. */
  readonly directory: string;
  readonly username?: string;
  readonly password?: string;
  /**
   * The host key to serve, in OpenSSH format. Supplying the same one again
   * makes the server the same machine as far as a client is concerned, which
   * is what a restart has to look like: a client that remembered the key must
   * still recognise it. Omitted, a fresh one is generated.
   */
  readonly hostKey?: string;
  /**
   * Public keys (OpenSSH format, as in authorized_keys) that may sign in as
   * the user, the way sshd checks them: the key must be listed and the
   * signature over the session must verify.
   */
  readonly authorizedKeys?: readonly string[];
}

export interface SshTestServer {
  readonly port: number;
  readonly host: string;
  readonly username: string;
  readonly password: string;
  /** The SHA-256 fingerprint a client will see, for host key assertions. */
  readonly fingerprint: string;
  /** The host key served, so a restart can present the same machine. */
  readonly hostKey: string;
  /** How many times a client authenticated, to prove connections are reused. */
  readonly connectionCount: () => number;
  close(): Promise<void>;
}

/**
 * A real SSH server with a real SFTP subsystem, backed by a real directory.
 *
 * The alternative — a hand-written fake of the SFTP client — would only prove
 * that the code agrees with our idea of the protocol. This proves it against
 * the protocol itself: key exchange, authentication, channels and every SFTP
 * opcode the client actually sends. That matters because most of what can go
 * wrong with a remote workspace lives exactly there, and because a machine
 * running sshd cannot be assumed in a test environment.
 */
export async function startSshTestServer(
  options: SshTestServerOptions,
): Promise<SshTestServer> {
  const root = resolve(options.directory);
  const username = options.username ?? "dev";
  const password = options.password ?? "s3cret";

  const hostKey = options.hostKey ?? generateEd25519KeyPair().private;
  const authorized = (options.authorizedKeys ?? []).map((text) => {
    const key = utils.parseKey(text);
    if (key instanceof Error) {
      throw key;
    }
    return key;
  });
  const methods: ssh2.AuthenticationType[] =
    authorized.length > 0 ? ["publickey", "password"] : ["password"];
  let connections = 0;
  const clients = new Set<{ end(): unknown }>();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === username && ctx.password === password) {
        connections += 1;
        ctx.accept();
        return;
      }
      if (ctx.method === "publickey" && ctx.username === username) {
        const offered = ctx.key;
        const known = authorized.find(
          (key) => key.type === offered.algo && key.getPublicSSH().equals(offered.data),
        );
        if (known && !ctx.signature) {
          // Asked whether this key would do, before signing with it.
          ctx.accept();
          return;
        }
        if (known && ctx.signature && ctx.blob && known.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) {
          connections += 1;
          ctx.accept();
          return;
        }
      }
      if (ctx.method === "none") {
        ctx.reject(methods, true);
        return;
      }
      ctx.reject(methods, false);
    });

    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          serveSftp(acceptSftp(), root);
        });
      });
    });
    // A client that goes away mid-handshake is normal in tests; it is not a
    // failure of the server.
    client.on("error", () => undefined);
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error) {
    throw parsedHostKey;
  }
  const fingerprint = `SHA256:${createSha256(parsedHostKey.getPublicSSH()).replace(/=+$/, "")}`;

  return {
    host: "127.0.0.1",
    port,
    username,
    password,
    fingerprint,
    hostKey,
    connectionCount: () => connections,
    // Closing ends the connections too; otherwise it waits until every
    // client lets go on its own, which an application may take minutes to do.
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        for (const client of clients) {
          client.end();
        }
      }),
  };
}

function createSha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("base64");
}

interface OpenFile {
  readonly fd: number;
  readonly path: string;
}

interface OpenDir {
  readonly entries: string[];
  sent: boolean;
  readonly path: string;
}

/** Maps the SFTP opcodes the client uses onto the local filesystem. */
function serveSftp(sftp: ssh2.SFTPWrapper, root: string): void {
  let nextHandle = 0;
  const files = new Map<number, OpenFile>();
  const directories = new Map<number, OpenDir>();

  const handleOf = (id: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id, 0);
    return buffer;
  };
  const idOf = (handle: Buffer): number => handle.readUInt32BE(0);

  /**
   * The server serves absolute paths as given. It only refuses to escape the
   * directory it was pointed at when the path is relative, which is what a
   * real server does too.
   */
  const absolute = (path: string): string => (isAbsolute(path) ? path : join(root, path));

  sftp.on("REALPATH", (id, path) => {
    const target = path === "." || path === "" ? root : absolute(path);
    realpath(target)
      .then((resolved) => {
        sftp.name(id, [{ filename: resolved, longname: resolved, attrs: emptyAttrs() }]);
      })
      .catch(() => {
        // A path that does not exist yet still has a canonical spelling, which
        // is what a real server answers here.
        const normalized = resolve(target);
        sftp.name(id, [
          { filename: normalized, longname: normalized, attrs: emptyAttrs() },
        ]);
      });
  });

  const answerStat = (id: number, path: string, followLinks: boolean): void => {
    const target = absolute(path);
    (followLinks ? stat(target) : lstat(target))
      .then((stats) => {
        sftp.attrs(id, {
          mode: stats.mode,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          atime: Math.floor(stats.atimeMs / 1000),
          mtime: Math.floor(stats.mtimeMs / 1000),
        });
      })
      .catch(() => sftp.status(id, STATUS_CODE.NO_SUCH_FILE));
  };

  sftp.on("STAT", (id, path) => answerStat(id, path, true));
  sftp.on("LSTAT", (id, path) => answerStat(id, path, false));

  sftp.on("FSTAT", (id, handle) => {
    const file = files.get(idOf(handle));
    if (!file) {
      sftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    answerStat(id, file.path, true);
  });

  sftp.on("OPENDIR", (id, path) => {
    const target = absolute(path);
    readdir(target)
      .then((entries) => {
        const handleId = nextHandle++;
        directories.set(handleId, { entries, sent: false, path: target });
        sftp.handle(id, handleOf(handleId));
      })
      .catch(() => sftp.status(id, STATUS_CODE.NO_SUCH_FILE));
  });

  sftp.on("READDIR", (id, handle) => {
    const directory = directories.get(idOf(handle));
    if (!directory) {
      sftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    if (directory.sent) {
      sftp.status(id, STATUS_CODE.EOF);
      return;
    }
    directory.sent = true;
    Promise.all(
      directory.entries.map(async (name) => {
        const stats = await lstat(join(directory.path, name));
        return {
          filename: name,
          longname: `${stats.isDirectory() ? "d" : "-"}rw-r--r-- 1 u g ${stats.size} ${name}`,
          attrs: {
            mode: stats.mode,
            uid: stats.uid,
            gid: stats.gid,
            size: stats.size,
            atime: Math.floor(stats.atimeMs / 1000),
            mtime: Math.floor(stats.mtimeMs / 1000),
          },
        };
      }),
    )
      .then((names) => sftp.name(id, names))
      .catch(() => sftp.status(id, STATUS_CODE.FAILURE));
  });

  sftp.on("OPEN", (id, path, flags) => {
    const target = absolute(path);
    let mode = constants.O_RDONLY;
    if (flags & OPEN_MODE.WRITE) {
      mode = flags & OPEN_MODE.READ ? constants.O_RDWR : constants.O_WRONLY;
    }
    if (flags & OPEN_MODE.CREAT) {
      mode |= constants.O_CREAT;
    }
    if (flags & OPEN_MODE.TRUNC) {
      mode |= constants.O_TRUNC;
    }
    if (flags & OPEN_MODE.APPEND) {
      mode |= constants.O_APPEND;
    }
    openFd(target, mode, 0o644, (error, fd) => {
      if (error) {
        sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      const handleId = nextHandle++;
      files.set(handleId, { fd, path: target });
      sftp.handle(id, handleOf(handleId));
    });
  });

  sftp.on("READ", (id, handle, offset, length) => {
    const file = files.get(idOf(handle));
    if (!file) {
      sftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    const buffer = Buffer.alloc(length);
    readFd(file.fd, buffer, 0, length, offset, (error, read) => {
      if (error) {
        sftp.status(id, STATUS_CODE.FAILURE);
        return;
      }
      if (read === 0) {
        sftp.status(id, STATUS_CODE.EOF);
        return;
      }
      sftp.data(id, buffer.subarray(0, read));
    });
  });

  sftp.on("WRITE", (id, handle, offset, data) => {
    const file = files.get(idOf(handle));
    if (!file) {
      sftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    writeFd(file.fd, data, 0, data.length, offset, (error) => {
      sftp.status(id, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
    });
  });

  sftp.on("CLOSE", (id, handle) => {
    const handleId = idOf(handle);
    const file = files.get(handleId);
    if (file) {
      files.delete(handleId);
      closeFd(file.fd, () => sftp.status(id, STATUS_CODE.OK));
      return;
    }
    directories.delete(handleId);
    sftp.status(id, STATUS_CODE.OK);
  });

  // Permission and timestamp changes are accepted and ignored: the client
  // under test does not rely on them, and failing them would fail its writes.
  sftp.on("SETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));
  sftp.on("FSETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));

  sftp.on("end", () => {
    for (const file of files.values()) {
      closeFd(file.fd, () => undefined);
    }
    files.clear();
    directories.clear();
  });
}

function emptyAttrs(): ssh2.Attributes {
  return { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
}

/** True when `candidate` is inside `root`, for assertions in tests. */
export function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

