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
| G2 Provider platform | done (20/20) — real accounts beyond Claude Code not run; Antigravity unverified |
| G3 Workspace tooling | done, plus workspaces on another machine over SSH |
| G4 Skills, plugins, MCP | done (15/15) |
| G5 Autonomous teams | 27/28 — two real providers collaborating not run |
| G6 Status Island | 19/22 — tray, multi-monitor, idle judgement open |
| G7 Hardening | 13/19 — performance and polish pass |
| G8 SDK / packaging | 1/10 |

`bun run verify` passes end to end: lockfile, lint, typecheck, 412 tests,
build, and both startup phases (163 checks).

Newest: every terminal agent reports on the island. Claude Code, Codex,
OpenCode and Gemini CLI tiles say when they wait on the person (with the
tool's mark, Allow/Deny, and OpenCode's questions), when they work and when
they rest, and what their session used. Each through the tool's own channel,
measured against the real tool first; see `PROGRESS.md`, "Every terminal
agent on the island". Gemini CLI needs a one-time setup from the Providers
screen (a small extension installed with Gemini CLI's own installer).

To check the real-account parts on a machine that has the accounts:
`bun run check:providers` (reads only; spends nothing).

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

1. **Antigravity (`agy`)** could not be installed or read about here; it has a
   profile, no island channel, and stays marked unverified. A team agent's
   question still appears as a waiting entry whose Approve only opens the run.
   Codex and Gemini CLI answer only shell commands from the island; their
   other approvals show there and are answered in the tile.
2. **Agents in a remote workspace.** Files on another machine can be browsed,
   opened, edited and saved over SSH. Git reports "no repository" there and a
   terminal still opens on this computer, so agents cannot work remotely yet.
   `AI_WORKBENCH.md` has no section for remote workspaces.
3. **The island's real drag** through the OS cursor has only been unit-tested
   and rendered headlessly.
4. **The parked screens.** Teams, Skills, MCP servers and Plugins were left out
   of the design rollout and still use the earlier card layout: a wider
   column, add-forms that are always open, cards inside cards on Teams. They
   work, but they are not in the design's grammar yet (Settings groups and
   Providers rows). There is no approved mock for them.
5. **Packaging.** A Linux unpacked build under bun was started and passed the
   startup check; a clean install elsewhere was not run. The 0.0.3 release
   run failed on every platform because electron-builder published by itself
   when it saw the tag, without a token; the package step now passes
   `--publish never` and the release job alone publishes. CI now also
   installs, typechecks, tests and packages (unpacked, never published) on
   Windows and macOS on every push, so a platform difference shows up there
   first; its first run found a macOS-only SSH path bug, since fixed.
   A release can be started without pushing a tag: Actions → Release →
   Run workflow tags the built commit with the application version, and
   running it again for the same version replaces that release's files.
   Release file names carry no space: GitHub stores "AI Workbench-x" as
   "AI.Workbench-x" while latest*.yml names "AI-Workbench-x", so the
   updater of 0.0.4's first upload found nothing to download.
   On GitHub's Windows runners every start of the test application (a
   database and its migrations, nothing else) takes about 14 s against
   milliseconds on Linux, so Windows tests get 120 s instead of 30 s. Why
   was not found from here; worth timing the packaged app's first start on
   a real Windows machine.

## Things that will bite you

- **Claude Code runs with extra hooks.** Every tile's `--settings` file adds
  hooks next to the person's own (Claude Code merges them). Only the
  permission hook waits — for an answer file from the application, for a
  "withdrawn" note, or for Claude Code to end it — and it prints the answer
  as is; the others run with `async: true`. The measured behaviour this relies
  on is written at the top of `attention.ts`; re-measure after a major Claude
  Code update with `real-claude-attention.test.ts`.
- **Running the real Claude tests in a fresh environment.** A first start of
  Claude Code shows a theme picker and, per folder, a trust question; the
  test answers the trust question itself, but onboarding must be done (or
  `CLAUDE_CONFIG_DIR` pointed at a configuration with
  `hasCompletedOnboarding`). Inside a Claude Code session, remove that
  session's own `CLAUDE_*` variables first, or the child talks to it.
- **The test SSH server now ends its connections when closed.** Before, the
  startup check waited five minutes per phase for the application's idle SSH
  connection to let go.
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
- **Each tool's channel is different, on purpose.** Claude Code and Codex get
  hooks per run (`--settings`, `-c hooks.*`); Codex asks the person once to
  trust them, so their command must never change between runs (the run's
  folder travels in `AI_WORKBENCH_HOOK_DIR`). OpenCode is read from the server
  its own interface starts (`--port`, `OPENCODE_SERVER_PASSWORD`). Gemini CLI
  only takes hooks from settings root owns or from an extension; the island
  uses an extension the person installs once, versioned in
  `packages/providers/gemini/src/attention.ts` — raise its version when its
  files change, so an update is offered.
- **Answers typed as keys** (Codex `y`/Esc, Gemini `1`/Esc) wait 1.5 s after
  the request so the tool's dialog is up, and re-read that it still waits.
- **OpenCode through a pipe loses the end of its output** when it exits (the
  long `models --verbose` list arrives cut at a different length each time),
  so its plain list says which models exist. **Two OpenCode processes started
  together in a fresh data folder collide** setting up its database; the
  OpenCode package runs its commands one at a time. On a first ever start the
  app may still start a tile or turn alongside, which can fail once.
- **OpenCode 2.0.13** is what the earlier OpenCode code was written against
  (`opencode api`, `stats --json`); npm's release is 1.18.32, which has
  neither. Both paths are kept and tried first.
- **Real-tool tests** (`real-{claude,codex,opencode,gemini}-attention.test.ts`)
  each need their tool installed and a variable set (see `PROGRESS.md`); all
  but Claude's use a local stand-in model and no account.
