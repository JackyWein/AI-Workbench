# 4. Team MCP server and Team Orchestrator are separate components

Date: 2026-09-21
Status: Accepted (design fixed before implementation)

## Context

Autonomous teams need two different things: a way for agents to act on the team
(create a task, delegate it, publish an artifact), and a deterministic runtime
that decides what actually runs, when, and within which limits.

## Decision

The Team MCP server is the agent-facing protocol only. The Team Orchestrator is
deterministic software — never an LLM — responsible for agent lifecycle,
scheduling, concurrency, timeouts, failure handling, loop protection and
recovery. Between them sits a Team Service owning the task graph, mailboxes,
shared state, decisions and artifacts.

## Consequences

- Autonomy limits are enforced in one place that no agent can talk its way past
- A team run is reproducible and recoverable, because its state transitions are
  ordinary code
- Agents keep semantic authority: the orchestrator does not make design
  decisions
- More components than a single "team agent" loop, which is the point

## Alternatives considered

- **A lead agent that orchestrates directly**: the loop limits, scheduling and
  recovery would live inside a prompt, which cannot be verified or tested
