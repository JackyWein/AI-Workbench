# AI Workbench — Project Progress

Progress is measured **only** from acceptance criteria in `AI_WORKBENCH.md` that were
verified locally. Nothing here is estimated. A regression unchecks its criteria.

Each goal's completion = checked criteria / total criteria of that goal.
Weighted contribution = weight x completion.

## Summary

| Goal | Area | Weight | Criteria | Verified | Completion | Weighted |
|---|---|---:|---:|---:|---:|---:|
| G0 | Repository / Foundation | 5% | 12 | 12 | 100% | 5.00 |
| G1 | Functional desktop vertical slice | 15% | 20 | 19 | 95% | 14.25 |
| G2 | Provider platform | 15% | 20 | 20 | 100% | 15.00 |
| G3 | Workspace / developer tooling | 10% | 14 | 14 | 100% | 10.00 |
| G4 | Skills, plugins & MCP | 10% | 15 | 15 | 100% | 10.00 |
| G5 | Autonomous team system | 20% | 28 | 27 | 96% | 19.29 |
| G6 | Status Island & background runtime | 10% | 22 | 19 | 86% | 8.64 |
| G7 | UX, security, reliability & performance | 10% | 19 | 13 | 68% | 6.84 |
| G8 | Extensibility, SDK & packaging | 5% | 10 | 1 | 10% | 0.50 |
| **TOTAL** | | **100%** | **160** | **140** | | **89.52%** |

## Current focus

**G7 — UX, security, reliability and performance.** As of 2026-09-25
(release 0.0.7) `bun run verify` passes end to end: lockfile, lint,
typecheck, 1027 tests, the build, the bundled memory server and both
startup phases (228 checks, none failing). What remains in G6 is the tray,
multi-monitor handling and the idle-unobtrusiveness judgement; in G5, two
real providers collaborating. Antigravity (`agy`) could not be installed or
read about here and stays unverified. No criterion was ticked for the 0.0.5
, 0.0.6 or 0.0.7 work below: it deepens criteria already ticked or is a judgement
(G7 "dark mode polished", "visual hierarchy follows Quiet UI principles")
that stays the person's.

### Release 0.0.7 (2026-09-24)

Verified here by tests and the startup check:
- A dialog on a terminal's screen reaches the island. The detector reads
  Antigravity's, Claude Code's, Codex's and Gemini CLI's dialogs (drawn
  through a display-less xterm.js, wrapped options included) and refuses a
  numbered list without a marker, counting that skips, and a dialog that
  scrolled away (unit tests). A real program in a real pty is read and
  answered by its own arrow keys, never with Enter on a wrong option (test
  that runs on Linux here and on Windows and macOS in CI). In the built
  app, a stand-in for Antigravity with no hooks shows its dialog as waiting,
  the island offers its three options, and the answer reaches the tool as
  option 2 (startup check).
- Team turns are no longer cut off while the tool reports: a turn that keeps
  writing outlives the silence limit, one that goes quiet is stopped
  (process tests); the old defaults are replaced for new runs (unit test).
- Every member's turn is kept with its output, steps and task, survives a
  restart through SQLite, and the island's team row names the member and
  its current task and step (unit and core tests).
- The team editor creates a team from a template with each member's role
  and instructions, and a member's instructions reach only its own prompt
  (startup check, unit test).
- The update question (Later / Restart now) shows in the window and on the
  island, and Later in one place answers both; Restart now installs silently
  and starts the app again (unit test against the updater's flow with a
  stand-in electron-updater; startup check with a stand-in download).
- The model picker stays inside the window, scrolls and opens only the
  session's tool; island shadows fit the island window; Swiss keeps square
  corners when opened (startup check, CSS test).
- A team run belongs to the session that started it. A second session in
  the same workspace opens the team with no run, and its goal starts a run
  of its own in that workspace without touching the first session's run
  (startup check, both phases); a session never shows or continues another
  session's run, including runs from before this change (unit tests), and
  the main process refuses to continue another session's run (core test).
- Closing a terminal on Windows no longer ends a process id node-pty's
  helper could not confirm (unit test).
- MCP servers imported from a tool's own configuration leave secrets in
  arguments out, as they already did for variables (unit test).
