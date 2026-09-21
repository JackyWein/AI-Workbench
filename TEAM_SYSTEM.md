# Team system

**Status: implemented and running (goal G5).** A team of agents takes a goal,
breaks it into tasks, works on them concurrently and reports back, persisted as
it happens and resumable after a restart. What is not done yet is two real
providers collaborating and handing the Team MCP server to a provider that
speaks MCP; see `PROGRESS.md`. The requirements are in `AI_WORKBENCH.md`
§39–§53.

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

## The building blocks

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

They live in `@ai-workbench/team`, which depends on nothing but the shared
domain model and the provider contract: it names no provider and knows nothing
about the database, Electron or the UI. `TeamManager` in `@ai-workbench/core`
owns the lifecycle and puts runs in SQLite.

## How an agent acts

Both paths end in the same `TeamService` calls, so a team never depends on
which providers it happens to contain:

- **`ai-workbench-team-mcp`** — the agent-facing protocol, with the 21 tools
  from §42. Each connection is scoped to one agent, so its id comes from the
  connection and never from the arguments; nobody can act as someone else. A
  refusal comes back as an answer with its reason rather than a failed call.
- **Action blocks** — the same operations written into an answer, inside
  ```` ```team ```` fences, for a provider that does not speak MCP. The
  orchestrator parses them, applies them and tells the agent about anything it
  could not use.

## What the orchestrator does, and what it refuses to do

It schedules ready tasks across agents up to the run's concurrency, applies the
actions that come back, fails a task an agent left open, detects a stalled
graph and stops for a reason it can name. It decides nothing about the work
itself: what the tasks are, who should do them and whether the goal is reached
belong to the agents.

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
