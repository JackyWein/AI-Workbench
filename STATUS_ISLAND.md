# Status Island

**Status: not implemented yet (goal G6).** This document records the intended
architecture. The requirements are in `AI_WORKBENCH.md` §95–§102.

The Status Island is a small floating companion window. Its purpose is that the
user does not need the main window visible to know what AI Workbench is doing,
while background work continues.

## Architecture

```text
Domain Event Bus
      ↓
StatusAttentionService
      ├── Priority engine
      ├── Widget registry
      ├── Attention queue
      └── Island state
      ↓
Status Island window (separate BrowserWindow)
```

Subsystems publish domain events and know nothing about the island. All
priority decisions live in `StatusAttentionService`, never scattered across UI
components. The event bus this will subscribe to already exists
(`packages/core/src/event-bus.ts`).

## Priority

```text
100 user action required
 90 permission or security action
 80 agent blocked or critical error
 70 provider or MCP failure affecting work
 60 project or team completed
 50 important task completed
 40 active project or team progress
 30 agent activity
 20 provider usage
 10 idle
```

Automatic mode follows this order; the user can pin a widget instead.

## Widgets

Provider Usage, Active Agents, Needs Attention, Team Progress, Project
Activity, Completed Work, Errors, Connection Health — registered through a
registry so plugins can add their own later.

## Honesty

The island never fabricates progress. Team progress is derived from the task
graph; a solo session shows a semantic state such as Planning or Implementing,
not a percentage. Usage that is unknown is shown as unavailable.

## Window behaviour

Frameless, compact, optionally always on top, draggable, multi-monitor aware,
with persisted position and preferences, and a lifecycle independent of the
main window. It expands briefly for important events and returns to its compact
state afterwards, and it can be disabled entirely.
