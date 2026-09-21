# AI Workbench — Project Progress

Progress is measured **only** from acceptance criteria in `AI_WORKBENCH.md` that were
verified locally. Nothing here is estimated. A regression unchecks its criteria.

Each goal's completion = checked criteria / total criteria of that goal.
Weighted contribution = weight x completion.

## Summary

| Goal | Area | Weight | Criteria | Verified | Completion | Weighted |
|---|---|---:|---:|---:|---:|---:|
| G0 | Repository / Foundation | 5% | 12 | 0 | 0% | 0.00 |
| G1 | Functional desktop vertical slice | 15% | 20 | 0 | 0% | 0.00 |
| G2 | Provider platform | 15% | 20 | 0 | 0% | 0.00 |
| G3 | Workspace / developer tooling | 10% | 14 | 0 | 0% | 0.00 |
| G4 | Skills, plugins & MCP | 10% | 15 | 0 | 0% | 0.00 |
| G5 | Autonomous team system | 20% | 28 | 0 | 0% | 0.00 |
| G6 | Status Island & background runtime | 10% | 22 | 0 | 0% | 0.00 |
| G7 | UX, security, reliability & performance | 10% | 19 | 0 | 0% | 0.00 |
| G8 | Extensibility, SDK & packaging | 5% | 10 | 0 | 0% | 0.00 |
| **TOTAL** | | **100%** | **160** | **0** | | **0.00%** |

## Current focus

**G0 — Repository / Foundation**, then the G1 vertical slice.

## How this file is verified

- `pnpm typecheck` — TypeScript strict mode over main, preload, renderer and packages
- `pnpm lint` — ESLint over the workspace
- `pnpm test` — Vitest unit tests
- `pnpm build` — electron-vite production build
- Electron launch is smoke-tested headlessly (see `DEVELOPMENT.md`)

## G0 — Repository / Foundation — 5%

- [ ] pnpm workspace configured
- [ ] Electron app launches
- [ ] React + TypeScript renderer launches
- [ ] TypeScript strict mode enabled
- [ ] lint/typecheck scripts exist
- [ ] Vitest configured
- [ ] SQLite + Drizzle configured
- [ ] migration system works
- [ ] typed preload IPC baseline exists
- [ ] structured logging baseline exists
- [ ] design token baseline exists
- [ ] CI/basic automated verification exists if practical

## G1 — Functional desktop vertical slice — 15%

- [ ] create workspace
- [ ] persist workspace
- [ ] choose working directory
- [ ] create session
- [ ] persist session
- [ ] select MockProvider
- [ ] select mock model
- [ ] send message
- [ ] stream response
- [ ] cancel response
- [ ] persist conversation
- [ ] restart app
- [ ] reopen workspace/session
- [ ] conversation still exists
- [ ] provider/session state restores safely
- [ ] usage mock appears
- [ ] aggregated usage hover/focus works
- [ ] command palette works
- [ ] settings open
- [ ] main UI uses target design language

## G2 — Provider platform — 15%

- [ ] provider adapter contract stable
- [ ] transport abstraction stable
- [ ] provider registry works
- [ ] capability model works
- [ ] MockProvider complete
- [ ] generic CLI transport works
- [ ] provider installation discovery works
- [ ] authentication state reporting works
- [ ] normalized provider streaming works
- [ ] provider errors normalize correctly
- [ ] provider cancellation works
- [ ] session cleanup works
- [ ] model listing works
- [ ] session resume supported where provider supports it
- [ ] first real provider works end-to-end
- [ ] Claude adapter implemented if supported
- [ ] Codex adapter implemented if supported
- [ ] Gemini adapter implemented if supported
- [ ] missing provider does not break app
- [ ] API/custom provider config architecture exists

## G3 — Workspace / developer tooling — 10%

- [ ] safe filesystem layer
- [ ] working-directory boundaries
- [ ] integrated terminal
- [ ] terminal resize/input/output
- [ ] terminal cleanup
- [ ] file browser
- [ ] file change representation
- [ ] Git status
- [ ] Git branch display
- [ ] tool call collapsible UI
- [ ] session runtime independent from visible tab
- [ ] multiple sessions can remain active
- [ ] context sidebar works
- [ ] useful keyboard navigation exists

## G4 — Skills, plugins & MCP — 10%

- [ ] SkillManager implemented
- [ ] global/workspace/session skill scopes work
- [ ] effective skill resolution tested
- [ ] internal provider-neutral skill format exists
- [ ] at least one skill importer works
- [ ] PluginRegistry implemented
- [ ] plugin scope model works
- [ ] central account model exists
- [ ] CredentialManager works
- [ ] MCPManager works
- [ ] local MCP stdio server can connect
- [ ] remote MCP config supported
- [ ] session MCP selection works
- [ ] ToolBridge abstraction works
- [ ] plugin/provider separation remains intact

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

- [ ] renderer has no direct Node integration
- [ ] IPC inputs validated
- [ ] secrets are not stored in plaintext
- [ ] secrets do not appear in logs
- [ ] provider crashes are isolated
- [ ] MCP crashes are isolated
- [ ] malformed provider output does not crash app
- [ ] long chats are performant
- [ ] long logs are performant
- [ ] keyboard navigation usable
- [ ] hover information has focus/click alternative
- [ ] dark mode polished
- [ ] visual hierarchy follows Quiet UI principles
- [ ] no excessive card UI
- [ ] no emoji UI icons
- [ ] command palette usable throughout app
- [ ] important background work is always controllable
- [ ] graceful shutdown cleans processes
- [ ] tests cover critical failure paths

## G8 — Extensibility, SDK & packaging — 5%

- [ ] provider package contract documented
- [ ] plugin package contract documented
- [ ] manifest schema versions exist
- [ ] custom provider UI works
- [ ] OpenAI-compatible provider works
- [ ] external provider package can register without core edits
- [ ] external plugin package can register without core edits
- [ ] production packaging works
- [ ] clean install starts successfully
- [ ] upgrade/migration path documented
