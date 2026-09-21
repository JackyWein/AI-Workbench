import { randomUUID } from "node:crypto";
import type { Logger } from "@ai-workbench/shared";
import {
  EncryptionUnavailableError,
  type SecretEncryption,
} from "./store.js";

/** What the rest of the application is allowed to know about a credential. */
export interface CredentialDescriptor {
  /** The reference other records store instead of the secret itself. */
  readonly reference: string;
  readonly label: string;
  /** Free-form grouping, e.g. the service an account belongs to. */
  readonly kind: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CredentialRecord extends CredentialDescriptor {
  readonly secret: Buffer;
}

/** Persistence for encrypted credentials. The manager never sees plaintext. */
export interface CredentialStorage {
  list(): Promise<CredentialRecord[]>;
  get(reference: string): Promise<CredentialRecord | null>;
  put(record: CredentialRecord): Promise<void>;
  delete(reference: string): Promise<boolean>;
}

export class InMemoryCredentialStorage implements CredentialStorage {
  readonly #records = new Map<string, CredentialRecord>();

  async list(): Promise<CredentialRecord[]> {
    return [...this.#records.values()];
  }

  async get(reference: string): Promise<CredentialRecord | null> {
    return this.#records.get(reference) ?? null;
  }

  async put(record: CredentialRecord): Promise<void> {
    this.#records.set(record.reference, record);
  }

  async delete(reference: string): Promise<boolean> {
    return this.#records.delete(reference);
  }
}

export interface CredentialManagerOptions {
  readonly encryption: SecretEncryption;
  readonly storage: CredentialStorage;
  readonly logger: Logger;
}

/**
 * Stores secrets encrypted by the operating system and hands out references
 * (spec §57). Nothing outside this class deals in secret values: configuration,
 * the database and the renderer only ever carry a reference.
 */
export class CredentialManager {
  readonly #encryption: SecretEncryption;
  readonly #storage: CredentialStorage;
  readonly #logger: Logger;

  constructor(options: CredentialManagerOptions) {
    this.#encryption = options.encryption;
    this.#storage = options.storage;
    this.#logger = options.logger.child("PLUGIN");
  }

  isAvailable(): boolean {
    return this.#encryption.isAvailable();
  }

  describeBackend(): string {
    return this.#encryption.describe();
  }

  /** Stores a secret and returns its reference. */
  async store(input: {
    label: string;
    kind: string;
    secret: string;
    reference?: string;
  }): Promise<CredentialDescriptor> {
    this.#assertAvailable();

    const now = new Date();
    const existing = input.reference
      ? await this.#storage.get(input.reference)
      : null;

    const record: CredentialRecord = {
      reference: input.reference ?? `cred_${randomUUID()}`,
      label: input.label,
      kind: input.kind,
      secret: this.#encryption.encrypt(input.secret),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#storage.put(record);
    // The label and kind are safe to log; the secret never is.
    this.#logger.info("Credential stored", {
      reference: record.reference,
      kind: record.kind,
    });

    return toDescriptor(record);
  }

  /** Resolves a reference to its secret. Main process only. */
  async resolve(reference: string): Promise<string | null> {
    const record = await this.#storage.get(reference);
    if (!record) {
      return null;
    }
    this.#assertAvailable();
    try {
      return this.#encryption.decrypt(record.secret);
    } catch (error) {
      this.#logger.error("Credential could not be decrypted", {
        reference,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async has(reference: string): Promise<boolean> {
    return (await this.#storage.get(reference)) !== null;
  }

  /** Lists credentials without their secrets. */
  async list(): Promise<CredentialDescriptor[]> {
    return (await this.#storage.list()).map(toDescriptor);
  }

  async delete(reference: string): Promise<boolean> {
    const deleted = await this.#storage.delete(reference);
    if (deleted) {
      this.#logger.info("Credential deleted", { reference });
    }
    return deleted;
  }

  #assertAvailable(): void {
    if (!this.#encryption.isAvailable()) {
      throw new EncryptionUnavailableError(this.#encryption.describe());
    }
  }
}

function toDescriptor(record: CredentialRecord): CredentialDescriptor {
  return {
    reference: record.reference,
    label: record.label,
    kind: record.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
