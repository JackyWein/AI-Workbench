# Development

## Requirements

- Node.js 22 or newer (the tools themselves run on Node)
- bun 1.3 or newer (installs dependencies and runs the scripts)
- Linux desktop builds additionally need the usual Electron runtime libraries

## Setup

```bash
bun install
```

`electron` downloads its binary on first start if it is not there yet; to
fetch it ahead of time, run `node node_modules/electron/install.js` once.

If `bun run lint` fails with `Cannot find module …/uri.all.js`, the local
install is damaged (a clean one has that file): remove `node_modules` and
run `bun install` again.

## Everyday commands

| Command | What it does |
|---|---|
| `bun run dev` | Starts Electron with hot reloading |
| `bun run build` | Production build of main, preload and renderer |
| `bun run typecheck` | Strict TypeScript over Node and web projects |
| `bun run lint` | ESLint across the workspace |
| `bun run test` | Vitest unit and integration tests |
| `bun run verify:app` | Starts the built app headlessly and checks it really works |
| `bun run verify:memory` | Exercises the bundled Markdown memory MCP server through Electron Node mode |
| `bun run verify:lockfile` | Fails if the lockfile and any `package.json` disagree |
| `bun run verify` | lockfile + lint + typecheck + test + build + verify:memory + verify:app |
| `bun run db:generate` | Regenerates SQL migrations from the Drizzle schema |

Run `bun run verify` before considering a change finished. `PROGRESS.md` may only
be updated from criteria that this command actually proves.

The shared Obsidian vault setup and tool boundaries are in
`docs/shared-memory.md`.

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

## Using a real provider

The application looks for the provider CLIs on PATH. Open **Providers** to see
what was found, with version and authentication state. If a tool lives somewhere
unusual, set its executable path there; the change applies immediately.

The Codex and Gemini profiles are starting points that have not been verified
against those tools, which the provider screen states plainly. If a turn fails,
correct the path and arguments there rather than editing code.

To verify an installed provider end to end — this spends real quota, so it is
never part of the normal test run:

```bash
AI_WORKBENCH_REAL_PROVIDER=1 bun run test
```

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
  providers/cli/      Generic profile-driven adapter for command line providers
  providers/transports/cli/  Reusable process transport and executable discovery
  ui/                 Design tokens
scripts/              Verification scripts
docs/adr/             Architecture decision records
```

Workspace packages are consumed as TypeScript source and bundled by the app, so
there is no separate build step per package.

## Adding a database migration

1. Change `packages/database/src/schema.ts`
2. `bun run db:generate`
3. Add the generated file to `packages/database/src/migrations.ts`

Migrations are embedded in the bundle, so a packaged build does not depend on a
migrations folder being present at runtime.

## Themes

A theme is chosen together with a mode. The `theme` setting is one of
Quiet, Atelier, Mission Control, Playground, Aurora and Swiss; the `mode`
setting is light, dark or the system's (the default), switched under
Settings, in the command palette or with the toggle in the sidebar. `resolveTheme` in `packages/ui`
turns both into the name the stylesheets use: Quiet is `dark` or `light`,
every other theme `<theme>-light` or `<theme>-dark`, set as `data-theme`.
Settings written before the two were split (0.0.6 and earlier, where the
mode was part of the theme) are read through `upgradeStoredSettings` in
`packages/shared`. A theme is only token values, so a new one is mostly CSS:

- `packages/ui/src/tokens.css` — every token, Quiet's values, and the values
  made from the others (radii from `--radius-scale`, the sidebar's palette,
  the terminal's ground). Themes are keyed on `data-theme` of any element,
  not only the root, which is how a picker swatch shows a theme without
  switching the window.
- `packages/ui/src/themes.css` — the other themes. Each has a block matched
  with `[data-theme|="<theme>"]` (both modes) holding its typefaces, shape
  (`--radius-scale`, `--radius-pill`), the outline of grouped surfaces
  (`--card-*`) and the colours of its first mode, the island's palette
  included, and a block for `<theme>-light` or `<theme>-dark` with the
  colours of the other mode.
- `packages/ui/src/fonts.css` — the typefaces, from `@fontsource` packages,
  Latin only, bundled into the app (the page's policy loads nothing from
  outside).
- `apps/desktop/src/renderer/themes.css` — where the character tokens apply
  (display face, labels, grouped surfaces, the sidebar's palette) and each
  theme's touches that a token cannot express, written with `|=` and
  tokens so they hold in both modes.
- `apps/desktop/src/renderer/island/island.css` → themes — the island's
  character per theme (outline, lift, bubble shape, faces), through
  `--island-edge`, `--island-drop` and `--island-bubble-radius`.
- `apps/desktop/src/renderer/lib/themes.ts` — the names the picker shows;
  the ids themselves are the `theme` setting's enum in `packages/shared`.

`packages/ui/src/__tests__/themes.test.ts` resolves every theme in both
modes from the CSS and fails when a text colour does not read on its ground
(WCAG contrast), in the window, the sidebar, code blocks, the terminal and
the island. The startup check picks every theme in both modes in Settings
and checks the rendered window and its colour scheme, that its typeface
loaded, and that the island followed.

## Conventions

- Strict TypeScript, no unjustified `any`
- Small modules, explicit schemas, dependency injection over globals
- No provider names in generic code; behaviour comes from capabilities
- Renderer reaches the system only through the typed IPC contract
- Colours, fonts, spacing, radii, shadows and durations come from the design
  tokens; a raw value in a component is a theme that cannot change it
