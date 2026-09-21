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
| G4 | Skills, plugins & MCP | 10% | 15 | 14 | 93% | 9.33 |
| G5 | Autonomous team system | 20% | 28 | 0 | 0% | 0.00 |
| G6 | Status Island & background runtime | 10% | 22 | 0 | 0% | 0.00 |
| G7 | UX, security, reliability & performance | 10% | 19 | 13 | 68% | 6.84 |
| G8 | Extensibility, SDK & packaging | 5% | 10 | 1 | 10% | 0.50 |
| **TOTAL** | | **100%** | **160** | **91** | | **59.42%** |

## Current focus

**G5 — the autonomous team system.** Skills, plugins, MCP servers and
credential storage are in place and reachable from the application. What
remains in G4 is remote MCP transports, which the application reports as
unsupported rather than pretending to offer. What remains in G2 is verifying
the Codex and Antigravity profiles against those tools.

## How this file is verified

Everything ticked below is proven by `pnpm verify`, which runs:

- `pnpm verify:lockfile` — the lockfile matches every `package.json`, so a
  frozen install cannot fail only on a build machine
- `pnpm lint` — ESLint over the workspace
- `pnpm typecheck` — strict TypeScript over Node and web projects
- `pnpm test` — 179 unit and integration tests (2 more are skipped by default
  because they spend real provider quota; see below)
- `pnpm build` — electron-vite production build
- `pnpm verify:app` — starts the built application headlessly (Xvfb) and drives
  the real renderer through the preload bridge: a streamed answer, a collapsed
  tool call, a real shell echoing back, the file browser, the git branch and
  changes, the command palette, the usage popover and the settings and
  providers views. Since this milestone it also proves that a skill switched on
  for a session reaches the provider as instructions, that an MCP server which
  cannot start is reported instead of thrown, that a session can be given
  access to a server, and that connecting an account never falls back to
  plaintext. It then runs a second time against the same database to prove a
  conversation and its provider session survive a restart.

Additionally, and deliberately outside the default run:

- `AI_WORKBENCH_REAL_PROVIDER=1 pnpm test` drives the installed Claude Code CLI
  through the whole stack. It was run once for this milestone: the tool was
  detected with its version, an answer streamed back, real account usage was
  reported by the provider, and a second turn resumed the same conversation.

Last full run: all checks passed.

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
- **remote MCP transports (G4)** are not implemented. The configuration model
  accepts them, and the manager reports such a server as `unsupported` with the
  reason, rather than failing silently or pretending to connect.

## G0 — Repository / Foundation — 5%

- [x] pnpm workspace configured
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
- [ ] remote MCP config supported
- [x] session MCP selection works
- [x] ToolBridge abstraction works
- [x] plugin/provider separation remains intact

Not exercised here: a successful encrypt/decrypt round trip through the
operating system's own secret storage. The container running the checks has no
secret service, so what was proven is the other half — that the application
refuses to store a secret at all rather than falling back to plaintext. The
round trip needs one run on a desktop.

## G5 — Autonomous team system — 20%

- [ ] TeamDefinition persisted
- [ ] team agent definitions persisted
- [ ] Lead Agent selectable
- [ ] TeamRun persisted
- [ ] Task Graph works
- [ ] dependencies work
- [ ] ready/blocked transitions work
- [ ] Agent Mailbox works
- [ ] Shared Team State works
- [ ] Decision Log works
- [ ] Artifact registry works
- [ ] Team Event Bus works
- [ ] Team MCP server launches
- [ ] agent can read team state
- [ ] agent can create task
- [ ] task can be delegated
- [ ] worker can complete task
- [ ] result reaches Lead Agent
- [ ] independent tasks can run concurrently
- [ ] TeamOrchestrator enforces concurrency
- [ ] max calls/tasks/depth/runtime enforced
- [ ] agent ping-pong protection works
- [ ] failure recovery works
- [ ] team can finish a goal
- [ ] team run can survive app restart
- [ ] at least two different MockProvider agents collaborate end-to-end
- [ ] at least two real provider adapters can collaborate when available
- [ ] Team UI shows state without becoming permanently cluttered

## G6 — Status Island & background runtime — 10%

- [ ] system tray works
- [ ] main window can hide while runtime continues
- [ ] Status Island is a separate Electron window
- [ ] island show/hide works
- [ ] island position persists
- [ ] multi-monitor handling works reasonably
- [ ] automatic mode exists
- [ ] manual widget cycling works
- [ ] pinned widget works
- [ ] Usage widget works
- [ ] Active Agents widget works
- [ ] Needs Attention widget works
- [ ] Team Progress widget works
- [ ] Completed Work widget works
- [ ] Error widget works
- [ ] priority engine is tested
- [ ] high-priority event temporarily overrides low-priority widget
- [ ] user can open relevant main-app context from Island
- [ ] Island returns to compact state after event handling
- [ ] Island remains unobtrusive when idle
- [ ] Island preferences are configurable
- [ ] no fake progress percentages are displayed

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
