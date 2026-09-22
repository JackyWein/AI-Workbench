import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretEncryption } from "@ai-workbench/credentials";

/**
 * Secret storage for the headless verification run, and for nothing else.
 *
 * The application always prefers the operating system's own secret storage.
 * A container has none — no keyring, no keychain — so on such a machine the
 * checks that involve a stored secret could not run at all, and the parts of
 * the application that need one would go unverified.
 *
 * This fills that gap without weakening anything. It really encrypts, with a
 * random AES-256-GCM key kept beside the check's throwaway database, so a
 * secret is never written down readable and the assertion that the
 * application does not fall back to plaintext keeps its meaning. It is
 * selected only when the verification harness is running *and* the platform
 * has nothing better, and it says what it is wherever the backend is shown.
 */
export class CheckEncryption implements SecretEncryption {
  readonly #key: Buffer;

  constructor(dataDirectory: string) {
    this.#key = readOrCreateKey(join(dataDirectory, "check-secret-key"));
  }

  isAvailable(): boolean {
    return true;
  }

  describe(): string {
    return "verification run (AES-256-GCM, key beside the check database)";
  }

  encrypt(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(value: Buffer): string {
    const iv = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
  }
}

/**
 * The key survives the restart between the two phases, because the second one
 * has to read what the first one stored — exactly as the real backend does.
 */
function readOrCreateKey(path: string): Buffer {
  try {
    const existing = readFileSync(path);
    if (existing.length === 32) {
      return existing;
    }
  } catch {
    // Not there yet; one is made below.
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}
