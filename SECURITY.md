# Security

## Renderer isolation

The renderer window runs with:

```ts
contextIsolation: true;
nodeIntegration: false;
sandbox: true;
webviewTag: false;
```

It has no filesystem access, no child processes, no database handle and no
Node built-ins. External links are opened in the user's browser instead of
inside the application shell.

## The bridge is an allowlist

`window.workbench` exposes a narrow, window-specific bridge: the main window
gets `invoke(channel, input)`, `onEvent`, `onTerminalEvent` and `onNavigate`,
while the island page gets only its own `workbenchIsland` bridge
(`onState/open/dismiss/cycle`). The preload rejects any channel that is not
part of the IPC contract, and there is no channel that executes arbitrary
code, runs a shell command or reads a path chosen by the renderer.

Because a sandboxed preload cannot load packages from `node_modules`, the
preload bundle is fully self-contained and is built as CommonJS on purpose: an
ESM preload would require `sandbox: false`.

## Every payload is validated

Each channel declares a Zod input schema in
`packages/shared/src/ipc/contract.ts`. The main process parses the payload
before any service is touched and rejects what does not match, including
oversized input. Handler errors are converted into a plain message, so no stack
trace or internal path is returned to the renderer.

## Path boundaries

A session's working directory is resolved with `resolveInsideRoot`, which
rejects traversal (`../`), absolute paths outside the workspace and siblings
that merely share a name prefix. A workspace path must exist and be a directory
before it is accepted.

## Secrets

No secret is stored in plaintext configuration and no secret is exposed to the
renderer. The provider configuration and every plugin account carry a
`credentialReference`, never a key; resolving a reference happens in the main
process.

The `CredentialManager` encrypts through the operating system's own secret
storage — the Keychain on macOS, DPAPI on Windows, and the secret service on
Linux — via Electron's `safeStorage`. Where no such storage is available the
application **refuses to store the secret** and says why. There is no weaker
fallback, because a secret a user believes is protected must never sit in the
clear. The running application is checked against exactly this: connecting an
account either stores it through the operating system or fails with the reason,
and what comes back to the renderer never contains the secret.

Logs redact anything named like a secret (`apiKey`, `token`, `accessToken`,
`refreshToken`, `password`, `secret`, `credential`, `authorization`) at the
logger level, so a careless call site cannot leak one.

## Provider trust

Provider output is treated as data. It is normalized by the adapter into a
closed set of events, and the UI renders message content as text — never as
HTML. Provider-native permission, approval and sandbox systems are respected
rather than bypassed.

## Content Security Policy

The renderer document sets a CSP that allows only same-origin scripts and
connections, with no remote script sources.

## Reporting

This is a local desktop application without a server component. Security issues
should be reported through the repository's issue tracker.
