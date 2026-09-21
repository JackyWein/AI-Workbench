# 2. SQLite via libsql, with Drizzle and embedded migrations

Date: 2026-09-21
Status: Accepted

## Context

The application needs local, durable, relational persistence, and the database
must open inside Electron without friction. `better-sqlite3` is the common
choice but uses the V8 API, so it must be recompiled for every Electron
version — a recurring failure mode for contributors and for packaging.

## Decision

Use SQLite through `@libsql/client` with `drizzle-orm/libsql`. Generate
migrations with drizzle-kit and embed the generated SQL into the bundle,
applying it with a small runner that records applied ids in `__migrations`.

## Consequences

- The client is an N-API module, so it loads in Electron without a rebuild
- Migrations travel with the bundle; a packaged build has no dependency on a
  migrations folder path being correct at runtime
- Each migration runs in one transaction, so a half-applied migration cannot
  exist
- Adding a migration is a two-step ritual: generate, then list it in
  `migrations.ts` (documented in `DEVELOPMENT.md`)
- `PRAGMA foreign_keys = ON` must be set per connection; the runner does it

## Alternatives considered

- **better-sqlite3**: fastest, but requires `@electron/rebuild` per Electron
  version
- **node:sqlite**: built in, but Drizzle has no driver for it yet
- **Drizzle's own migrator**: would require shipping and resolving a migrations
  directory at runtime
