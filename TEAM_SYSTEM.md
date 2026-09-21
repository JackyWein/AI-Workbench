# Team system

**Status: not implemented yet (goal G5).** This document records the intended
architecture so that nothing built earlier contradicts it. The requirements are
in `AI_WORKBENCH.md` §39–§53.

Team Mode is not "send the same prompt to several models". Agents collaborate
through tasks, messages, shared state, decisions and artifacts, without the user
relaying anything by hand.

## Two components that must stay separate

```text
Agent
  ↓  (tools)
Team MCP server        agent-facing protocol
  ↓
Team Service           task graph, mailboxes, shared state, decisions, artifacts
  ↓
Team Orchestrator      deterministic runtime: lifecycle, scheduling, limits
```

The MCP server is how an agent talks to the team. The Orchestrator is ordinary
deterministic software — never an LLM — and makes no semantic design decisions;
those belong to the agents.

## Planned building blocks

| Component | Responsibility |
|---|---|
| `TeamDefinition` | Persisted team with agents and a selectable lead |
| `TeamRun` | One goal execution, persisted and recoverable after a restart |
| Task graph | DAG with dependencies and ready/blocked transitions |
| Mailboxes | Directed agent-to-agent messages |
| Shared state | Goal, summary, plan and context, instead of whole histories |
| Decision log | Why something was decided |
| Artifacts | Code, diffs, docs, reports produced by agents |
| Event bus | Team events for the UI and the Status Island |

## Autonomy limits

Every run is bounded by configured limits: agent calls, tasks, task depth,
runtime, failures, concurrent agents, messages and delegations per task. They
exist to prevent infinite loops, agent ping-pong and uncontrolled provider use,
and the user can always pause or stop a run.

## Provider independence

Team core must not name a provider. An agent references a provider id from the
registry, so any mix of adapters can form a team.

## Definition of done

The list in `AI_WORKBENCH.md` §130 applies in full: a goal reaches the lead,
work is created and delegated, a worker returns a result that reaches the lead,
the task graph updates live, limits are enforced, and the run survives a
restart — all without manual prompt relaying.
