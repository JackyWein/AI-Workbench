/**
 * The encryption a credential store relies on. Implementations are expected to
 * be backed by the operating system's own secret storage (spec §57); the
 * in-memory one exists only so the surrounding logic can be tested.
 */
export interface SecretEncryption {
  /** False when the platform has no usable secret storage. */
  isAvailable(): boolean;
  /** A human-readable name of the backend, for display and diagnosis. */
  describe(): string;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class EncryptionUnavailableError extends Error {
  constructor(detail: string) {
    super(`Secure storage is not available: ${detail}`);
    this.name = "EncryptionUnavailableError";
  }
}

/**
 * Test double. It does not encrypt anything and says so, so it can never be
 * mistaken for real protection.
 */
export class InMemoryEncryption implements SecretEncryption {
  readonly #available: boolean;

  constructor(available = true) {
    this.#available = available;
  }

  isAvailable(): boolean {
    return this.#available;
  }

  describe(): string {
    return "in-memory (no encryption, for tests only)";
  }

  encrypt(value: string): Buffer {
    return Buffer.from(value, "utf8");
  }

  decrypt(value: Buffer): string {
    return value.toString("utf8");
  }
}
