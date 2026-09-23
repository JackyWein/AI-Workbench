# Handoff

For whoever picks this up next. `PROGRESS.md` is the authoritative record of
what is verified; this file only says where things stand and what will bite
you. The long day-by-day history that used to live here is in git
(`git log -- HANDOFF.md`).

Everything is on `claude/repo-setup-instructions-8tgcbw`. The design rollout
branch `design/approved-rollout` is merged into it.

## Where things stand (2026-09-23)

Regression batch (user report: teams idle, palette instead of dropdown,
providers still grey — all on installed 0.0.4 test build):
- Providers grey-screen, root cause: module-level relative import of the
  custom-provider profile could fail the whole App chunk, and malformed IPC
  summaries reached render unvalidated. Fixed by package import
  (`@ai-workbench/provider-openai-compatible`), store-level
  `providerSummarySchema.safeParse` filtering in `initialize/refreshProviders`
  (+ explicit error in `rescanModels`), keeping the render guards + per-view
  ErrorBoundary from the previous batch.
- Model picker rebuilt as dropdown: new `ModelPicker.tsx` (popover, grouped
  providers → default + models, capability-gated, filter input) replaces the
  palette-prefill pills in `SessionHeader` and `Composer`; `App.tsx` no longer
  passes `modelName`. Palette stays for commands (Ctrl+K). Teams section lists
  global teams with agent/active-run counts and opens them in the Teams view
  (chat sessions stay single-provider; team runs live on their team).
- Teams idle with silent noWorkLeft: turn failures only emitted AGENT_FAILED
  (never persisted) so Messages stayed empty. `#turn` now also writes a
  `warning` mailbox note (`<agent> turn failed: <reason>`), so the Messages
  tab shows why a run died. `cancel()` cancels concurrently
  (Promise.allSettled), `dispose()` got the same 5s grace race so Stop can no
  longer hang on an unresponsive turn. Note: local machine has OpenCode
  v2.0.15 — headless `run --format json` still exists in V2, but V1-measured
  event shapes may drift; user-visible failure notes will now show it.
- Previous batch (in installed build): ErrorBoundary, IPC timeout,
  ProvidersView guards, palette prefill (now superseded by dropdown), usage
  auto-refresh, OpenCode V2 telemetry probe, orchestrator cancel, island
  always-on default + prefs toggle, terminal resync, startup-check opt-in.

Typecheck + lint + build green on Windows; team-flow + team + opencode-server
tests pass.

### Team inside a session (real, not a mockup)

The mockup was accepted, so it is now the real thing, driven by the run that
actually exists — no mock data, no fake rows.
- A session is bound to a team through its OWN record (`uiState.teamId` /
  `uiState.teamRunId`), which `session.update` already accepted and persists.
  **No database migration was needed.**
- `setSessionTeam` (store) resolves the team's live run (running/paused first,
  else newest), or starts a new one when a goal is given, writes the binding
  and stays in the session. `clearSessionTeam` returns it to solo.
- The model/team picker's team row now binds the team to this session instead
  of navigating to the Teams screen. The pill shows `<Team> · Team`, and a
  "Leave <team> · solo session" row puts it back.
- New `TeamSessionView`: one tab per member plus "All", each showing that
  member's own tasks, messages and artifacts, its live `agentProgress` detail,
  and the run's Pause/Resume/Stop. `App` renders it whenever the session has a
  team binding; `TeamSidePanel` replaces the solo ContextPanel with the roster
  and run. Polls the run snapshot every 3s and follows team events.
- The Teams screen stays the place to edit a team, exactly as asked.
- Known gap (next slice): the composer in a team session still talks to the
  session's own provider. Addressing an individual agent from the composer
  needs a `team.sendMessage` IPC channel; it is not faked here.

### Island + terminal follow-ups

- Island agent rows say what is happening instead of a bare "running": waiting
  on you (with the tool's own summary) > working (with the tool's detail) >
  the tool's numbers > "running". `tile.detail` (the service's own words, e.g.
  a launch error) is now used, it was previously ignored.
- NEW island `done` face: when work finished and nothing needs a person, the
  island shows "Finished · <what>" with a green border and a one-shot
  1.6s glow, then stays lit. The finished rows keep their Open target, so a
  click jumps back in.
- Terminal scrolling: the earlier show/focus resync called
  `scrollToBottom()` unconditionally, which threw away the place someone had
  scrolled up to read — that was the "can't scroll back" bug. The resync now
  only refits and repaints; the viewport is never moved. A quiet "Latest
  output" button appears whenever the view is away from the bottom, in both
  the session terminal and the agent tiles.

### Where a team writes (asked: "it wrote into the AI-Workbench repo")

Checked the real database (`%APPDATA%\@ai-workbench\desktop\ai-workbench.db`):
the team's three agents all have `working_directory = D:\CODE\AI-Workbench`,
which IS a registered workspace — so the app did what the team was created
with. The real faults were that this was **invisible** and **unchangeable**.