- Hovering a session that was never opened no longer crashes the sidebar
  (React error 185 from a store selector returning a new list on every
  read): reproduced by a startup check before the fix, which passes after
  it in both phases; a lint rule refuses such selectors.
- Skills and imported MCP servers reach everyone: a server imported from a
  tool's configuration (a project .mcp.json) connects, and a new solo
  session is handed its tools and the built-in skills server's tools; a
  team member on a tool without MCP gets the skills that are on as
  instructions (startup checks, both phases). A member on a tool with MCP
  gets the servers on for its run's workspace, prepared as for a session
  (trusted, gateway), and its workspace and own skills (core tests that fail
  on the previous code). Tools without an instruction flag get the
  instructions in front of the first message, or every message when they
  cannot resume (adapter test). Not verified here: the real Gemini CLI,
  OpenCode and Antigravity reading them.
- A member's turn shows the code it changed as a diff in the team timeline,
  read from the folder by git snapshots on a throwaway index: in a git
  folder a stand-in member writes a file and the session renders its added
  lines, and the person's index is untouched afterwards (startup checks,
  both phases; screenshot taken); the snapshots leave staged work and the
  index as they were and skip ignored files (git tests); the diff is
  published in the member's name for its task (core test with real git).
Not verified: the real Antigravity, and real Codex, OpenCode and Gemini
CLI accounts on the person's Windows machine; a real update installed from
one published release to the next; a real multi-hour team run. The crash
recovery, shared-memory guidance, tool MCP import and window changes that
came in with the same release are covered by their own tests and startup
checks as committed; they were not re-verified by hand here.

### Updates by commit and in the background; signing-ready (2026-09-24)

Verified here by unit tests: a release is offered when its version is newer
or it is the same version built from another commit, never an older one and
never on a guess (both commits must be known); electron-updater's installed
class refuses the same version and, wrapped, accepts a new build of it; the
setting that turns background updates on reads true from settings stored
before it existed. The startup check confirms a built app knows its commit
and has background updates on. Not verified: a real update from one
published build to another (needs two releases carrying the change), and
signed builds (no certificates).

### Every theme light and dark (2026-09-24, in the re-published 0.0.6)

Verified here by tests and the startup check: each of the six themes has a
light and a dark mode; the contrast test measures all twelve from the
stylesheets; in the built app each is picked in Settings in both modes,
drawn with the matching colour scheme and readable title and sidebar text,
with its typeface loaded. Settings stored by 0.0.6 and earlier keep the
look they had (unit test of the upgrade). A new install follows the system;
the sidebar's toggle steps System, Light, Dark (startup check). The island
takes each theme's style and mode, and its text reads on its body in both
(contrast test for every island palette; startup check in three of them).
Not verified: the modes against a real Windows or macOS system theme
switch, and light islands over a real desktop.

### Release 0.0.6 (2026-09-24)

Verified here by tests and the startup check:
- Themes: every theme's text reads on its ground at WCAG contrast (body text
  7:1, secondary 4.5:1, captions and status colours 3:1 or more) in the
  window, the sidebar, code blocks, the terminal and the island, measured
  from the stylesheets by a test. In the built app, each of the eight is
  picked in Settings, repaints the window readably, loads its own typeface
  under the page's content policy, and the island takes the theme on.
- The app's logo is the mark in the sidebar (startup check); the start
  screen's animation was looked at, not asserted.
- Answers render Markdown (unit tests of the parser, the renderer never
  sets HTML); a team session is still a team after a restart (startup
  check, shown to fail without the fix); the island's title is light on a
  light system theme (startup check); a stored skill or plugin that no
  longer parses is skipped at start (unit test).
Not verified: how each theme looks on a real Windows or macOS desktop, and
whether the themes are to the person's taste.

### Release 0.0.5 (2026-09-24)

