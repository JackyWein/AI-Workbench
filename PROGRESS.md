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
| G2 | Provider platform | 15% | 20 | 18 | 90% | 13.50 |
| G3 | Workspace / developer tooling | 10% | 14 | 14 | 100% | 10.00 |
| G4 | Skills, plugins & MCP | 10% | 15 | 15 | 100% | 10.00 |
| G5 | Autonomous team system | 20% | 28 | 27 | 96% | 19.29 |
| G6 | Status Island & background runtime | 10% | 22 | 19 | 86% | 8.64 |
| G7 | UX, security, reliability & performance | 10% | 19 | 13 | 68% | 6.84 |
| G8 | Extensibility, SDK & packaging | 5% | 10 | 1 | 10% | 0.50 |
| **TOTAL** | | **100%** | **160** | **138** | | **88.02%** |

## Current focus

**G7 — UX, security, reliability and performance.** As of 2026-09-23 the
approved design rollout, the SSH remote workspaces and the move to bun are one
branch, and `bun run verify` passes on it end to end: lockfile, lint,
typecheck, 375 tests, the build and both startup phases (129 checks, none
failing). What remains in G6 is the tray, multi-monitor handling and the
idle-unobtrusiveness judgement; in G5, two real providers collaborating; in
G2, running the Codex and Antigravity profiles against those tools.

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

Not covered: Codex, Gemini, Antigravity and OpenCode tiles report neither
waiting nor working; the island shows them as "running" rather than claiming
work. A team agent's question still appears as a waiting entry whose Approve
opens the run. The Windows (PowerShell) hook bridge is written but was not run
here.

## How this file is verified

Everything ticked below is proven by `bun run verify`, which runs:

- `verify:lockfile` — `bun install --frozen-lockfile`: the lockfile matches
  every `package.json`, so a frozen install cannot fail only on a build machine
- `lint` — ESLint over the workspace
- `typecheck` — strict TypeScript over Node and web projects
- `test` — 375 unit and integration tests (8 more are skipped here: 6 spend
  real provider quota, see below, and 2 exercise the Windows status line
  bridge and only run on Windows)
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
  finished turn leaves the agent resting. It then runs a second time against
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

Last full run: 2026-09-23, all checks passed (both startup phases, 129 checks).

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
- **Codex and Gemini adapters (G2)** ship as profiles built on the same,
  verified machinery, but their flags and event shapes were not run against
  those tools here. They are marked unverified in the application itself, and
  the criteria stay unticked until someone runs them. Google replaced the
  Gemini CLI with the Antigravity CLI (`agy`), so a profile for it ships too,
  equally unverified; the Gemini profile stays for the plans that kept it.
  None of these tools has a command that lists the models an account may use,
  so only Claude Code ships a model list and the others are filled in on the
  Providers screen.
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
- [ ] Codex adapter implemented if supported
- [ ] Gemini adapter implemented if supported
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