- `teamSettings` gained `allowOutsideWorkspace` (default false) and
  `workingDirectory` (null = the workspace's folder).
- New `team.setWorkingDirectory` (contract + IPC + `TeamManager`): a folder
  outside the workspace is REFUSED unless the person switched
  `allowOutsideWorkspace` on — that is the "yes, on purpose" the owner asked
  for. All agents follow the team folder, so the answer to "where does this
  team work" is never ambiguous. Null puts it back to the workspace.
- Both the Teams screen (a "Where this team works" row + a disclosure with the
  folder field, the outside-workspace switch and "back to the workspace
  folder") and the session's team view now SHOW the folder.
- Safety net in the CLI adapter: a turn whose session was never opened has no
  working folder, and is now refused with a clear message instead of letting
  the child process inherit the app's own directory. Nine adapter tests were
  relying on that undefined behaviour and now open a session first; one new
  test asserts the refusal.
- New test: "refuses to work outside the workspace unless the person allows
  it" covers default → refused → allowed → back.

Full `bun run test`: 387 passed / 54 skipped. typecheck, lint green.

### Removed on request: team-run leftovers

A team run ("build me a 3D space website") had written into this repository
instead of its own folder: `apps/desktop/src/renderer/space/` (10 files),
`apps/desktop/vite.space.config.ts`, the `space` renderer input in
`electron.vite.config.ts`, `space:dev` / `space:build` in both package.json
files, README/DEVELOPMENT sections and a HANDOFF paragraph. The owner asked for
all of it to go, so it is gone. The team-folder bug that let it happen is
fixed separately (teams show and can change their working folder, and a turn
without one is refused).

In-app team-session mockup (user asked: mockup must use the real design):
- New `TeamSessionPreview.tsx`: real SessionHeader/ChatView/Composer +
  panel__tabs agent switcher (Lead/Builder/Reviewer/All), detail-list goal
  strip, scope-toggles run controls, recipient pill, mock ChatMessages.
- Gated: `teamPreview` store flag + developerMode; palette command
  "Preview on/off: team in session (mockup)". No IPC/backend changes;
  delete the file once the real design is agreed.
- Polish after user screenshots: one control strip (Pause/Stop/calls/To:)
  attached to the composer's top edge instead of loose buttons; right panel is
  a team panel (members + run) instead of the solo ContextPanel.

### Follow-up batch (user: "die anderen Fehler von vorhin")

Root-caused the team timeout by MEASURING the installed OpenCode 2.0.15 on
this machine (no quota spent): `opencode run --format json` answers in ~3s
and runs shell tools in ~4.5s with no `--auto`; the event names are still
`step_start` / `tool_use` / `step_finish` and the tool id is `id` (already
handled). So the flags, the JSON format and headless permissions were NOT the
problem — the fixed 120s orchestrator deadline was: a real coding task simply
outlives it.
- `teamRunConfigSchema.agentTurnSilenceSeconds` (default 600) is the per-run
  budget. The orchestrator's `#ask` now treats it as a SILENCE budget: any
  text/tool/status event slides it, plus a hard cap (run runtime limit or
  10x silence, whichever is smaller) so a trickling provider cannot hold the
  run forever. `turnTimeoutMs` stays as the test/override knob.
- New `AGENT_PROGRESS` team event (every 5s while a turn works, with the
  tool's own wording) → store `agentProgress` (no snapshot re-read per beat)
  → TeamsView agent list shows "Working · <what it is doing>" instead of a
  frozen row. Turn failures also write a mailbox warning (earlier batch).
- Tests: two new cases (slow-but-alive turn survives; fully silent turn is
  cut with "went quiet"). Full `bun run test` = 382 passed / 54 skipped.
- Antigravity: profile gained `interactive: { args: [] }` + knownLocations
  `%LOCALAPPDATA%/agy/bin`, so `interactiveTerminal` is derived and it shows
  up in the Agents view. sessionResume deliberately NOT claimed (`agy` has
  --continue/--conversation but the resume output format is unmeasured).
  New adapter test for the capability. `agy models` discovery already worked.
- Claude models: ModelPicker now labels each model's origin (added by you /
  built-in name / reported by the tool) and says so when a tool lists no
  models itself. Claude 2.1.278 has no model-list command — verified — so
  concrete version names stay out rather than invented.
- Island: Windows now uses the `screen-saver` always-on-top level (re-applied
  on every configure) and the 2s tick re-shows an enabled island that is not
  visible, so a full-screen app cannot leave it gone. Honest limit: a truly
  exclusive full-screen surface that bypasses the desktop compositor cannot
  be covered by any window.
- Providers grey-screen: ErrorBoundary per view + global renderer handlers +
  IPC timeout (30s) + ProvidersView null-guards (settings/models/metadata/
  capabilities/configs). Root crash was `config?.settings["models"]` + unguarded
  metadata/capabilities/Logo label.
- Model picker: pills now open palette prefilled with "Use model:" via new
  `paletteQuery` store field (SessionHeader/Composer/CommandPalette).
- Usage: auto-refresh on open + 60s interval + focus refresh, age always shown,
  100%-without-reset hint ("limit may still apply"), amounts-only header
  ("No quota — consumed amounts").
- OpenCode V2: `opencodeServerTelemetry` probes `opencode --help` for
  --port/--hostname; V2 returns null (plain start, island without live status)
  instead of printing help + "Unrecognized flag". Unknown probe preserves V1 path.
- Team stop: new `orchestrator.cancel()` (immediate adapter.cancel + 5s grace
  race + forced cancelled, loop respects cancel vs pause via #stopReason);
  `team-manager cancelRun/pauseRun` persist cancelled/paused even when not active
  (orphan-DB fix); TeamsView shows Pausing…/Stopping…/Working… and disables buttons.
- Island: new `hideWhenMainFocused default false` (always-on default), 150ms
  focus debounce, 30s startup grace until first blur, minimized counts as gone,
  startup-check hide-assert now enables the opt-in explicitly.
- Terminal: XtermPane + TerminalView rAF + 100ms fallback, visibility/focus
  resync (fit twice + resize + refresh + scrollToBottom), reattach exists:false
  shows "[process ended]" instead of empty pane.

Typecheck + lint + build green on Windows; team-flow + team unit tests pass.
Full `bun run test` long (node-pty AttachConsole noise on Windows, run with
larger timeout); `verify:app` cannot run on plain Windows (no bash/Xvfb) and
must still run on Linux.

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
