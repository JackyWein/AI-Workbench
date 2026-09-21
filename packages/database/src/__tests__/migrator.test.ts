import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../client.js";
import { runMigrations } from "../migrator.js";
import { migrations } from "../migrations.js";

describe("migrations", () => {
  let directory: string;
  let handle: DatabaseHandle;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-workbench-db-"));
    handle = createDatabase({ file: join(directory, "test.db") });
  });

  afterEach(async () => {
    handle.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("ships at least one generated migration", () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.sql).toContain("CREATE TABLE");
  });

  it("creates the expected tables", async () => {
    const result = await runMigrations(handle.client);
    expect(result.applied).toEqual(migrations.map((entry) => entry.id));

    const tables = await handle.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.rows.map((row) => String(row["name"]));
    expect(names).toEqual(
      expect.arrayContaining([
        "chat_messages",
        "provider_configs",
        "sessions",
        "settings",
        "workspaces",
      ]),
    );
  });

  it("is idempotent on a second run", async () => {
    await runMigrations(handle.client);
    const second = await runMigrations(handle.client);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrations.map((entry) => entry.id));
  });

  it("enforces foreign keys so deletes cascade", async () => {
    await runMigrations(handle.client);
    const pragma = await handle.client.execute("PRAGMA foreign_keys");
    expect(Number(pragma.rows[0]?.["foreign_keys"])).toBe(1);
  });
});
