# AGENTS.md — AI Workbench

Instructions for any AI agent working in this repo. Read this first, then the
docs listed under "Standard workflow". This file is the 10-minute onboarding;
`AI_WORKBENCH.md` is the spec, `PROGRESS.md` the verified state.

## Repo map

```text
apps/desktop/                  Electron app: main, preload, React renderer
  src/main/                    Main process (services, windows, tray, island-controller)
  src/main/startup-check.ts    Headless self-check driven by verify:app (create + resume)
  src/renderer/                React UI (chat, providers, teams, island/, command palette)
  src/preload/                 Typed IPC bridge (renderer has NO direct Node access)
  out/main/index.js            Built main entry (verify:app runs this)
packages/
  shared/                      Domain models, IPC contract (shared/ipc/contract.ts),
                               domain events, log contract
  core/                        WorkspaceManager, SessionManager, ProviderManager,
                               UsageService, SettingsService, EventBus, logging, paths
  database/                    Drizzle schema (src/schema.ts), libsql client,
                               embedded migrations (src/migrations.ts)
  providers/base/              Adapter contract, registry, error normalization
  providers/mock/              MockProvider (+ mock/team-reply.ts) for dev/tests
  providers/cli/               Generic profile-driven CLI adapter
  providers/claude|codex|gemini|opencode|openai-compatible/  Provider profiles
  providers/transports/cli/    Reusable process transport + executable discovery
  status/                      StatusAttentionService, priority engine, attention queue
  team/                        TeamOrchestrator, team service, prompt, mailbox/state
  terminal/                    Terminal manager (node-pty)
  workspace-fs|workspace-git/  Safe filesystem layer, git status/diff
  mcp|plugins|skills|credentials|ui|test-support/  MCP manager, plugins, skills,
                               credential manager, design tokens, test helpers
scripts/verify-app.sh          Headless end-to-end check (two phases, see verify guide)
scripts/fix-pty-permissions.mjs  postinstall: fixes node-pty spawn-helper bit
docs/adr/                      Architecture decision records
docs/verify-guide.md           What pnpm verify proves, per platform
```

Workspace packages are consumed as TypeScript source and bundled by the app —
no per-package build step.

## The 3 iron rules

1. **Provider-independent.** No `if (providerId === …)` outside an adapter
   (`packages/providers/*`). Generic services branch on capabilities; UI enables
   features from capabilities; every provider normalizes into the same event
   stream. Provider identity and transport are separate abstractions.
   (Source: `CLAUDE.md` rules 1–4, 14.)
2. **Invent nothing.** Never invent provider usage numbers, model lists, or
   project progress. If a provider/tool cannot report something, the app says
   "unknown"/"unverified" instead of guessing. Model lists come only from the
   tool itself (generic `modelsArgs` discovery, e.g. `opencode models`) or from
   the Providers screen — never hardcoded.
   (Source: `CLAUDE.md` rules 13–14; `HANDOFF.md` "Do not invent provider facts".)
3. **PROGRESS only from `pnpm verify` evidence.** `PROGRESS.md` checkboxes move
   only when a `pnpm verify` run (incl. `verify:app` where required) actually
   proves the criterion. A regression unchecks its criterion. No green claim
   without a run; no ticking from code reading.
   (Source: `CLAUDE.md` rule 10; `PROGRESS.md` "How this file is verified".)

Also binding: typed validated IPC only; no secrets in plaintext or in the
renderer/logs; no browser cookie/session scraping; quiet UI
(`app.css` + `packages/ui` tokens, no emoji icons, no card grids);
never knowingly leave the repo broken.

## Standard workflow

