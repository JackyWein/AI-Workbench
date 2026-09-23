import { createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import ssh2 from "ssh2";

const { utils } = ssh2;

/** A private key ready for a connection, or why it cannot be one. */
export type PreparedKey =
  | {
      readonly ok: true;
      /** The key as ssh2 reads it; still encrypted when it was. */
      readonly privateKey: string;
      /** True when the key needs its passphrase at every connection. */
      readonly encrypted: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /** The key is fine but locked: asking for the passphrase is the fix. */
      readonly needsPassphrase: boolean;
    };

const PUBLIC_KEY = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+)\s+AAAA/;
const PKCS8 = /^-----BEGIN (ENCRYPTED )?PRIVATE KEY-----/;

function refuse(error: string, needsPassphrase = false): PreparedKey {
  return { ok: false, error, needsPassphrase };
}

/**
 * Takes a private key the way people have one — pasted from a file, with
 * Windows line endings, indented by the page it was copied from, in the
 * PKCS#8 format OpenSSL writes — and makes it one ssh2 reads, or says
 * exactly what is wrong with it. A key is never decrypted to be stored: an
 * encrypted key stays encrypted and needs its passphrase at each connection.
 */
export function prepareKey(text: string, passphrase?: string | null): PreparedKey {
  const key = normalize(text);
  if (key === "\n") {
    return refuse("No private key was given.");
  }
  if (PUBLIC_KEY.test(key) || key.startsWith("---- BEGIN SSH2 PUBLIC KEY ----")) {
    return refuse(
      "This is a public key. Use the private key: the same file name without .pub (for example id_ed25519).",
    );
  }
  if (/^PuTTY-User-Key-File-3:/.test(key)) {
    return refuse(
      "PuTTY's key format 3 can't be read here. In PuTTYgen, load the key and use Conversions → Export OpenSSH key.",
    );
  }
  if (PKCS8.test(key)) {
    return fromPkcs8(key, passphrase ?? null);
  }
  return check(key, passphrase ?? null);
}

/** Whether ssh2 reads the key, and with which passphrase. */
function check(key: string, passphrase: string | null): PreparedKey {
  const locked = utils.parseKey(key);
  const needsPassphrase = locked instanceof Error && /no passphrase given/i.test(locked.message);
  if (needsPassphrase && !passphrase) {
    return refuse("This key is protected by a passphrase. Enter it to use the key.", true);
  }
  const parsed = needsPassphrase ? utils.parseKey(key, passphrase ?? undefined) : locked;
  if (parsed instanceof Error) {
    if (needsPassphrase) {
      return refuse("The passphrase doesn't open this key.", true);
    }
    if (/^PuTTY-User-Key-File-2:/.test(key)) {
      return refuse(
        "This PuTTY key can't be read here. In PuTTYgen, use Conversions → Export OpenSSH key.",
      );
    }
    return refuse(`This isn't a private key SSH can use (${parsed.message}).`);
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || !first.isPrivateKey()) {
    return refuse(
      "This is a public key. Use the private key: the same file name without .pub (for example id_ed25519).",
    );
  }
  return { ok: true, privateKey: key, encrypted: needsPassphrase };
}

/**
 * PKCS#8 ("BEGIN PRIVATE KEY"), which OpenSSL and many tools write, is not a
 * format ssh2 reads. RSA and EC keys become their traditional PEM, encrypted
 * again with the same passphrase when they had one; Ed25519 becomes the
 * OpenSSH format, which is only done for a key that was not encrypted.
 */
function fromPkcs8(key: string, passphrase: string | null): PreparedKey {
  const encrypted = key.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----");
  if (encrypted && !passphrase) {
    return refuse("This key is protected by a passphrase. Enter it to use the key.", true);
  }
  let object: KeyObject;
  try {
    object = createPrivateKey({
      key,
      format: "pem",
      ...(encrypted && passphrase ? { passphrase } : {}),
    });
  } catch {
    return encrypted
      ? refuse("The passphrase doesn't open this key.", true)
      : refuse("This isn't a private key SSH can use.");
  }
  const lock = encrypted && passphrase ? { cipher: "aes-256-cbc", passphrase } : {};
  switch (object.asymmetricKeyType) {
    case "rsa":
      return check(
        object.export({ type: "pkcs1", format: "pem", ...lock }).toString(),
        encrypted ? passphrase : null,
      );
    case "ec":
      return check(
        object.export({ type: "sec1", format: "pem", ...lock }).toString(),
        encrypted ? passphrase : null,
      );
    case "ed25519":
      if (encrypted) {
        return refuse(
          "This encrypted Ed25519 key is in a format SSH doesn't read. Convert it once with: ssh-keygen -p -f <key file>",
        );
      }
      return check(openSshEd25519(object), null);
    default:
      return refuse(`Keys of type ${object.asymmetricKeyType ?? "unknown"} can't be used for SSH here.`);
  }
}

/** An unencrypted Ed25519 key in OpenSSH's own format, which ssh2 reads. */
function openSshEd25519(object: KeyObject): string {
  const jwk = object.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d ?? "", "base64url");
  const publicKey = Buffer.from(jwk.x ?? "", "base64url");
  const string = (value: Buffer | string): Buffer => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const uint32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const publicBlob = Buffer.concat([string("ssh-ed25519"), string(publicKey)]);
  const check = randomBytes(4).readUInt32BE();
  let secret = Buffer.concat([
    uint32(check),
    uint32(check),
    string("ssh-ed25519"),
    string(publicKey),
    string(Buffer.concat([seed, publicKey])),
    string(""),
  ]);
  const padding: number[] = [];
  for (let index = 1; (secret.length + padding.length) % 8 !== 0; index += 1) {
    padding.push(index);
  }
  secret = Buffer.concat([secret, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    string("none"),
    string("none"),
    string(""),
    uint32(1),
    string(publicBlob),
    string(secret),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** One key, LF line endings, no indentation, one trailing newline. */
function normalize(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  return `${lines.join("\n").trim()}\n`;
}
