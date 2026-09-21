# Providers

A provider is anything that can answer a message: a CLI, an HTTP API, an
OpenAI-compatible endpoint, a local model or a simulation. The application core
knows none of them by name.

## The contract

Every provider implements `AIProviderAdapter`
(`packages/providers/base/src/adapter.ts`):

```ts
interface AIProviderAdapter {
  readonly metadata: ProviderMetadata;

  initialize(context: ProviderContext): Promise<void>;
  dispose(): Promise<void>;

  detectInstallation(): Promise<InstallationStatus>;
  getAuthenticationStatus(): Promise<AuthStatus>;
  authenticate?(request?: AuthRequest): Promise<AuthResult>;
  logout?(): Promise<void>;

  getCapabilities(): Promise<ProviderCapabilities>;
  listModels(): Promise<ModelInfo[]>;

  createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo>;
  resumeSession?(id: string, config: ProviderSessionConfig): Promise<ProviderSessionInfo>;

  sendMessage(session: ProviderSessionHandle, message: AgentMessage): AsyncIterable<ProviderEvent>;

  cancel(session: ProviderSessionHandle): Promise<void>;
  destroySession(session: ProviderSessionHandle): Promise<void>;

  getUsage?(): Promise<ProviderUsageSnapshot>;
}
```

Optional methods are genuinely optional. Anything a provider cannot do must be
absent from its capabilities so the UI hides it, rather than being faked.

## Capabilities drive the UI

The UI asks what a provider can do, never who it is. `modelSelection` decides
whether a model picker appears, `usage` whether usage is requested, and
`sessionResume` whether a provider-native session id is persisted and reused.

## Normalized events

`sendMessage` yields only these events:

`text_delta`, `message`, `status`, `tool_call`, `tool_result`, `usage`,
`warning`, `error`, `session`, `completed`

Parsing provider-specific output is the adapter's job. Nothing above the
adapter ever sees raw stdout.

## Errors

Adapters throw `ProviderError` with a normalized kind (`notInstalled`,
`authentication`, `rateLimit`, `cancelled`, `timeout`, `transport`, `protocol`,
`provider`, `unknown`) or emit an `error` event. `normalizeError` turns anything
else into the same shape and never throws itself.

## Usage truthfulness

A usage snapshot carries a `state` of `available`, `partial`, `unavailable` or
`estimated` and a `source`. A provider that cannot report usage is shown as
unavailable. Estimates are labelled as estimates. Numbers are never invented.

## Transports

Provider identity and transport are separate (ADR 3). An adapter says *what* a
provider is; a transport says *how* it is reached.

`@ai-workbench/transport-cli` is the reusable command line transport (spec §12).
It owns:

- executable resolution, either a configured path or a PATH search that honours
  `PATHEXT` on Windows
- version and health probes
- argument arrays, working directory and environment
- stdin, and stdout assembled into complete lines across chunk boundaries
- cancellation (SIGTERM, then SIGKILL after a grace period) and timeouts
- exit codes and captured stderr for error messages

There is no shell anywhere in it: arguments are always passed as an array, so
nothing needs quoting and nothing can be injected into a command string.

## Command line providers are profiles, not code

`@ai-workbench/provider-cli` contains one generic adapter driven by a validated,
versioned **profile**. The profile is the provider-specific knowledge — which
executable, which flags, which output shape — expressed as data:

```ts
{
  schemaVersion: 1,
  id: "example",
  displayName: "Example",
  command: "example-cli",
  args: ["--print", "--output-format", "stream-json"],
  modelArgs: ["--model", "{model}"],
  resumeArgs: ["--resume", "{providerSessionId}"],
  promptVia: "stdin",
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "system" }, valueKey: "session_id" },
      { emit: "text_delta", when: { type: "delta" }, valueKey: "text" },
    ],
  },
}
```

Details worth knowing:

- **Placeholders** are `{model}`, `{prompt}`, `{sessionId}` and
  `{providerSessionId}`. A group whose placeholder cannot be resolved is left
  out entirely, which is how a first turn automatically omits the resume flag.
- **`resumeMode: "replace"`** swaps the base arguments out instead of appending,
  for tools where resuming is its own subcommand.
- **`output.format: "text"`** treats every stdout line as answer text and works
  with any CLI that simply prints.
- **`output.format: "json-lines"`** maps decoded events with rules. `when` is a
  set of dot-path equality checks, and the first matching rule wins. A `*` in a
  path scans an array for the first element that resolves, which matters when a
  message holds a thinking block before the text block.
- **Usage rules** can turn a provider's own numbers into usage limits, including
  a `utilization` fraction and a reset timestamp. A CLI cannot be polled for
  usage without paying for a turn, so what it reports during a turn is
  remembered and served from there — and before any turn, usage is honestly
  reported as unavailable.

### The shipped profiles

| Profile | State |
|---|---|
| Claude Code | Flags checked against `claude --help`; event mapping verified against a recorded live stream that the test suite replays; run end to end against the installed tool |
| Codex | Starting point, **not verified** against the tool |
| Antigravity | Starting point, **not verified** against the tool. Google's replacement for the Gemini CLI, run as `agy` |
| Gemini CLI | Starting point, **not verified** against the tool. Kept for the plans that still have it |

An unverified profile says so in the application, on the provider's own screen.
It is a documented guess at the flags, not a claim that the integration works.
If a turn fails, correct the executable path and arguments there — the change is
applied immediately, without restarting.

### Models

A provider reports its own models through `listModels()`. Only Claude Code
ships a list, because it is the only one of these tools whose models are
documented alongside the flags; none of them has a command that prints the
models an account may use, so nothing is guessed on their behalf.

The Providers screen therefore has a model field: one `id` per line, or
`id = Display name`. What is entered there replaces the profile's list, is
stored with the provider configuration, and is what the session model picker
offers. A provider whose list is empty says so instead of showing an empty
picker, and the tool is left to choose its own default.

Adding an entirely new command line provider is a profile, not a code change.

## MockProvider

`packages/providers/mock` is a complete provider that runs in-process and is
used by the tests and the headless application check. Prompts can trigger its
simulations:

| Trigger | Effect |
|---|---|
| `/error` | emits a normalized provider error and completes as failed |
| `/tool` | emits a tool call followed by its result |
| `/slow` | lengthens the simulated thinking time |

It also simulates streaming, delays, status changes, model selection, session
resume and a weekly request quota.

## Adding a provider

For a command line tool, write a profile and register it:

```ts
await providers.register(new CliProviderAdapter(parseProfile(myProfile)));
```

For anything that is not a CLI, implement the adapter contract directly:

1. Create a package that exports a class implementing `AIProviderAdapter`
2. Report installation, authentication, capabilities and models honestly
3. Translate native output into normalized events
4. Register it: `await providers.register(new YourAdapter())`

Registration is the only integration point. No generic service should need a
change to support a new provider — if one does, the abstraction is wrong.

## Verifying a provider against the real tool

The default test suite never makes paid calls. A separate, opt-in test drives an
installed CLI through the entire stack:

```bash
AI_WORKBENCH_REAL_PROVIDER=1 pnpm test
```

It checks what "works end to end" has to mean: the tool is detected with its
version, an answer streams back, the provider's own session id is adopted, usage
comes from the provider, and a second turn resumes the same conversation.