1. **Read:** `AI_WORKBENCH.md` (spec) → `PROGRESS.md` ("How this file is
   verified" + "What is deliberately not ticked" + current goal section) →
   `HANDOFF.md` (where work stopped, what bites). Skim `CLAUDE.md` (15 rules)
   and `DEVELOPMENT.md` (commands, layout).
2. **Plan** the smallest vertical working slice; no broad unfinished scaffolding.
3. **Implement:** generic logic in `packages/core|shared|…`, provider specifics
   only in `packages/providers/*`, UI via capabilities + design tokens.
   DB change? `packages/database/src/schema.ts` → `pnpm db:generate` → register
   in `packages/database/src/migrations.ts`.
4. **Verify:** `pnpm verify` is the gate (table below). On Windows expect
   `verify:app` to fail for platform reasons — state that explicitly, do not
   fake it (see "Traps").
5. **Update:** `HANDOFF.md` (what changed, what is open, next steps).
   Tick `PROGRESS.md` ONLY for criteria the verify run proved.

## Commands

| Command | What it does | When |
|---|---|---|
| `pnpm install` | Install + postinstall fixes node-pty bit | After clone / lockfile change |
| `pnpm dev` | Electron with hot reload | Manual UI checks |
| `pnpm typecheck` | Strict TS (`tsconfig.node.json` + `tsconfig.web.json`) | After any code change |
| `pnpm lint` | ESLint over workspace | After any code change |
| `pnpm test` | Vitest unit + integration (~210 tests) | After any code change |
| `pnpm build` | electron-vite production build | Before verify:app / when done |
| `pnpm verify:app` | Headless real-app check, 2 phases (create + resume) | E2E proof; needs display/Xvfb |
| `pnpm verify:lockfile` | Fails if lockfile disagrees with any package.json | Runs first inside verify |
| `pnpm verify` | lockfile + lint + typecheck + test + build + verify:app | THE gate before "done" |
| `pnpm db:generate` | Regenerate SQL migrations from Drizzle schema | After schema change |
| `AI_WORKBENCH_REAL_PROVIDER=1 pnpm test` | E2E vs installed Claude Code CLI (opt-in) | Manual only, spends quota |

Details: `docs/verify-guide.md`. Engine pins: Node ≥ 22, pnpm 10.33
(`package.json`).

## Traps (read before debugging)

- **Windows: no bash/Xvfb.** `pnpm verify:app` = `bash scripts/verify-app.sh` and
  fails on plain Windows (`REGDB_E_CLASSNOTREG`, no Xvfb). On Windows only
  `typecheck + lint + test + build` are expected green; `verify:app` must run on
  Linux/macOS. Never mark E2E proven from a Windows box.
- **node-pty noise.** `scripts/fix-pty-permissions.mjs` (postinstall) fixes the
  `spawn-helper` executable bit — do not remove it, or terminals fail with
  `posix_spawnp failed` on macOS/Linux. Windows CI slowness + `AttachConsole`
  crashes around node-pty are known (`vitest.config.ts` uses 30 s timeouts).
- **Single-instance lock false-pass (fixed, stay alert).** The startup check
  once exited 0 by grabbing Electron's single-instance lock instead of running
  checks. It now takes no lock, every check has a timeout, and zero outcomes =
  failure (`scripts/verify-app.sh` `run_phase`). A suspiciously fast pass with
  no `PASS` lines means a stray `electron` process — kill it, rerun.
- **Lockfile frozen.** CI installs with `--frozen-lockfile`; a stale
  `pnpm-lock.yaml` fails packaging before any test runs. `pnpm verify:lockfile`
  (= `pnpm install --lockfile-only --frozen-lockfile`) runs first in verify —
  keep the lockfile in step after any dependency change.
- **Headless ≠ manual.** Native folder dialog (G1 "choose working directory"),
  OS secret-storage round trip, tray on headless, and final visual sign-off
  cannot be proven by `verify:app` — they stay unticked until a desktop run.
- **Spec references:** team protocol vs orchestrator (`TEAM_SYSTEM.md`),
  island behavior (`STATUS_ISLAND.md`), provider profiles' verified/unverified
  state (`PROVIDERS.md`, Providers screen in-app), secrets/logging
  (`SECURITY.md`), decisions (`docs/adr/`).
