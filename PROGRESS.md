# AI Workbench — Project Progress

Progress is based only on verified acceptance criteria in `AI_WORKBENCH_MASTER_SPEC.md`.

## Summary

| Goal | Area | Weight | Completion | Weighted |
|---|---|---:|---:|---:|
| G0 | Foundation | 5% | 0% | 0.0% |
| G1 | First functional vertical slice | 15% | 0% | 0.0% |
| G2 | Provider platform | 15% | 0% | 0.0% |
| G3 | Workspace/developer tooling | 10% | 0% | 0.0% |
| G4 | Skills, plugins and MCP | 10% | 0% | 0.0% |
| G5 | Autonomous team system | 20% | 0% | 0.0% |
| G6 | Status Island/background runtime | 10% | 0% | 0.0% |
| G7 | UX, security, reliability, performance | 10% | 0% | 0.0% |
| G8 | Extensibility, SDK, packaging | 5% | 0% | 0.0% |
| **TOTAL** |  | **100%** |  | **0.0%** |

## Current focus

**G0 — Foundation**

No acceptance criterion may be checked until verified locally.

## G0 — Foundation

- [ ] pnpm workspace
- [ ] Electron launches
- [ ] React/TypeScript renderer launches
- [ ] TypeScript strict mode
- [ ] Vitest configured
- [ ] SQLite + Drizzle configured
- [ ] migrations work
- [ ] safe typed IPC baseline
- [ ] structured logging baseline
- [ ] design tokens baseline
- [ ] build/typecheck/test scripts

## G1 — First functional vertical slice

- [ ] create/persist workspace
- [ ] choose working directory
- [ ] create/persist session
- [ ] select MockProvider/model
- [ ] send message
- [ ] streaming response
- [ ] cancel response
- [ ] persist conversation
- [ ] restart/resume session
- [ ] mock usage
- [ ] aggregated usage hover/focus
- [ ] command palette
- [ ] settings
- [ ] target design language visible

## Notes

- Regressions must uncheck affected criteria.
- Do not estimate completion subjectively.
- Full acceptance criteria for G2–G8 are defined in `AI_WORKBENCH_MASTER_SPEC.md` and should be copied/expanded here when those goals become active.