Verified here by tests and the startup check:
- Connectors: catalog, OAuth sign-in against a local OAuth-protected MCP
  test server (discovery, registration, PKCE, token renewal, sign-out), the
  local gateway, and each of Claude Code, Codex, Gemini CLI and OpenCode
  calling a connector's tool through it. A sign-in page that is not a web
  address is refused. Not run: a real service such as Gmail (needs the
  person's own Google OAuth client and account).
- Skills: written by hand, drafted by the simulated provider, imported from
  a tool's skill folder, a Markdown file and a folder.
- Attachments to a message, handed to each real CLI (Claude Code's
  `--add-dir`, Codex `--image=`, Gemini `@path`, OpenCode `--file`).
- SSH sign-in with OpenSSH, PKCS#8 and passphrase-protected keys and a key
  file, against the in-process SSH server.
- Removing a workspace stops a turn in flight and its team runs and removes
  the session's files.
- Updates: a packaged build posing as an older version found the newer
  release (checked with 0.0.3 → 0.0.4); builds that cannot update
  themselves say so.

### Every terminal agent on the island (2026-09-23)

Codex, OpenCode and Gemini CLI tiles now do what Claude Code's did: the
island shows each with its own mark when it waits, with Allow and Deny (and a
question's choices, for OpenCode), says when it works and when it rests, and
the tile shows what its session used. Each rests on that tool's own channel,
measured against the real tool before it was built (recorded at the top of
each provider package's module):

| Tool | Waiting and working from | Answer from outside | Numbers from |
|---|---|---|---|
| Claude Code 2.1.280 | its hooks, given per run | the waiting hook's answer | its status line |
| Codex 0.156.1 | its hooks, given per run (`-c hooks.*`) | the keys its dialog takes (`y`, Esc) | its session log |
| OpenCode 1.18.32 | its own server, started by its interface on a free port with a password only that run knows | its reply routes (`once`, `reject`, a question's label) | the same server |
| Gemini CLI 0.60 | its hooks, from a small extension installed once | the keys its dialog takes (`1`, Esc) | its session transcript |

Gemini CLI cannot be given hooks for one run (the only layer that could, the
system settings file, is skipped unless root owns it, by design). So the
Providers screen offers a one-time "Status island" setup, which runs Gemini
CLI's own `extensions install` in a terminal tile where the person answers its
questions; outside the Workbench the extension's hooks do nothing. The setup
step is provider-neutral: any tool can offer one.

Models and usage, per tool, as the tool reports them:

- Codex: its models (with reasoning efforts) from its app server, which
  answers without an account; limits need a signed-in account.
- OpenCode: every model of every provider it can reach, with names, context
  sizes and efforts; today's and this week's tokens and cost from `stats`
  (1.18.32 has no `--json`; its table is read, rounded as it prints it).
- Gemini CLI: its own aliases (auto, pro, flash, flash-lite); headless turns
  now report tokens, tool calls and a resumable session.
- The model picker says whose each model is (tool, upstream provider, built
  in or added by you) and finds models by it.

Verified against the real tools with only the model replaced by a local
stand-in (`real-codex-attention.test.ts`, `real-opencode-attention.test.ts`,
`real-gemini-attention.test.ts`, run deliberately, see below: OpenCode and
Gemini CLI passed three runs in a row, Codex two): models through the adapter, chat turns with resume and
a tool call, Allow running a command from outside the terminal, Deny ending
the turn, idle afterwards, and (OpenCode) a question answered from outside.
In the application, the startup check runs stand-ins for Codex, OpenCode and
Gemini CLI (its setup included) through the island and clicks Allow.

Not covered, and said so: real accounts (limits, which models an account may
use) for Codex, OpenCode and Gemini CLI; `bun run check:providers` reads
them on a machine that has them, without spending anything. The Windows hook
bridges (PowerShell) are written but were not run. Codex and Gemini CLI answer
only shell commands from the island; other tools' approvals show there and
are answered in the tile.

### Design rollout (2026-09-23)

The main window, Settings, Providers, the Usage view, live terminal metrics
and the Status Island follow the approved design. It was merged without
changing it: the rendered screens of the merged build were compared pixel by
pixel with the design branch's own. Island, Providers (dark and light),
Skills and Usage are identical; every other difference is data — times,
paths, which runs the check left open — or the Settings scrollbar, because
the SSH connections are a new group at the foot of that screen.

The design branch's startup check had never run; on its own it failed eight
checks. Two were real bugs, fixed: the island named an asking agent by its
internal id, and the simulated provider's usage showed outside developer mode
whenever no real tool was installed. The rest were checks that still
described the old interface; they now assert what the design does.

Verified live on the design branch, not here: Claude Code telemetry reaching
the tile, the Usage view and the island, and the island's prompt line typing
into a running Claude Code terminal. Codex limits from its session files and
OpenCode amounts from its CLI were seen live; Gemini telemetry was never run.
Claude Code's status line bridge now also works on macOS and Linux (a POSIX
bridge, tested through a real `/bin/sh`), where it used to be PowerShell only
and took the person's own status line with it.

Not exercised anywhere yet: the island's real drag through the OS cursor.

### Agents that wait on the person, on the island (2026-09-23)

When Claude Code in a terminal tile asks for a permission or puts a question,
the island now shows it with Claude's own mark in the circle, and it can be
answered right there: Allow and Deny for a permission, the offered choices for
a question. Claude Code's own prompt in the tile stays usable the whole time;
whichever answer comes first counts. The same hooks tell the island whether
Claude is working on a turn or idle at its prompt, so an idle Claude tile
counts as resting, not as work.

This rests on Claude Code's documented hooks, and on measurements against the
installed Claude Code 2.1.280 made before building it (recorded in
`packages/providers/claude/src/attention.ts`): the permission dialog stays
usable while a hook waits; a late `decision.behavior` allow or deny still
settles it; Esc in the terminal ends the waiting hook; a question is answered
with `updatedInput.answers`; an interrupted turn fires no hook but is written
to the session transcript.

Verified against the real Claude Code, through the application's own terminal
stack (`real-claude-attention.test.ts`, run deliberately, see below): Allow
from outside the terminal runs the command; Deny does not; a question answered
from outside, followed by a permission, writes the chosen answer; the tile
reports idle after starting, working mid-turn, idle after the turn, and idle
again after an Esc interrupt. Verified in the application by the startup
check, with a stand-in for Claude Code's executable that calls the hooks the
way Claude Code does: the island shows the Claude mark, Allow and Deny, a
click on Allow reaches the hook in Claude Code's format, and the finished turn
rests.

Not covered: a team agent's question still appears as a waiting entry whose
Approve opens the run. The Windows (PowerShell) hook bridge is written but
was not run here. (Codex, OpenCode and Gemini CLI tiles: see above.)

## How this file is verified

Everything ticked below is proven by `bun run verify`, which runs:

- `verify:lockfile` — `bun install --frozen-lockfile`: the lockfile matches
  every `package.json`, so a frozen install cannot fail only on a build machine
- `lint` — ESLint over the workspace
- `typecheck` — strict TypeScript over Node and web projects
- `test` — 412 unit and integration tests (20 more are skipped here: the
  ones that drive installed tools, see below, and 2 that exercise the Windows
  status line bridge and only run on Windows)
- `build` — electron-vite production build
- `verify:app` — starts the built application headlessly (Xvfb) and drives
  the real renderer through the preload bridge: a streamed answer, a collapsed
  tool call, a real shell echoing back, the file browser, the git branch and
  changes, the command palette, the usage popover and the settings and
  providers views. Since this milestone it also proves that a skill switched on
  for a session reaches the provider as instructions, that an MCP server which
  cannot start is reported instead of thrown, that a session can be given
  access to a server, that connecting an account never falls back to
  plaintext, and that a team of three agents runs a goal to completion — the
  lead delegating to the other two, both finishing, the run reaching
  `goalFinished` and the screen showing it. Since this milestone it also drives
  the Status Island as its own window: its position across a restart, every
  widget against what the application really knows, an important event taking
  it and settling back, pinning and cycling from the palette and from the
  island's own keyboard, and the deep link landing the main window on the run
  the entry is about — or, while an agent's question is waiting, that the
  question keeps the island and opens the run that asked. It works in a
  workspace on another machine over SSH: a real SSH server with a real SFTP
  subsystem, started in the check, a connection whose host key is learned,
  and a file listed, opened, edited and saved, the edit read back from the
  served directory. A terminal agent started through the Claude Code
  provider — with a stand-in executable that calls the run's hooks the way
  Claude Code does — reports that it waits for a permission and is working;
  the island shows it with Claude's mark and Allow and Deny, a click on Allow
  reaches the permission hook in Claude Code's own answer format, and the
  finished turn leaves the agent resting. The same runs for stand-ins of
  Codex (Allow arrives as its `y` key), OpenCode (its server's reply route)
  and Gemini CLI (its one-time setup first, then its `1` key). The palette
  finds a tool's models by the tool's name. It then runs a second time against
  the same database to prove a conversation, its provider session, the island's preferences and
  the remote workspace with its host key survive a restart.

Additionally, and deliberately outside the default run:

- `AI_WORKBENCH_REAL_PROVIDER=1 bun run test` drives the installed Claude Code CLI
  through the whole stack. It was run once for this milestone: the tool was
  detected with its version, an answer streamed back, real account usage was
  reported by the provider, and a second turn resumed the same conversation.
- The same variable runs `real-claude-attention.test.ts`: the installed Claude
  Code 2.1.280 in a real terminal, through the provider, the terminal service
  and the hook bridge. Run on 2026-09-23 with the smallest model: all four
  cases passed (Allow, Deny, a question then a permission, and idle after an
  interrupt).
- `AI_WORKBENCH_REAL_CODEX=1`, `AI_WORKBENCH_REAL_OPENCODE=1` and
  `AI_WORKBENCH_REAL_GEMINI=1` run the installed Codex 0.156.1, OpenCode
  1.18.32 and Gemini CLI 0.60 the same way, each against a local stand-in
  for its model API, so no account is needed. Run on 2026-09-23: Codex 4
  cases (passed twice), OpenCode 5 and Gemini CLI 3 (each passed three runs
  in a row).
- `bun run check:providers` reads every installed tool with the person's own
  accounts (version, sign-in, models, usage, island setup) and spends
  nothing. It is how the real-account parts above get checked.

Last full run: 2026-09-23, all checks passed (both startup phases, 163 checks).

A packaged Linux build (`electron-builder --linux dir` under bun) was also
started and ran the startup check: terminal, database and SSH worked from
the package. That is evidence for G8's packaging criteria, not yet proof:
the installers themselves and a clean install on another machine were not
run.

## What is deliberately not ticked

- **choose working directory (G1)** — the code path exists and the surrounding
  path validation is tested, but the native folder dialog cannot be exercised
  headlessly. It needs one manual confirmation on a desktop.
- **main UI uses target design language (G1)** is ticked based on a rendered
  screenshot checked against the rules in `AI_WORKBENCH.md` §61–§76 (quiet
  neutral surfaces, thin separators, document-style chat, Lucide icons, no
  emoji, no card grids, dark first). Final visual sign-off remains the user's.
- **aggregated usage hover/focus (G1)** is verified with one registered
  provider; aggregation across several providers is covered by the
  `UsageService` tests, not yet by a running multi-provider setup.
- **Codex and Gemini adapters (G2)** are ticked since their flags, event
  streams, resume, tool calls and interactive interfaces were run against
  Codex 0.156.1 and Gemini CLI 0.60 (see above). The model behind them was a
  local stand-in: what an account adds — its limits, the models it may use —
  was not run here and is what `bun run check:providers` reads. Google
  replaced the Gemini CLI with the Antigravity CLI (`agy`); its profile ships
  but could not be installed or read about here, so it stays marked
  unverified in the application.
- **authentication state reporting (G2)** is ticked for the mechanism, which is
  tested across authenticated, sign-in-required and unknown states. The Claude
  Code profile has no non-interactive auth probe, so for that provider the
  honest answer is "unknown" with a hint, not a guess.
- **G7** items left open are the judgment and performance ones (polish,
  virtualized chats and logs, full keyboard pass). They belong to the dedicated
  hardening pass, not to this stage.
- **remote MCP (G4)** is ticked from the tests against a real MCP server over
  streamable HTTP: connecting, reading the tool list, calling a tool, and the
  credential arriving as an `Authorization` header. The legacy SSE transport is
  implemented but not exercised by any test.
- **OpenAI-compatible provider (G8)** is implemented, and model listing with
  an authorization header, error mapping, timeouts and secret redaction are
  tested. A streamed turn through it is not, so the criterion stays open.

## G0 — Repository / Foundation — 5%

- [x] pnpm workspace configured — met by a bun workspace since 2026-09-23, by
      the owner's decision; the specification still names pnpm
- [x] Electron app launches
- [x] React + TypeScript renderer launches
- [x] TypeScript strict mode enabled
- [x] lint/typecheck scripts exist
- [x] Vitest configured
- [x] SQLite + Drizzle configured
- [x] migration system works
- [x] typed preload IPC baseline exists
- [x] structured logging baseline exists
- [x] design token baseline exists
- [x] CI/basic automated verification exists if practical

## G1 — Functional desktop vertical slice — 15%

- [x] create workspace
- [x] persist workspace
- [ ] choose working directory
- [x] create session
- [x] persist session
- [x] select MockProvider
- [x] select mock model
- [x] send message
- [x] stream response
- [x] cancel response
- [x] persist conversation
- [x] restart app
- [x] reopen workspace/session
- [x] conversation still exists
- [x] provider/session state restores safely
- [x] usage mock appears
- [x] aggregated usage hover/focus works
- [x] command palette works
- [x] settings open
- [x] main UI uses target design language

## G2 — Provider platform — 15%

- [x] provider adapter contract stable
- [x] transport abstraction stable
- [x] provider registry works
- [x] capability model works
- [x] MockProvider complete
- [x] generic CLI transport works
- [x] provider installation discovery works
- [x] authentication state reporting works
- [x] normalized provider streaming works
- [x] provider errors normalize correctly
- [x] provider cancellation works
- [x] session cleanup works
- [x] model listing works
- [x] session resume supported where provider supports it
- [x] first real provider works end-to-end
- [x] Claude adapter implemented if supported
- [x] Codex adapter implemented if supported
- [x] Gemini adapter implemented if supported
- [x] missing provider does not break app
- [x] API/custom provider config architecture exists

## G3 — Workspace / developer tooling — 10%

- [x] safe filesystem layer
- [x] working-directory boundaries
- [x] integrated terminal
- [x] terminal resize/input/output
- [x] terminal cleanup
- [x] file browser
- [x] file change representation
- [x] Git status
- [x] Git branch display
- [x] tool call collapsible UI
- [x] session runtime independent from visible tab
- [x] multiple sessions can remain active
- [x] context sidebar works
- [x] useful keyboard navigation exists

### Beyond G3 — workspaces on another machine

Not one of the 160 acceptance criteria: the specification has no section for
remote workspaces yet, so nothing below counts toward the total. It is recorded
here because it is built, verified and in use.

A workspace root is either on this computer or on a machine reached over SSH.
`WorkspaceFileSystem` became the contract both answer to, and `WorkspaceAccess`
decides which one a workspace gets — the file browser, the editor and the IPC
handlers never learn which it is.

What is proven, by 20 tests against a real SSH server with a real SFTP
subsystem serving a real directory, and by the startup check driving the
application itself:

- [x] a connection is defined once and used by any number of workspaces
- [x] the password or key goes to the credential store, never to the renderer
- [x] the host key is trusted on first use and a change is refused
- [x] wrong credentials are reported as such, not as a protocol error
- [x] a folder on the machine can be browsed and picked
- [x] a remote workspace lists, opens, edits and saves like a local one
- [x] the boundary holds remotely, including through a symbolic link that
      leaves the root
- [x] binary content is refused and reads and writes are capped
- [x] one connection is shared by many operations rather than reopened
- [x] a connection still carrying workspaces is not silently removed
- [x] the workspace, its host key and its edits survive a restart

Not done, and not claimed: git and terminals on a remote workspace. Git status
reports "no repository" for a remote workspace rather than running git here
against a path that only exists elsewhere, and a terminal still opens on this
computer. Agents therefore cannot yet work in a remote workspace — only people
can, through the file browser.

## G4 — Skills, plugins & MCP — 10%

- [x] SkillManager implemented
- [x] global/workspace/session skill scopes work
- [x] effective skill resolution tested
- [x] internal provider-neutral skill format exists
- [x] at least one skill importer works
- [x] PluginRegistry implemented
- [x] plugin scope model works
- [x] central account model exists
- [x] CredentialManager works
- [x] MCPManager works
- [x] local MCP stdio server can connect
- [x] remote MCP config supported
- [x] session MCP selection works
- [x] ToolBridge abstraction works
- [x] plugin/provider separation remains intact

Not exercised here: a successful encrypt/decrypt round trip through the
operating system's own secret storage. The container running the checks has no
secret service, so what was proven is the other half — that the application
refuses to store a secret at all rather than falling back to plaintext. The
round trip needs one run on a desktop.

## G5 — Autonomous team system — 20%

- [x] TeamDefinition persisted
- [x] team agent definitions persisted
- [x] Lead Agent selectable
- [x] TeamRun persisted
- [x] Task Graph works
- [x] dependencies work
- [x] ready/blocked transitions work
- [x] Agent Mailbox works
- [x] Shared Team State works
- [x] Decision Log works
- [x] Artifact registry works
- [x] Team Event Bus works
- [x] Team MCP server launches
- [x] agent can read team state
- [x] agent can create task
- [x] task can be delegated
- [x] worker can complete task
- [x] result reaches Lead Agent
- [x] independent tasks can run concurrently
- [x] TeamOrchestrator enforces concurrency
- [x] max calls/tasks/depth/runtime enforced
- [x] agent ping-pong protection works
- [x] failure recovery works
- [x] team can finish a goal
- [x] team run can survive app restart
- [x] at least two different MockProvider agents collaborate end-to-end
- [ ] at least two real provider adapters can collaborate when available
- [x] Team UI shows state without becoming permanently cluttered

Two things this does not yet claim. The Team MCP server starts and serves all
21 tools to a real MCP client, but no provider is handed it as one of its own
MCP servers yet, so the collaboration proven end to end runs on the equivalent
host-mediated path. And the team that was driven to a finished goal is made of
MockProvider agents; two real providers collaborating is the one criterion left
open, because it was not run here.

## G6 — Status Island & background runtime — 86%

- [ ] system tray works
- [x] main window can hide while runtime continues
- [x] Status Island is a separate Electron window
- [x] island show/hide works
- [x] island position persists
- [ ] multi-monitor handling works reasonably
- [x] automatic mode exists
- [x] manual widget cycling works
- [x] pinned widget works
- [x] Usage widget works
- [x] Active Agents widget works
- [x] Needs Attention widget works
- [x] Team Progress widget works
- [x] Completed Work widget works
- [x] Error widget works
- [x] priority engine is tested
- [x] high-priority event temporarily overrides low-priority widget
- [x] user can open relevant main-app context from Island
- [x] Island returns to compact state after event handling
- [ ] Island remains unobtrusive when idle
- [x] Island preferences are configurable
- [x] no fake progress percentages are displayed

Three criteria stay open because nothing here proves them: the tray is created
but no check asserts it, a headless container has one display so multi-monitor
handling is untested, and "unobtrusive when idle" is a judgement about a real
desktop rather than something a check can assert.

## G7 — UX, security, reliability & performance — 10%

- [x] renderer has no direct Node integration
- [x] IPC inputs validated
- [x] secrets are not stored in plaintext
- [x] secrets do not appear in logs
- [x] provider crashes are isolated
- [x] MCP crashes are isolated
- [x] malformed provider output does not crash app
- [ ] long chats are performant
- [ ] long logs are performant
- [ ] keyboard navigation usable
- [x] hover information has focus/click alternative
- [ ] dark mode polished
- [ ] visual hierarchy follows Quiet UI principles
- [ ] no excessive card UI
- [x] no emoji UI icons
- [x] command palette usable throughout app
- [x] important background work is always controllable
- [x] graceful shutdown cleans processes
- [x] tests cover critical failure paths

## G8 — Extensibility, SDK & packaging — 5%

- [x] provider package contract documented
- [ ] plugin package contract documented
- [ ] manifest schema versions exist
- [ ] custom provider UI works
- [ ] OpenAI-compatible provider works
- [ ] external provider package can register without core edits
- [ ] external plugin package can register without core edits
- [ ] production packaging works
- [ ] clean install starts successfully
- [ ] upgrade/migration path documented
