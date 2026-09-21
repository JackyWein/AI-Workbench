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

1. Create a package that exports a class implementing `AIProviderAdapter`
2. Report installation, authentication, capabilities and models honestly
3. Translate native output into normalized events
4. Register it: `await providers.register(new YourAdapter())`

Registration is the only integration point. No generic service should need a
change to support a new provider — if one does, the abstraction is wrong.
