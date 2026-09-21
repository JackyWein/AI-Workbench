# AI Workbench

A local desktop environment for using multiple AI providers, persistent project
sessions, shared skills, plugins and MCP servers, and autonomous multi-agent
teams — from one application.

**Simple by default. Powerful on demand. Provider-independent from the first
line of code.**

## Current state

The foundation and the first vertical slice work end to end:

- create a workspace from a folder, create sessions inside it
- pick a provider and a model, send a message, watch the answer stream in
- stop a running answer; the partial turn is kept
- everything is persisted in SQLite and restored after a restart, including the
  provider-native session, so the conversation continues where it left off
- provider usage in a compact indicator with an aggregated popover that opens on
  hover, keyboard focus or click
- command palette (Ctrl+K / Cmd+K), settings and a providers overview

The only provider today is **MockProvider**, a full local simulation of
streaming, delays, status changes, tool calls, errors, usage and session resume.
Real provider adapters are the next goal.

See `PROGRESS.md` for what is verified, measured only from acceptance criteria
that a run of `pnpm verify` actually proves.

## Quick start

```bash
pnpm install
pnpm dev
```

Then: add a workspace with the button next to the title, create a session, and
send a message. Try `/tool`, `/error` or `/slow` in a message to exercise the
simulated tool calls, failures and delays.

To check a production build the way CI does:

```bash
pnpm verify
```

## Documentation

| File | Contents |
|---|---|
| `AI_WORKBENCH.md` | The authoritative specification |
| `CLAUDE.md` | Rules for coding agents working in this repository |
| `ARCHITECTURE.md` | How the running system is put together |
| `PROVIDERS.md` | The provider contract and how to add one |
| `SECURITY.md` | Renderer isolation, IPC validation, secrets |
| `TEAM_SYSTEM.md` | Planned autonomous team architecture (G5) |
| `STATUS_ISLAND.md` | Planned floating companion window (G6) |
| `DEVELOPMENT.md` | Setup, commands, layout, conventions |
| `PROGRESS.md` | Verified progress against the specification |
| `docs/adr/` | Architecture decision records |

## Principles that shape the code

- **Provider independence.** No generic service branches on a provider name.
  The UI enables features from capabilities, and every provider normalizes its
  output into the same event stream.
- **The renderer is untrusted.** Context isolation, no Node integration, a
  sandboxed renderer and a narrow IPC contract where every payload is validated.
- **Nothing is invented.** Usage that a provider does not report is shown as
  unavailable, and progress is derived from real state rather than estimated.
