import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import ssh2 from "ssh2";
import {
  generateEd25519KeyPair,
  makeTempDirectory,
  removeTempDirectory,
  startSshTestServer,
  type SshTestServer,
} from "@ai-workbench/test-support";
import {
  SshConnectionPool,
  SshWorkspaceFileSystem,
  agentPath,
  prepareKey,
  remoteRoot,
  type SshTarget,
} from "../index.js";

const { utils } = ssh2;

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

const plain = generateEd25519KeyPair();
const locked = generateEd25519KeyPair({
  passphrase: "correct horse",
  cipher: "aes256-ctr",
  rounds: 16,
});
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPkcs8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const rsaPkcs8Locked = rsa.privateKey
  .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" })
  .toString();
const ed = generateKeyPairSync("ed25519");
const edPkcs8 = ed.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** The public half of a key in authorized_keys form. */
function publicOf(privateKey: string, passphrase?: string): string {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    throw parsed;
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")}`;
}

/** A key as prepareKey leaves it, for keys ssh2 cannot read directly. */
function converted(text: string): string {
  const prepared = prepareKey(text);
  if (!prepared.ok) {
    throw new Error(prepared.error);
  }
  return prepared.privateKey;
}

describe("keys the tests make", () => {
  // ssh2 writes about one Ed25519 key in two hundred that it cannot read
  // back; the tests used to fail at random on such a key.
  it("always read back", () => {
    for (let index = 0; index < 400; index += 1) {
      const pair = generateEd25519KeyPair();
      expect(utils.parseKey(pair.public)).not.toBeInstanceOf(Error);
      expect(utils.parseKey(pair.private)).not.toBeInstanceOf(Error);
    }
  });
});

describe("reading a private key", () => {
  it("takes an OpenSSH key as it is", () => {
    expect(prepareKey(plain.private)).toMatchObject({ ok: true, encrypted: false });
  });

  it("takes a key pasted with Windows line endings and indentation", () => {
    const messy = `\n  ${plain.private.replace(/\n/g, "\r\n  ")}  \r\n`;
    const prepared = prepareKey(messy);
    expect(prepared).toMatchObject({ ok: true });
    expect(prepared.ok && prepared.privateKey).toBe(`${plain.private.trim()}\n`);
  });

  it("asks for the passphrase of a locked key, and checks it", () => {
    expect(prepareKey(locked.private)).toMatchObject({ ok: false, needsPassphrase: true });
    expect(prepareKey(locked.private, "wrong")).toEqual({
      ok: false,
      error: "The passphrase doesn't open this key.",
      needsPassphrase: true,
    });
    // It stays encrypted: the passphrase is needed at every connection.
    const opened = prepareKey(locked.private, "correct horse");
    expect(opened).toMatchObject({ ok: true, encrypted: true });
    expect(opened.ok && opened.privateKey).toBe(`${locked.private.trim()}\n`);
  });

  it("says so when it is given the public key", () => {
    const refused = prepareKey(plain.public);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/public key/);
  });

  it("turns OpenSSL's PKCS#8 keys into ones SSH reads", () => {
    const fromRsa = prepareKey(rsaPkcs8);
    expect(fromRsa).toMatchObject({ ok: true, encrypted: false });
    expect(fromRsa.ok && fromRsa.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

    const fromEd = prepareKey(edPkcs8);
    expect(fromEd).toMatchObject({ ok: true });
    // The same key: the public half matches the one Node derived.
    const derived = ed.publicKey.export({ format: "jwk" }).x ?? "";
    const parsed = fromEd.ok ? utils.parseKey(fromEd.privateKey) : new Error("refused");
    expect(parsed instanceof Error).toBe(false);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    expect(key && !(key instanceof Error) && key.getPublicSSH().subarray(-32).toString("base64url")).toBe(
      derived,
    );
  });

  it("keeps an encrypted PKCS#8 key encrypted", () => {
    expect(prepareKey(rsaPkcs8Locked)).toMatchObject({ ok: false, needsPassphrase: true });
    const opened = prepareKey(rsaPkcs8Locked, "pw");
    expect(opened).toMatchObject({ ok: true, encrypted: true });
    expect(opened.ok && opened.privateKey).toMatch(/ENCRYPTED/);
  });

  it("explains PuTTY's newer format instead of failing on it", () => {
    const refused = prepareKey("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n");
    expect(!refused.ok && refused.error).toMatch(/Export OpenSSH key/);
  });

  it("finds the Windows OpenSSH agent when no socket is named", () => {
    expect(agentPath({ SSH_AUTH_SOCK: "/tmp/agent.sock" }, "linux")).toBe("/tmp/agent.sock");
    expect(agentPath({}, "linux")).toBeNull();
    expect(agentPath({}, "win32")).toBe("\\\\.\\pipe\\openssh-ssh-agent");
  });
});

describe.runIf(process.platform !== "win32")("signing in with a key", () => {
  let directory: string;
  let server: SshTestServer;
  const pools: SshConnectionPool[] = [];

  beforeAll(async () => {
    directory = await makeTempDirectory("ssh-keys");
    server = await startSshTestServer({
      directory,
      authorizedKeys: [
        publicOf(plain.private),
        publicOf(locked.private, "correct horse"),
        publicOf(converted(rsaPkcs8)),
        publicOf(converted(edPkcs8)),
      ],
    });
  });

  afterEach(() => {
    for (const pool of pools.splice(0)) {
      pool.dispose();
    }
  });

  afterAll(async () => {
    await server.close();
    await removeTempDirectory(directory);
  });

  const listWith = async (secret: string, passphrase: string | null = null): Promise<unknown> => {
    const pool = new SshConnectionPool({ logger: nullLogger, connectTimeoutMs: 10_000 });
    pools.push(pool);
    const target: SshTarget = {
      id: "conn_key",
      host: server.host,
      port: server.port,
      username: server.username,
      auth: "key",
      secret,
      passphrase,
      hostKeyFingerprint: null,
    };
    const files = new SshWorkspaceFileSystem({
      logger: nullLogger,
      pool,
      resolveTarget: async () => target,
    });
    return files.list(remoteRoot("conn_key", directory));
  };

  it("signs in with an OpenSSH key", async () => {
    await expect(listWith(plain.private)).resolves.toBeDefined();
  });

  it("signs in with a key pasted with Windows line endings", async () => {
    await expect(listWith(plain.private.replace(/\n/g, "\r\n"))).resolves.toBeDefined();
  });

  it("signs in with a passphrase-protected key and its passphrase", async () => {
    await expect(listWith(locked.private, "correct horse")).resolves.toBeDefined();
  });

  it("says a locked key needs its passphrase instead of failing the sign-in", async () => {
    await expect(listWith(locked.private)).rejects.toThrow(/protected by a passphrase/);
  });

  it("signs in with PKCS#8 keys, RSA and Ed25519", async () => {
    await expect(listWith(rsaPkcs8)).resolves.toBeDefined();
    await expect(listWith(edPkcs8)).resolves.toBeDefined();
  });

  it("reports a key the machine does not know as rejected credentials", async () => {
    const stranger = generateEd25519KeyPair().private;
    await expect(listWith(stranger)).rejects.toThrow(/rejected the credentials/);
  });
});
