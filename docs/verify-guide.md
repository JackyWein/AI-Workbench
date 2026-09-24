# Verify guide

How to prove a change works. `bun run verify` is the gate; `PROGRESS.md` may only
be updated from criteria a run of it actually proves.

## What `bun run verify` runs (in order)

Defined in `package.json` `scripts`:

1. `verify:lockfile` — `bun install --frozen-lockfile`. Fails
   if `bun.lock` disagrees with any `package.json`. (CI installs frozen;
   a stale lockfile fails packaging before any test runs.)
2. `lint` — ESLint over the workspace.
3. `typecheck` — strict TS over `tsconfig.node.json` + `tsconfig.web.json`.
4. `test` — `vitest run`, ~210 unit/integration tests (2 quota-spending tests
   skipped by default, see below).
5. `build` — electron-vite production build to `apps/desktop/out/`.
6. `verify:memory` — starts the built Markdown memory MCP server through the
   Electron binary in Node mode and exercises search, read and add in a
   temporary vault. It sends no provider request.
7. `verify:app` — `bash scripts/verify-app.sh`: starts the BUILT app
   (`apps/desktop/out/main/index.js`) headlessly TWICE against one throwaway
   user-data dir and drives the real renderer:
   - **phase `create`**: window opens, React shell mounts, preload bridge
     reaches main, workspace + session created, message streams back,
     conversation persisted, usage reported; palette, usage popover, settings
     and providers views respond (plus skills/MCP/team assertions per
     `PROGRESS.md`).
   - **phase `resume`**: same data dir — conversation still there, provider
     session resumed, not recreated.
   - Outcomes are parsed from `"msg":"PASS…"/"FAIL…"` lines in the app log;
     **zero outcomes = failure** (guards the old single-instance-lock
     false-pass). Kill stray `electron` processes before rerunning.

## Windows (with display) vs Linux (Xvfb)

- **Linux / CI / containers:** `verify:app` uses `xvfb-run -a` automatically
  when `$DISPLAY` is empty (`scripts/verify-app.sh`). Full `bun run verify`
  expected green. Chromium runs with `--no-sandbox` in the check only.
- **Windows:** `bun run verify:app` needs bash + Xvfb + Electron display and
  FAILS on a plain Windows box (`REGDB_E_CLASSNOTREG`). Expected on Windows:
  `typecheck + lint + test + build + verify:memory` green; `verify:app`
  explicitly NOT proven.
  Run `bun run verify` (incl. `verify:app`) on Linux/macOS before ticking E2E
  criteria. Prereq if Electron was installed with a restrictive policy:
  `node node_modules/electron/install.js`.
- **Manual desktop checks** (`bun run dev`): island on in Settings and look at it;
  native folder dialog; tray behavior. G6-style criteria need a human look,
  not just a headless pass.

## Real-provider runs (opt-in, spends quota)

- Default tests use `MockProvider` (`packages/providers/mock/`) — no quota.
- `AI_WORKBENCH_REAL_PROVIDER=1 bun run test` drives the installed Claude Code
  CLI end-to-end (detection, version, streamed answer, real usage, resume).
  **Never part of the normal run; spends real quota.** Codex/Gemini(Antigravity)
  profiles are UNVERIFIED starting points — correct path/args on the Providers
  screen, do not edit code to fake them; only Claude Code ships a model list.

## What must NEVER be ticked without proof

- Anything `verify:app` covers (streaming, persistence, restart/resume,
  palette/popover/settings/providers views, skill→provider, MCP failure
  reporting, team goal run) — needs a green `verify:app` on a capable machine.
- G6 island criteria (22) — need green `verify:app` island checks PLUS a human
  having seen the island. Tray has no headless assertion: manual only.
- Native folder dialog (G1), OS secret-storage round trip (proven only as
  "refuses plaintext" in containers), multi-provider usage aggregation,
  Codex/Gemini adapters, two-real-provider collaboration — each needs its
  specific real run, stated in `PROGRESS.md` "What is deliberately not ticked".
- A regression unchecks its criterion. "Code exists" ≠ verified.
