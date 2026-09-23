# Handoff

For whoever picks this up next. `PROGRESS.md` is the authoritative record of
what is verified; this file only says where things stand and what will bite
you. The long day-by-day history that used to live here is in git
(`git log -- HANDOFF.md`).

Everything is on `claude/repo-setup-instructions-8tgcbw`. The design rollout
branch `design/approved-rollout` is merged into it.

## Where things stand (2026-09-23)

| Goal | State |
|---|---|
| G0 Foundation | done (12/12) |
| G1 First vertical slice | 19/20 — the native folder dialog needs a desktop |
| G2 Provider platform | 18/20 — Codex and Gemini/Antigravity not run for real |
| G3 Workspace tooling | done, plus workspaces on another machine over SSH |
| G4 Skills, plugins, MCP | done (15/15) |
| G5 Autonomous teams | 27/28 — two real providers collaborating not run |
| G6 Status Island | 19/22 — tray, multi-monitor, idle judgement open |
| G7 Hardening | 13/19 — performance and polish pass |
| G8 SDK / packaging | 1/10 |

`bun run verify` passes end to end: lockfile, lint, typecheck, 356 tests,
build, and both startup phases (119 checks).

## How to run it

```bash
bun install          # bun 1.3.11 and Node 22; postinstall fixes node-pty's spawn-helper
bun run dev          # the app in development
bun run verify       # lockfile + lint + typecheck + test + build + verify:app
```

`verify:app` needs bash and a display (Xvfb on Linux); it cannot run on plain
Windows. Nothing in `PROGRESS.md` is ticked from a Windows-only run.

Screenshots for a visual review:

```bash
AI_WORKBENCH_STARTUP_CHECK=1 AI_WORKBENCH_CHECK_MODE=create \
AI_WORKBENCH_CHECK_DATA_DIR=/tmp/wb/data AI_WORKBENCH_CHECK_WORKSPACE=/tmp/wb/ws \
AI_WORKBENCH_CHECK_SCREENSHOT=/tmp/wb/shots/shot.png \
xvfb-run -a -s "-screen 0 1440x900x24" node_modules/.bin/electron --no-sandbox apps/desktop/out/main/index.js
```

## What is not built yet

1. **Answering from the island.** The island shows an agent's question and a
   permission request, but its Approve and Answer actions only open the run
   in the main window. There is no backend for answering a question or
   granting a permission, and nothing produces the `agentQuestion` widget, so
   a team agent's question appears as a waiting entry to approve. This is the
   largest open piece of product work.
2. **Agents in a remote workspace.** Files on another machine can be browsed,
   opened, edited and saved over SSH. Git reports "no repository" there and a
   terminal still opens on this computer, so agents cannot work remotely yet.
   `AI_WORKBENCH.md` has no section for remote workspaces.
3. **The island's real drag** through the OS cursor has only been unit-tested
   and rendered headlessly.
4. **Packaging.** A Linux unpacked build under bun was started and passed the
   startup check; the installers and a clean install elsewhere were not run.
   The release workflow now uses bun and has not run since.

## Things that will bite you

- **The startup check only logs at the end.** A check that hangs leaves a log
  with no PASS/FAIL lines at all. Every check has a time limit; a hidden
  window never answers `capturePage`, which is why the island capture has one.
- **Diagnose, do not guess.** When a check fails with `detail: false`, make it
  return a string describing what it saw (the detail is logged) and rerun one
  phase against a copy of the data directory. That is how every failure above
  was found.
- **The island hides while the main window has focus.** Checks that need it
  blur the main window first.
- **A waiting question outranks news on the island**, and nobody can answer
  one inside the application yet, so a question asked in the first phase is
  still waiting in the second. The failing-team checks are ordered and split
  by phase because of this.
- **The simulated provider** appears on the island only in developer mode.
- **Secrets on a machine without a keyring.** The application refuses to store
  a secret the operating system cannot protect. Only the verification run, on
  such a machine, uses `CheckEncryption` (really encrypted, key beside the
  throwaway check database).
- **bun and the install layout.** `bunfig.toml` keeps `node_modules` flat, as
  `.npmrc` did under pnpm; Electron and the native modules rely on it. If lint
  fails with `Cannot find module …/uri.all.js`, the local install is damaged:
  remove `node_modules` and install again.
- **Electron downloads its binary on first start** if it is missing; run
  `node node_modules/electron/install.js` to fetch it ahead of time.
- The app shows the Electron version (e.g. 44.4.3) as its own version when it
  is started from `out/` rather than packaged.
- `opencode was not found` is logged every few minutes when OpenCode is not
  installed: the usage reader asks a tool that is not there. Noise, not a
  failure.
