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
- a real shell per session (Ctrl+`), a workspace file browser and the git
  branch and changes, all bounded to the session's working directory

Providers are pluggable and the core never names one:

- **MockProvider** — a full local simulation of streaming, delays, status
  changes, tool calls, errors, usage and session resume, used by the tests
- **Claude Code** — the real CLI, driven non-interactively. Verified end to end:
  detection, streaming answers, account usage reported by the tool itself, and
  conversations resumed across turns and restarts
- **Codex**, **Antigravity** and the older **Gemini CLI** — shipped as profiles
  built on the same machinery, but not yet verified against those tools, which
  the app says plainly

A command line provider is described by a profile — executable, flags, output
shape — so adding or fixing one is configuration, not a code change. None of
these tools can print the models an account may use, so only Claude Code ships
a list; for the others you enter the models you have under **Providers**, and
they become the session's model picker.

Skills, plugins and MCP servers are part of the application, not of a provider:

- **Skills** are provider-neutral instructions, switched on globally, per
  workspace or per session, with the narrowest scope winning. They are imported
  from a folder of Markdown or Claude-style skills and composed into whatever
  the provider is given for that turn
- **Plugins** carry access to an external service, and the account behind one is
  connected once and shared by every plugin of the same service
- **MCP servers** are configured once and each session decides which of them it
  may use. A server that will not start is reported with the reason; remote
  transports are honestly marked unsupported rather than faked
- **Secrets** go into the operating system's own storage. Where there is none,
  the application refuses to store them rather than writing them in the clear

**Teams** work on one goal together. A lead breaks it into tasks, the other
agents pick them up and run concurrently, publish what they produce and report
back, and the lead closes the goal — with no prompt relayed by hand. Every run
is bounded (calls, tasks, depth, runtime, failures, concurrency, messages,
delegations), persisted as it happens, and resumable after a restart. Agents
reach each other through the team, either through `ai-workbench-team-mcp` or,
for providers without MCP, through the same operations written as action
blocks.

See `PROGRESS.md` for what is verified, measured only from acceptance criteria
that a run of `pnpm verify` actually proves.

## Quick start

```bash
pnpm install
pnpm dev
```

Then: add a workspace with the button next to the title, create a session, and
send a message. Try `/tool`, `/error` or `/slow` in a message to exercise the
MockProvider's simulated tool calls, failures and delays.

Open **Providers** to see which command line tools were found on your machine,
and to correct an executable path if one lives somewhere unusual.

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
