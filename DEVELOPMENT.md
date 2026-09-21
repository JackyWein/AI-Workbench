# Development

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- Linux desktop builds additionally need the usual Electron runtime libraries

## Setup

```bash
pnpm install
```

`electron` downloads its binary on install. If that step was skipped by a
restrictive install policy, run `node node_modules/electron/install.js` once.

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Starts Electron with hot reloading |
| `pnpm build` | Production build of main, preload and renderer |
| `pnpm typecheck` | Strict TypeScript over Node and web projects |
| `pnpm lint` | ESLint across the workspace |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm verify:app` | Starts the built app headlessly and checks it really works |
| `pnpm verify` | lint + typecheck + test + build + verify:app |
| `pnpm db:generate` | Regenerates SQL migrations from the Drizzle schema |

Run `pnpm verify` before considering a change finished. `PROGRESS.md` may only
be updated from criteria that this command actually proves.

## What `verify:app` does

It starts the real built application twice against one throwaway user-data
directory and drives the actual renderer:

1. the window opens and the React shell mounts
2. the renderer reaches the main process through the preload bridge
3. a workspace and a session are created, a message streams back, the
   conversation is persisted and usage is reported
4. command palette, usage popover, settings and providers views respond
5. after a restart the conversation is still there and the provider session is
   resumed instead of recreated

It uses Xvfb when no display is present, so it also runs in CI and containers.

## Repository layout

```text
apps/
  desktop/            Electron main, preload and React renderer
packages/
  shared/             Domain models, IPC contract, domain events, log contract
  core/               WorkspaceManager, SessionManager, ProviderManager,
                      UsageService, SettingsService, EventBus, logging, paths
  database/           Drizzle schema, libsql client, embedded migrations
  providers/base/     Provider adapter contract, registry, error normalization
  providers/mock/     MockProvider used for development and tests
  ui/                 Design tokens
scripts/              Verification scripts
docs/adr/             Architecture decision records
```

Workspace packages are consumed as TypeScript source and bundled by the app, so
there is no separate build step per package.

## Adding a database migration

1. Change `packages/database/src/schema.ts`
2. `pnpm db:generate`
3. Add the generated file to `packages/database/src/migrations.ts`

Migrations are embedded in the bundle, so a packaged build does not depend on a
migrations folder being present at runtime.

## Conventions

- Strict TypeScript, no unjustified `any`
- Small modules, explicit schemas, dependency injection over globals
- No provider names in generic code; behaviour comes from capabilities
- Renderer reaches the system only through the typed IPC contract
- Colours, spacing, radii and durations come from the design tokens
