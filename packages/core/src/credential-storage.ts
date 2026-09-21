import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { credentials } from "@ai-workbench/database";
import type { CredentialRecord, CredentialStorage } from "@ai-workbench/credentials";

/**
 * Stores encrypted credentials in the application database. The bytes here are
 * whatever the operating system's secret storage produced, so the database on
 * its own reveals nothing (spec §57).
 */
export class SqlCredentialStorage implements CredentialStorage {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async list(): Promise<CredentialRecord[]> {
    return (await this.#db.select().from(credentials)).map(toRecord);
  }

  async get(reference: string): Promise<CredentialRecord | null> {
    const [row] = await this.#db
      .select()
      .from(credentials)
      .where(eq(credentials.reference, reference))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async put(record: CredentialRecord): Promise<void> {
    await this.#db
      .insert(credentials)
      .values({
        reference: record.reference,
        label: record.label,
        kind: record.kind,
        secret: record.secret,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: credentials.reference,
        set: {
          label: record.label,
          kind: record.kind,
          secret: record.secret,
          updatedAt: record.updatedAt,
        },
      });
  }

  async delete(reference: string): Promise<boolean> {
    const existing = await this.get(reference);
    if (!existing) {
      return false;
    }
    await this.#db.delete(credentials).where(eq(credentials.reference, reference));
    return true;
  }
}

function toRecord(row: {
  reference: string;
  label: string;
  kind: string;
  secret: Buffer;
  createdAt: Date;
  updatedAt: Date;
}): CredentialRecord {
  return {
    reference: row.reference,
    label: row.label,
    kind: row.kind,
    secret: row.secret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
