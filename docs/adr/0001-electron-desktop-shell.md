# 1. Electron as the desktop shell

Date: 2026-09-21
Status: Accepted

## Context

AI Workbench must run local CLIs and processes, own a persistent database,
manage long-running background work, show a second floating window and a system
tray, and still offer a polished, quickly evolving UI.

## Decision

Use Electron with a React and TypeScript renderer, built by electron-vite.

## Consequences

- Node APIs are available where they are needed: the main process
- A second `BrowserWindow` gives the Status Island a real home later
- The UI stack is mainstream, which keeps the design language achievable
- The renderer must be treated as untrusted: `contextIsolation`, no Node
  integration, `sandbox: true`, and a narrow validated IPC surface
- Bundle size and memory are higher than a native shell; acceptable for a
  developer tool that hosts other processes anyway

## Alternatives considered

- **Tauri**: smaller binaries, but the ecosystem for long-running Node tooling,
  node-pty and MCP servers is weaker, and it would split the runtime story
- **Web app with a local agent**: two deployment units, no tray, no floating
  companion window, harder local process control
