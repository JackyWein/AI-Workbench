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

## Parallelism: together, not one after another

Independent tasks run **concurrently as one batch**, up to the run's
`maxConcurrentAgents` (default 3, max 16). The loop takes every runnable task
that fits the remaining capacity (`runnable.slice(0, min(capacity,
remainingCalls))`) and waits for the batch with `#waitForBatch`, which tracks
each member turn in a set and races them — one slow member never serialises the
others. A batch never spends more agent calls than the run has left. Only tasks
with unmet `dependsOn`/blocked dependencies wait; everything else runs at the
same time.

A user's note to the lead never waits behind a batch and never kills it: the
wait checks every 250 ms (`notifyLeadMessage` / unread user mail) and runs the
lead priority turn **alongside** the members still in flight, guarded so only
one lead turn runs at a time and skipped while the lead itself is working. The
UI shows this: the run header carries an "N parallel" pill while two or more
tasks run, the member strip reads "N of M at work", each running turn keeps its
own "Working" tag with live steps, and the timeline keeps every member's live
progress row visible at once.

## Autonomy limits

Every run is bounded by configured limits: agent calls, tasks, task depth,
runtime, failures, concurrent agents, messages and delegations per task. They
exist to prevent infinite loops, agent ping-pong and uncontrolled provider use,
and the user can always pause or stop a run.

## Provider independence

Team core must not name a provider. An agent references a provider id from the
registry, so any mix of adapters can form a team.

## Team MCP handover

`#adapterForAgent` wraps each agent's adapter in a `TeamScopedAdapter` that
injects the agent's tool access at session creation: its selected servers plus
its scoped team MCP server (one scope per run and agent). Providers without
MCP support run unchanged on action blocks, and a failed resolution keeps the
turn running without tool access instead of failing it.

## Per-agent provider and model

Each agent stores its own `providerId` plus an optional `modelId`, so one team
can mix adapters and models freely. The adapter is resolved per agent at
runtime; team core still names no provider.

## Crash recovery resets tasks

`resumeRun` returns finished runs as-is but resets every task a dead process
left `claimed` or `running` back to `ready` (`startedAt` cleared) before
driving again — otherwise the run stalls forever with in-flight work nothing
waits for.

## Definition of done

The list in `AI_WORKBENCH.md` §130 applies in full: a goal reaches the lead,
work is created and delegated, a worker returns a result that reaches the lead,
the task graph updates live, limits are enforced, and the run survives a
restart — all without manual prompt relaying.
