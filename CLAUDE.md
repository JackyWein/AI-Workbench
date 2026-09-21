# CLAUDE.md — AI Workbench

Read `AI_WORKBENCH.md` before making architectural or implementation changes.

## Core rules

1. Keep the application provider-independent.
2. Never put Claude/Codex/Gemini-specific branches in generic core services.
3. Provider-specific behavior belongs in adapters.
4. Provider identity and transport are separate abstractions.
5. Use typed, validated IPC. Renderer has no direct Node access.
6. Do not store secrets in plaintext or expose them to the renderer.
7. Do not use browser cookie/session scraping as a provider integration strategy.
8. Build vertical, working slices instead of broad unfinished scaffolding.
9. Run typecheck, tests and build after meaningful changes.
10. Keep `PROGRESS.md` honest and based only on verified acceptance criteria.
11. Do not begin autonomous Team Mode before the first functional vertical slice is stable.
12. Preserve the Quiet UI / progressive-disclosure design language.
13. Never invent provider usage or project progress.
14. Respect provider-native permissions, sandboxing and approval flows.
15. Never knowingly leave the repository in a broken state.

## Starting workflow

If this is a fresh repository:

1. Read `AI_WORKBENCH.md`.
2. Read `PROGRESS.md`.
3. Briefly state the planned repository structure, domain interfaces, data flow and first vertical slice.
4. Implement G0 Foundation.
5. Implement G1 first functional vertical slice.
6. Verify with typecheck/tests/build.
7. Update `PROGRESS.md`.

## Intended first vertical slice

Launch app → create workspace → choose folder → create solo session → select MockProvider/model → send message → stream response → show mock usage → aggregated usage hover/focus → persist → restart → continue same session.

## UI principle

**Simple by default. Powerful on demand.**

Use a calm, minimal desktop UI with progressive disclosure, restrained translucency, subtle motion, no emoji UI icons, no excessive cards and no fake dashboards.

## Team architecture

Team MCP is the agent-facing protocol. TeamOrchestrator is deterministic runtime software. They are not the same component.

Agents collaborate through tasks, mailbox messages, shared state, decisions and artifacts; Team Mode is not just broadcasting the same prompt to several models.

## Status Island

The floating Status Island is a separate companion window driven through `StatusAttentionService` and a priority engine. It must remain optional, minimal, configurable and honest about progress/usage.
