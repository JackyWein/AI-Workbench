import type { Client } from "@libsql/client";
import type { Logger } from "@ai-workbench/shared";
import { migrations } from "./migrations.js";

const MIGRATION_TABLE = "__migrations";

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

/**
 * Applies the drizzle-kit generated SQL that is bundled with the application.
 * Migrations are embedded rather than read from disk so a packaged build has no
 * dependency on a migrations folder path, and each one is applied inside a
 * transaction so a failure cannot leave a half-migrated database.
 */
export async function runMigrations(
  client: Client,
  logger?: Logger,
): Promise<MigrationResult> {
  // Cascading deletes are part of the schema, and SQLite enforces foreign keys
  // only when the connection asks for it.
  await client.execute("PRAGMA foreign_keys = ON");

  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
       id TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const existing = await client.execute(`SELECT id FROM ${MIGRATION_TABLE}`);
  const alreadyApplied = new Set(
    existing.rows.map((row) => String(row["id"] ?? "")),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }

    const statements = splitStatements(migration.sql);
    await client.batch(
      [
        ...statements,
        {
          sql: `INSERT INTO ${MIGRATION_TABLE} (id, applied_at) VALUES (?, ?)`,
          args: [migration.id, Date.now()],
        },
      ],
      "write",
    );

    applied.push(migration.id);
    logger?.info("Migration applied", {
      migration: migration.id,
      statements: statements.length,
    });
  }

  return { applied, skipped };
}

/** drizzle-kit separates statements with an explicit breakpoint comment. */
function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
