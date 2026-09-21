import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export type Database = LibSQLDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly client: Client;
  close(): void;
}

export interface CreateDatabaseOptions {
  /**
   * Absolute path to the SQLite file, or ":memory:" for an ephemeral database
   * used by tests.
   */
  readonly file: string;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const url =
    options.file === ":memory:" ? ":memory:" : `file:${options.file}`;
  const client = createClient({ url });
  const db = drizzle(client, { schema });

  return {
    db,
    client,
    close: () => {
      client.close();
    },
  };
}

export { schema };
