# AI Workbench — Complete Master Specification

> **Status:** Authoritative implementation specification  
> **Primary audience:** Claude Code / Claude Opus and other coding agents working inside this repository  
> **Project type:** Local desktop AI workspace and orchestration platform  
> **Implementation strategy:** Incremental, testable, provider-independent vertical slices  
> **Core rule:** No provider-specific logic in the generic application core

---

# 0. Purpose of this document

This file is the single authoritative technical and product specification for AI Workbench.

A coding agent working in this repository must:

1. Read this file before making architectural changes.
2. Read `CLAUDE.md` for repository-specific working rules.
3. Read `PROGRESS.md` before choosing the next implementation task.
4. Preserve the architecture described here unless a change is clearly justified.
5. Update documentation and `PROGRESS.md` when implementation status changes.
6. Never silently remove or simplify requirements from this specification.

This document is intentionally detailed. Do not reduce the project scope merely because a shorter implementation is easier.

If a requirement cannot be implemented because of an external provider limitation:

1. document the limitation,
2. preserve the abstraction,
3. implement a graceful fallback,
4. never fake support.

---

# 1. Product mission

Build a real local desktop application called **AI Workbench**.

AI Workbench is a central desktop environment for using multiple AI providers, local AI tools, shared project files, skills, plugins, MCP servers, terminals, Git integrations, provider usage data and autonomous multi-agent teams from one application.

It must support both:

- independent single-agent sessions,
- autonomous multi-agent team sessions.

Example:

```text
Workspace: Home Assistant
  Claude session
  Codex session

Workspace: Minecraft
  Gemini session

Workspace: AI Workbench
  Claude architecture session
  Codex implementation session
  Gemini UX review session
  Team session: Claude + Codex + Gemini
```

Every session may have its own:

- provider,
- model,
- working directory,
- provider-native session,
- conversation history,
- enabled skills,
- enabled plugins,
- enabled MCP servers,
- terminal state,
- UI state,
- runtime state.

The user must be able to add future providers without redesigning the application.

---

# 2. Core product philosophy

AI Workbench is not an AI model.

It is an:

- orchestration layer,
- integration layer,
- session manager,
- workspace manager,
- tool platform,
- MCP platform,
- skill platform,
- plugin platform,
- provider abstraction,
- multi-agent coordination platform,
- background AI runtime.

The actual intelligence comes from connected AI providers.

The application must use provider-native functionality where possible instead of trying to recreate provider intelligence.

---

# 3. Non-negotiable provider-independence rule

The entire core must remain provider-independent.

Do not write generic core logic such as:

```ts
if (provider === "claude") {
  ...
}
```

or:

```ts
switch (providerName) {
  case "gemini":
    ...
}
```

Provider-specific behavior belongs exclusively in provider adapters.

The generic application core must use:

- interfaces,
- registries,
- capabilities,
- transports,
- normalized events,
- generic tool bridges.

The application must remain conceptually compatible with:

- Claude,
- Codex,
- Gemini,
- Llama,
- Mistral,
- Qwen,
- local models,
- OpenAI-compatible APIs,
- future providers,
- custom CLI providers,
- custom API providers.

---

# 4. Primary technology stack

Prefer:

## Desktop
- Electron

## Frontend
- React
- TypeScript

## Build
- Vite
- suitable Electron/Vite tooling

## Package management
- pnpm
- pnpm workspaces

## State
- Zustand

## Database
- SQLite

## ORM
- Drizzle ORM

## Validation
- Zod

## Terminal backend
- node-pty

## Terminal frontend
- xterm.js

## Tests
- Vitest

## Logging
- pino or equivalent structured logger

## Icons
- Lucide or similar restrained icon set

Avoid unnecessary heavy frameworks.

---

# 5. Electron security baseline

Required:

```ts
contextIsolation = true;
nodeIntegration = false;
```

Use:

- preload scripts,
- typed IPC,
- Zod validation,
- explicit privileged services.

The React renderer must not directly access:

- filesystem APIs,
- child processes,
- raw credentials,
- OS keychains,
- database internals,
- shell execution,
- unrestricted Node APIs.

Do not expose a generic arbitrary command-execution IPC API.

---

# 6. High-level architecture

```text
AI Workbench
│
├── Desktop Shell
│   ├── Main Window
│   ├── Floating Status Island
│   └── System Tray
│
├── React UI
│   ├── Workspaces
│   ├── Sessions
│   ├── Chat
│   ├── Terminal
│   ├── Files
│   ├── Git
│   ├── Providers
│   ├── Models
│   ├── Skills
│   ├── Plugins
│   ├── MCP
│   ├── Team
│   └── Settings
│
├── Core Services
│   ├── SessionManager
│   ├── WorkspaceManager
│   ├── ProviderManager
│   ├── ProviderRegistry
│   ├── SkillManager
│   ├── PluginManager
│   ├── CredentialManager
│   ├── ProcessManager
│   ├── MCPManager
│   ├── ToolBridge
│   ├── UsageService
│   ├── StatusAttentionService
│   └── TeamOrchestrator
│
├── Provider Adapter Layer
│   ├── MockProviderAdapter
│   ├── ClaudeProviderAdapter
│   ├── CodexProviderAdapter
│   ├── GeminiProviderAdapter
│   └── CustomProviderAdapters
│
├── Provider Transports
│   ├── CLITransport
│   ├── HTTPTransport
│   ├── OpenAICompatibleTransport
│   ├── MCPTransport
│   └── CustomTransport
│
├── Shared Services
│   ├── Filesystem
│   ├── Git
│   ├── Terminal
│   ├── Skills
│   ├── Plugins
│   └── MCP
│
└── Team System
    ├── Team MCP Server
    ├── Team Service
    ├── Agent Registry
    ├── Task Graph
    ├── Agent Mailboxes
    ├── Shared State
    ├── Decision Log
    ├── Artifacts
    ├── Event Bus
    └── Team Orchestrator
```

---

# 7. Monorepo structure

Preferred:

```text
apps/
  desktop/

packages/
  core/
  database/
  shared/
  ui/

  processes/
  credentials/

  providers/
    base/
    transports/
      cli/
      http/
      openai-compatible/
      mcp/
    mock/
    claude/
    codex/
    gemini/

  sessions/
  workspaces/
  skills/
  plugins/
  mcp/

  team/
    protocol/
    service/
    orchestrator/
    task-graph/
    shared-state/
    team-mcp/

  status-island/
```

This may be adjusted if a clearly better structure is justified, but preserve separation of concerns.

---

# 8. Provider Adapter system

This is one of the most important architecture components.

Implement a provider-neutral interface.

Example:

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

  createSession(
    config: ProviderSessionConfig
  ): Promise<ProviderSessionInfo>;

  resumeSession?(
    providerSessionId: string,
    config: ProviderSessionConfig
  ): Promise<ProviderSessionInfo>;

  sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage
  ): AsyncIterable<ProviderEvent>;

  cancel(
    session: ProviderSessionHandle
  ): Promise<void>;

  destroySession(
    session: ProviderSessionHandle
  ): Promise<void>;

  getUsage?(): Promise<ProviderUsageSnapshot>;
}
```

The exact interface may evolve, but provider independence must not.

---

# 9. Provider metadata

At minimum:

```ts
interface ProviderMetadata {
  id: string;
  displayName: string;
  description?: string;

  adapterVersion: string;
  providerVersion?: string;

  icon?: string;
  website?: string;

  authMethods: AuthMethod[];
  transportTypes: ProviderTransportType[];
}
```

---

# 10. Provider capabilities

Capabilities must be explicit and queryable.

Examples:

- chat
- streaming
- sessionResume
- terminal
- filesystem
- nativeTools
- MCP
- OAuth
- apiKey
- cliAuthentication
- images
- vision
- web
- codeExecution
- structuredOutput
- usage
- modelSelection
- reasoningModes
- contextInformation
- backgroundWork
- toolCalls

The UI must show or hide functionality based on capabilities instead of provider names.

---

# 11. Provider and transport separation

Provider identity and provider transport are separate abstractions.

Possible transports:

- CLI
- HTTP API
- OpenAI-compatible API
- MCP
- local process
- remote process
- custom

Examples:

```text
ClaudeProviderAdapter -> CLITransport
LocalLLMProviderAdapter -> OpenAICompatibleTransport
```

A provider must not be permanently coupled to one connection method.

---

# 12. Generic CLI transport

Implement reusable CLI process infrastructure.

It must support:

- executable path,
- argument arrays,
- working directory,
- environment variables,
- stdin,
- stdout,
- stderr,
- parser strategy,
- cancellation,
- timeout,
- exit handling,
- health checks,
- session strategy.

Use:

- `child_process.spawn`
- `node-pty` when terminal emulation is required.

Do not build unsafe shell command strings if argument arrays can be used.

---

# 13. Normalized Provider Events

All providers normalize their output into common events.

Possible event types:

```ts
type ProviderEvent =
  | TextDeltaEvent
  | MessageEvent
  | StatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
  | WarningEvent
  | ErrorEvent
  | SessionEvent
  | CompletedEvent;
```

Event names may include:

- `text_delta`
- `message`
- `status`
- `tool_call`
- `tool_result`
- `usage`
- `warning`
- `error`
- `session`
- `completed`

The UI must never parse provider-specific stdout.

---

# 14. Authentication

Supported approaches may include:

- official CLI login,
- OAuth,
- API key,
- official API,
- provider-supported local authentication,
- no auth for local models.

Do not implement:

- browser cookie theft,
- token extraction from browser profiles,
- browser session hijacking,
- provider security bypasses,
- fragile DOM scraping of consumer AI websites.

Adapters may report:

- installed,
- not installed,
- authenticated,
- authentication required,
- authentication expired,
- unsupported.

---

# 15. Provider configuration

Example:

```ts
interface ProviderConfig {
  id: string;
  adapterId: string;

  transport: ProviderTransportType;

  authType:
    | "cli"
    | "oauth"
    | "apiKey"
    | "none"
    | "custom";

  executablePath?: string;
  arguments?: string[];
  environmentVariables?: Record<string, string>;

  baseUrl?: string;
  credentialReference?: string;

  defaultModel?: string;

  settings?: Record<string, unknown>;
}
```

API keys are not phase-one priority, but architecture must support them.

---

# 16. Custom providers

Later, the user should be able to add providers via UI.

Example:

```text
Name: Local Llama
Adapter: OpenAI Compatible
Base URL: http://localhost:11434/v1
API Key: optional
Model: llama
```

or:

```text
Name: Company AI
Adapter: Custom CLI
Executable: company-ai
Arguments: ...
```

Adding such providers must not require core changes.

---

# 17. Provider Registry

Implement conceptually:

```ts
providerRegistry.register(adapter)
providerRegistry.unregister(id)
providerRegistry.get(id)
providerRegistry.list()
providerRegistry.getAvailable()
```

Long-term external provider packages should be registerable without core edits.

---

# 18. Provider discovery

Adapters should detect where possible:

- CLI installed,
- executable path,
- version,
- authentication state,
- available models,
- capabilities,
- usage support,
- MCP support.

Missing providers must never crash the app.

---

# 19. Provider Settings UI

A central Provider screen should show:

- installed / not installed,
- authenticated / authentication required,
- CLI version,
- default model,
- capabilities,
- usage availability,
- executable location,
- connection health.

Allow:

- connect,
- disconnect,
- configure,
- select model,
- configure API URL,
- assign credential reference,
- add custom provider.

---

# 20. MockProvider

Implement very early.

It must simulate:

- streaming,
- provider delay,
- errors,
- usage,
- status changes,
- tool calls,
- session resume,
- model selection,
- context information.

This enables end-to-end testing without paid provider calls.

---

# 21. First real providers

After MockProvider:

1. integrate one real supported CLI provider end-to-end,
2. validate the adapter abstraction,
3. add Claude adapter,
4. add Codex adapter,
5. add Gemini adapter.

Use the best officially supported local access path available for each provider.

Do not let any real provider shape the generic core.

---

# 22. Sessions

Persistent sessions should support:

```ts
interface Session {
  id: string;
  name: string;

  type: "solo" | "team";

  providerId?: string;
  modelId?: string;

  workspaceId: string;
  workingDirectory: string;

  providerSessionId?: string;

  enabledSkills: string[];
  enabledPlugins: string[];
  enabledMcpServers: string[];

  settings: Record<string, unknown>;
  uiState: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}
```

---

# 23. Session resume

If provider supports native session resume:

- persist provider-native session ID,
- resume after app restart.

If not:

- reconstruct necessary context from stored history/state.

Expose this through provider capabilities.

---

# 24. Workspaces

Example:

```ts
interface Workspace {
  id: string;
  name: string;
  path: string;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

One workspace can contain multiple sessions.

---

# 25. Working directories

Each session has an explicit working directory.

It may be:

- workspace root,
- workspace subdirectory.

All file access must use centralized safe abstractions.

Prevent:

- path traversal,
- accidental access outside permitted roots,
- silent cross-workspace access.

---

# 26. Terminal

Every session may have a real terminal.

Backend:
- node-pty

Frontend:
- xterm.js

Requirements:

- starts in session working directory,
- stdin,
- streaming output,
- resize,
- cancellation,
- cleanup,
- later multiple tabs.

Session runtime must be separate from visible UI state.

---

# 27. Files

Implement a safe file browser.

Requirements:

- workspace-aware,
- path-safe,
- open/edit/save,
- file-change state,
- later diff integration,
- no unrestricted filesystem exposure.

---

# 28. Git integration

Support:

- current branch,
- dirty state,
- changed files,
- diff view,
- repository context.

Do not force Git usage if a workspace is not a repository.

---

# 29. Skills

Skills are provider-neutral instructions, knowledge or workflows.

Examples:

- React,
- Git,
- Docker,
- Home Assistant,
- Minecraft Server Administration,
- Code Review,
- Security Review,
- Testing.

Example manifest:

```ts
interface SkillManifest {
  schemaVersion: string;

  id: string;
  name: string;
  description: string;
  version: string;

  instructions: string;

  requiredCapabilities?: string[];
  tools?: string[];
  mcpDependencies?: string[];

  metadata?: Record<string, unknown>;
}
```

---

# 30. Skill scopes

Skills can be enabled at:

- global,
- workspace,
- session.

Precedence:

```text
session overrides workspace overrides global
```

SkillManager computes the final effective skill set.

---

# 31. Existing skill import

Design importer architecture for existing external skill formats.

Examples:

- ClaudeSkillImporter,
- GenericMarkdownSkillImporter,
- CustomSkillImporter.

Internally use a provider-neutral format.

Example:

```text
skills/
  react/
    manifest.json
    instructions.md
```

---

# 32. Plugins

Plugins are external capabilities/services.

Examples:

- Gmail,
- Google Drive,
- Google Calendar,
- GitHub,
- Notion,
- Home Assistant.

Skills and plugins are separate concepts.

---

# 33. Plugin manifest

Example:

```ts
interface PluginManifest {
  schemaVersion: string;

  id: string;
  name: string;
  description?: string;
  version: string;

  authentication?: PluginAuthenticationDefinition;
  tools: PluginToolDefinition[];

  permissions?: string[];
  configuration?: unknown;
  capabilities?: string[];
}
```

---

# 34. Central plugin accounts

Where possible, authenticate once to a service.

Example:

One Google account should be usable by:

- Gmail,
- Drive,
- Calendar.

Provider sessions should not each require separate service login.

AI Workbench owns the external account connection.

Sessions and agents receive permission to use the plugin.

---

# 35. Plugin scopes

Plugins may be enabled at:

- global,
- workspace,
- session,
- team agent.

---

# 36. Tool Bridge

Different providers expose tools differently.

Implement ToolBridge strategies for:

- provider-native tool calls,
- MCP,
- host-mediated execution,
- CLI MCP integration,
- provider-specific tool protocols.

The core should ask which bridge is available for a session, not which provider brand is being used.

---

# 37. MCP as first-class functionality

MCP must be central.

MCPManager manages:

- local MCP servers,
- remote MCP servers.

Example:

```ts
interface MCPServerConfig {
  id: string;
  name: string;

  transport:
    | "stdio"
    | "http"
    | "sse";

  command?: string;
  args?: string[];
  env?: Record<string, string>;

  url?: string;

  enabled: boolean;
}
```

Sessions choose which MCP servers they may access.

---

# 38. MCP per session

The user can configure:

- enabled MCP servers per session,
- enabled MCP servers per team agent.

ProviderAdapter/ToolBridge determines how those servers are exposed to the provider.

---

# 39. Team Mode

A Team Session may contain arbitrary provider-backed agents.

Examples:

```text
Claude + Codex + Gemini
Claude + Claude + Codex
Local Llama + Gemini + Custom Provider
```

No provider names may be hardcoded in Team Core.

---

# 40. Team definition

Example:

```ts
interface TeamDefinition {
  id: string;
  name: string;
  workspaceId: string;

  leadAgentId?: string;
  agents: AgentDefinition[];

  settings: TeamSettings;
}
```

Agent:

```ts
interface AgentDefinition {
  id: string;
  displayName: string;

  providerId: string;
  modelId?: string;

  role?: string;

  workingDirectory: string;

  skills: string[];
  plugins: string[];
  mcpServers: string[];

  settings: Record<string, unknown>;
}
```

---

# 41. Autonomous team collaboration

Team Mode must not mean sending the same prompt to several models.

Agents must actually collaborate.

Example:

```text
User gives goal
Lead analyzes goal
Lead creates backend task for Codex
Codex implements
Codex requests Gemini review
Gemini reviews
Codex fixes
Lead receives results
Lead creates more work or finishes
```

The user should not manually relay messages between agents.

---

# 42. Team MCP server

Implement:

```text
ai-workbench-team-mcp
```

Minimum tools:

- `team_get_goal`
- `team_get_state`
- `team_list_agents`
- `team_get_agent`
- `team_list_tasks`
- `team_get_task`
- `team_create_task`
- `team_claim_task`
- `team_delegate_task`
- `team_update_task`
- `team_complete_task`
- `team_fail_task`
- `team_send_message`
- `team_get_messages`
- `team_request_help`
- `team_publish_artifact`
- `team_get_artifact`
- `team_list_artifacts`
- `team_record_decision`
- `team_get_decisions`
- `team_finish_goal`

Agents communicate through the team interface instead of directly invoking each other's provider SDKs.

---

# 43. Team MCP is not the orchestrator

Required architecture:

```text
AI Agent
   │
   ▼
Team MCP Server
   │
   ▼
Team Service
   │
   ├── Task Graph
   ├── Mailboxes
   ├── Shared State
   ├── Decisions
   └── Artifacts
   │
   ▼
Team Orchestrator
```

The MCP server is the agent-facing protocol.

The TeamOrchestrator is deterministic runtime software.

---

# 44. TeamOrchestrator responsibilities

The TeamOrchestrator is not an LLM.

It manages:

- agent lifecycle,
- provider session startup,
- provider session cleanup,
- task queue,
- scheduling,
- concurrency,
- timeouts,
- failures,
- deadlock detection,
- loop protection,
- event delivery,
- persistence,
- recovery.

It must not make semantic architecture decisions that belong to agents.

---

# 45. Task Graph

Use a graph/DAG where useful.

```ts
interface TeamTask {
  id: string;
  title: string;
  description: string;

  status:
    | "pending"
    | "ready"
    | "claimed"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";

  createdBy: string;
  assignedTo?: string;

  parentTaskId?: string;
  dependencies: string[];

  priority?: number;

  result?: string;
  artifacts?: string[];

  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  error?: string;
}
```

Independent tasks may run concurrently.

---

# 46. Agent mailbox

```ts
interface TeamMessage {
  id: string;
  from: string;
  to: string;

  type:
    | "info"
    | "question"
    | "request"
    | "result"
    | "warning"
    | "handoff";

  content: string;
  taskId?: string;

  timestamp: Date;
}
```

---

# 47. Shared Team State

Avoid sending entire chat histories between agents.

```ts
interface SharedTeamState {
  goal: string;
  summary: string;
  currentPlan?: string;

  importantContext: string[];

  decisions: string[];
  tasks: string[];
  artifacts: string[];
  agents: string[];
}
```

---

# 48. Decision log

Persist important team decisions.

```ts
interface TeamDecision {
  id: string;
  author: string;

  title: string;
  reason: string;
  decision: string;

  relatedTasks: string[];

  timestamp: Date;
}
```

---

# 49. Artifacts

Agents may publish:

- code,
- diffs,
- architecture docs,
- tests,
- reports,
- research,
- generated files.

```ts
interface Artifact {
  id: string;
  name: string;
  type: string;

  path?: string;

  createdBy: string;
  taskId?: string;

  metadata?: Record<string, unknown>;

  timestamp: Date;
}
```

---

# 50. Team events

Emit events such as:

- TEAM_STARTED
- TEAM_FINISHED
- AGENT_STARTED
- AGENT_STOPPED
- AGENT_FAILED
- TASK_CREATED
- TASK_ASSIGNED
- TASK_STARTED
- TASK_BLOCKED
- TASK_COMPLETED
- TASK_FAILED
- MESSAGE_SENT
- ARTIFACT_PUBLISHED
- DECISION_RECORDED
- HELP_REQUESTED
- USER_ATTENTION_REQUIRED

Main UI and Status Island consume relevant events.

---

# 51. Loop protection and autonomy limits

Autonomous runs must be bounded.

```ts
interface TeamRunConfig {
  maxAgentCalls: number;
  maxTasks: number;
  maxTaskDepth: number;
  maxRuntimeMinutes: number;
  maxFailures: number;
  maxConcurrentAgents: number;
  maxMessages: number;
  maxDelegationsPerTask: number;
}
```

Initial defaults may be:

```text
maxAgentCalls = 30
maxTasks = 50
maxTaskDepth = 8
maxRuntimeMinutes = 60
maxFailures = 10
maxConcurrentAgents = 3
maxMessages = 200
maxDelegationsPerTask = 4
```

Prevent:

- infinite loops,
- agent ping-pong,
- recursive delegation explosions,
- uncontrolled task creation,
- uncontrolled provider use.

---

# 52. Lead Agent

Version 1 should support a selectable Lead Agent.

Lead responsibilities:

- understand goal,
- produce initial work breakdown,
- create/delegate tasks,
- inspect results,
- create follow-up tasks,
- decide when work is complete.

Later support decentralized teams.

---

# 53. Team recovery

Persist Team Runs.

After restart/crash:

- restore run,
- restore task graph,
- restore messages,
- restore decisions,
- restore artifacts,
- mark disconnected agents,
- determine resumability,
- resume or pause cleanly.

---

# 54. Provider permissions and safety

Respect provider-native:

- permission modes,
- sandboxing,
- approval modes,
- tool permissions.

AI Workbench must not bypass those security systems.

Team Mode may work autonomously only within user-configured provider permissions.

Avoid redundant approval prompts after every tiny action if the provider already manages that safely.

---

# 55. Usage system

A provider may optionally expose usage.

```ts
interface ProviderUsageSnapshot {
  providerId: string;
  modelId?: string;

  limits: UsageLimit[];

  updatedAt: Date;

  source:
    | "provider"
    | "cli"
    | "api"
    | "estimated";
}
```

```ts
interface UsageLimit {
  id: string;
  label: string;

  used?: number;
  remaining?: number;
  total?: number;

  unit:
    | "percent"
    | "tokens"
    | "requests"
    | "credits"
    | "time";

  resetsAt?: Date;
}
```

---

# 56. Usage truthfulness

Never invent provider usage.

Possible states:

- available,
- partial,
- unavailable,
- estimated.

Estimated values must be clearly labeled.

If unknown:

```text
Usage unavailable
```

---

# 57. CredentialManager

Never store secrets in plaintext configuration.

Prefer OS-backed secure storage:

- Windows Credential Manager,
- macOS Keychain,
- Linux Secret Service/keyring.

Renderer should deal with credential references rather than raw secrets.

Never log secrets.

---

# 58. Database

Use SQLite + Drizzle migrations.

Minimum tables:

- workspaces
- sessions
- chat_messages
- providers
- provider_configs
- skills
- workspace_skills
- session_skills
- plugins
- plugin_accounts
- workspace_plugins
- session_plugins
- mcp_servers
- session_mcp_servers
- teams
- team_agents
- team_runs
- team_tasks
- team_messages
- team_events
- team_decisions
- artifacts
- terminals
- settings
- status_island_preferences
- status_attention_events

---

# 59. Logging

Structured categories:

- CORE
- DATABASE
- IPC
- PROVIDER
- PROCESS
- SESSION
- WORKSPACE
- SKILL
- PLUGIN
- MCP
- TEAM
- TERMINAL
- STATUS_ISLAND

Levels:

- debug
- info
- warn
- error

Never log raw credentials.

---

# 60. Graceful failure

The app must remain usable if:

- provider CLI is missing,
- login expired,
- provider process exits,
- MCP crashes,
- plugin goes offline,
- agent times out,
- team task fails,
- terminal exits,
- session resume fails,
- usage is unavailable,
- provider output is malformed.

Prefer graceful degradation.


---

# 61. UI design philosophy

The UI should feel:

- modern,
- calm,
- minimal,
- premium,
- professional,
- desktop-native.

Design inspiration:

- Apple-style restraint,
- modern macOS,
- high-end developer tools.

But:

- do not copy Apple 1:1,
- no excessive glassmorphism,
- no cards everywhere,
- no neon gradients,
- no gaming UI,
- no cyberpunk UI,
- no emoji interface icons,
- no visual clutter.

---

# 62. Quiet UI

Default view shows only what matters now.

Secondary information appears through:

- hover,
- focus,
- click,
- context menu,
- command palette,
- expanded view.

The interface should be simple despite a complex backend.

---

# 63. Progressive disclosure

Example:

Default:

```text
Claude Sonnet
68%
```

Hover/focus:

```text
Claude

Model:
Claude Sonnet

Authentication:
Connected

CLI:
Installed

Usage:
Weekly 68% remaining

Context:
...

MCP:
3 connected
```

---

# 64. Hover as a secondary information layer

Use hover/focus popovers for:

- providers,
- models,
- usage,
- skills,
- plugins,
- MCP,
- agents,
- tasks,
- workspaces,
- Git status,
- context usage,
- terminal status,
- connection status.

Important data must also be reachable by keyboard focus or click.

---

# 65. Usage hover

Hovering a compact usage indicator should show all connected/installed provider usage where available.

Example:

```text
Usage

Claude
Weekly
68% remaining

Codex
5 hour window
42% remaining

Gemini
Daily
91% remaining

Updated 2 minutes ago
```

Unknown data remains unknown.

---

# 66. Provider hover

May show:

- provider name,
- active model,
- connection status,
- CLI version,
- auth status,
- usage,
- context,
- MCP status,
- active session.

---

# 67. Skill hover

May show:

- name,
- description,
- source,
- version,
- effective scope,
- required tools,
- required MCP servers.

---

# 68. MCP hover

May show:

- server name,
- transport,
- status,
- latency,
- exposed tools,
- session access.

---

# 69. Agent hover

For team sessions:

Default:

```text
Claude
Working
```

Expanded:

```text
Claude

Provider:
Anthropic

Model:
...

Role:
Lead

Task:
Design architecture

Runtime:
01:42

Status:
Working

Messages:
2 waiting
```

---

# 70. Team UI

Do not show a giant permanent monitoring dashboard.

Standard compact state:

```text
Team
3 agents
2 active tasks
```

Dedicated Team View may show:

- overview,
- tasks,
- agents,
- messages,
- artifacts,
- decisions,
- timeline,
- task DAG.

---

# 71. Translucency

Subtle translucency is allowed for:

- popovers,
- command palette,
- floating toolbar,
- context menus,
- Status Island.

Avoid excessive blurred glass panels.

---

# 72. Visual hierarchy

Prefer:

- spacing,
- typography,
- whitespace,
- subtle surface differences,
- thin separators.

Avoid:

- heavy borders,
- shadows everywhere,
- card grids.

---

# 73. Typography

Use system-native/high-quality sans-serif.

Hierarchy via:

- size,
- weight,
- spacing.

Not via excessive colors.

---

# 74. Color system

Mostly neutral colors.

Dark mode first.

Semantic color only for:

- active,
- running,
- connected,
- selected,
- success,
- warning,
- error.

Provider branding should be subtle.

---

# 75. Icons

No emoji icons.

Use a consistent minimal icon system such as Lucide.

---

# 76. Animations

Keep motion restrained.

Typical duration:

- 120–180 ms.

Good:

- opacity,
- slight translation,
- subtle scale on overlays.

Avoid:

- bounce,
- dramatic zoom,
- constant decorative movement.

---

# 77. App shell

Base layout:

```text
LEFT SIDEBAR | CENTER CONTENT | OPTIONAL RIGHT CONTEXT
```

Sidebar:

- Workspaces
- Sessions
- Team
- Search

Bottom:

- Providers
- Skills
- Plugins
- Settings

Sidebar should support compact mode.

---

# 78. Session header

Keep it compact.

Possible visible information:

- session name,
- workspace,
- provider,
- model,
- usage,
- working directory,
- Solo/Team indicator.

Secondary actions should be hidden in:

- overflow menu,
- context menu,
- command palette,
- hover details.

---

# 79. Chat UI

Assistant messages should be document-like.

Avoid giant bubble styling.

User messages may be more visually separated.

Streaming must be smooth.

Tool calls should collapse by default.

Example:

```text
Terminal
3 commands
```

or:

```text
Filesystem
4 files changed
```

Click to expand.

---

# 80. Context sidebar

Optional right sidebar may show compact:

- provider,
- model,
- workspace,
- Git branch,
- context,
- skills,
- plugins,
- MCP,
- team state.

---

# 81. Command Palette

Keyboard:

- Ctrl+K
- Cmd+K

Commands may include:

- New Session
- New Team Session
- Switch Workspace
- Switch Session
- Switch Provider
- Switch Model
- Open Terminal
- Open Files
- Enable Skill
- Disable Skill
- Connect Provider
- Open Plugin
- Open Team Tasks
- Open Settings
- Toggle Status Island
- Pin Status Island View

---

# 82. Global search

Later support search across:

- sessions,
- workspaces,
- commands,
- skills,
- plugins,
- files,
- team tasks.

---

# 83. Context menus

Use context menus where appropriate.

Workspace example:

- Open
- New Session
- New Team Session
- Open Folder
- Git
- Settings
- Delete Workspace

---

# 84. Empty states

Keep them minimal.

Avoid huge illustrations.

Example:

```text
No sessions

New Session
```

---

# 85. Responsive desktop behavior

Desktop first, but support different window sizes.

At narrow widths:

- collapse context sidebar,
- compact main sidebar,
- preserve access to advanced information.

---

# 86. Accessibility

Hover must never be the only access path.

Support:

- keyboard navigation,
- keyboard focus,
- click expansion,
- ARIA where useful,
- visible focus states.

---

# 87. Design tokens

Centralize:

- colors,
- surfaces,
- text,
- muted text,
- borders,
- accent,
- success,
- warning,
- error,
- spacing,
- radii,
- shadows,
- animation durations,
- font sizes,
- z-index.

Avoid scattered magic values.

---

# 88. Reusable UI components

Build reusable components such as:

- Popover
- Tooltip
- ContextMenu
- CommandPalette
- StatusIndicator
- UsageIndicator
- ProviderBadge
- AgentStatus
- TaskStatus
- SkillIndicator
- PluginIndicator
- SidebarItem
- SessionTab
- TerminalPanel
- SplitPane
- FloatingStatusIsland

---

# 89. Provider Usage Indicator

Create compact usage display.

Standard may be:

- small bar,
- small ring,
- percentage.

It must remain visually secondary.

Hover/focus opens aggregated provider usage.

---

# 90. Model Picker

Compact by default.

Click opens model selector.

Entries may show:

- model name,
- context length,
- capabilities,
- usage,
- reasoning mode,

if available.

---

# 91. Session switching

Switching visible session must not automatically destroy provider process.

Separate:

- visible UI state,
- session runtime state,
- provider process lifecycle.

---

# 92. Multi-session

Support several active sessions.

Later:

- tabs,
- split view,
- pinned sessions.

---

# 93. Team Activity presentation

Do not flood the main UI.

Compact summary:

```text
Claude
Planning

Codex
Implementing provider registry

Gemini
Waiting
```

Click opens detailed timeline.

---

# 94. Team Task View

Dedicated Team view may include:

- overview,
- tasks,
- agents,
- messages,
- artifacts,
- decisions,
- timeline,
- dependency graph.

Use graph only where useful.

---

# 95. Floating Status Island

Implement an optional floating companion UI inspired by the idea of a dynamic island, but not an Apple clone.

Purpose:

The user should not need the main AI Workbench window visible to understand what is happening.

Main window may be:

- minimized,
- hidden,
- closed to tray,

while AI Workbench continues background work and the Status Island remains available.

Use a dedicated Electron `BrowserWindow`.

Desired properties:

- frameless,
- compact,
- transparent where technically appropriate,
- optional always-on-top,
- draggable,
- multi-monitor aware,
- non-intrusive,
- separate from main-window lifecycle,
- configurable startup behavior,
- configurable position.

Positions:

- top center,
- top left,
- top right,
- custom location.

---

# 96. Status Island compact states

Examples:

```text
Claude · Working
```

```text
Claude 68%   Codex 42%
```

```text
AI Workbench · Idle
```

```text
AI Workbench · 3 agents active
```

The default surface must be extremely compact.

---

# 97. Status Island expansion

For relevant events the island may expand temporarily.

Examples:

```text
AI Workbench

Codex needs your attention
Terminal action requires confirmation

Open     Dismiss
```

or:

```text
AI Workbench

Project completed
11 / 11 tasks finished

Open project
```

After handling or timeout, return to compact mode.

---

# 98. Status Island widgets

Use a registry.

Initial widgets:

## Provider Usage

Shows available provider usage.

## Active Agents

Shows agent activity.

## Needs Attention

Shows actions requiring the user.

## Team Progress

Shows measurable task progress.

## Project Activity

Shows build/test/implementation state.

## Completed Work

Shows recent completions.

## Errors

Shows meaningful failures.

## Connection Health

Shows provider/MCP/plugin connection issues.

Future plugins should be able to register island widgets.

---

# 99. Status Island Priority Engine

Suggested priority:

```text
100 User action required
90  Permission/security action required
80  Agent blocked / critical error
70  Provider or MCP failure affecting work
60  Project/team completed
50  Important task completed
40  Active project/team progress
30  Agent activity
20  Provider usage
10  Idle
```

Centralize this logic in `StatusAttentionService`.

Do not scatter priority decisions across UI components.

---

# 100. Manual Island switching

User may:

- click,
- scroll,
- use keyboard shortcut,
- context menu,
- command palette

to cycle widgets.

Pinning examples:

```text
Pin: Usage
Pin: AI Workbench project
Pin: Active Agents
Automatic
```

Automatic mode uses the priority engine.

---

# 101. Status Island preferences

Settings may include:

```text
Status Island
[x] Enabled
[x] Start with AI Workbench
[x] Stay visible when main window is hidden
[x] Always on top
[x] Auto expand for important events

Display:
[ Active monitor ]

Position:
[ Top center ]

Default idle widget:
[ Provider Usage ]

Auto rotate:
[ Off / 5s / 10s / 30s ]

Enabled widgets:
[x] Needs Attention
[x] Active Agents
[x] Team Progress
[x] Provider Usage
[x] Completed Tasks
[x] Errors
```

---

# 102. StatusAttentionService

Do not couple every subsystem directly to Island UI.

Required architecture:

```text
Domain Event Bus
      │
      ▼
StatusAttentionService
      │
      ├── Priority Engine
      ├── Widget Registry
      ├── Notification State
      ├── Attention Queue
      └── Island State
              │
              ▼
       Status Island Window
```

Sources may emit:

- AGENT_NEEDS_INPUT
- TASK_COMPLETED
- TEAM_PROGRESS_CHANGED
- PROVIDER_USAGE_UPDATED
- PROVIDER_DISCONNECTED
- MCP_FAILED
- BUILD_STARTED
- BUILD_COMPLETED
- TESTS_FAILED
- TEAM_FINISHED

---

# 103. Honest project progress

Never invent project percentages.

For Team Mode derive progress from task state.

Example:

```text
11 tasks total
7 completed
2 running
1 pending
1 blocked

Progress = 7 / 11 = 64%
```

If weighted tasks are introduced later, document weighting.

For Solo sessions without task graph, use semantic states:

- Planning
- Implementing
- Testing
- Reviewing
- Waiting

instead of fake percentages.

---

# 104. System tray and background runtime

Support main window hidden while work continues.

System tray should allow:

- Open AI Workbench
- Show/Hide Status Island
- View active sessions
- Pause autonomous runs
- Stop all active work
- Quit

Closing main window should be configurable:

- quit,
- minimize to tray.

Background work must never become invisible and uncontrollable.

---

# 105. Typed IPC architecture

Use typed IPC domains.

Examples:

```text
workspace.list
workspace.create
workspace.update
workspace.delete

session.list
session.create
session.update
session.sendMessage
session.cancel
session.resume

provider.list
provider.getStatus
provider.getCapabilities
provider.getUsage

terminal.create
terminal.input
terminal.resize
terminal.close

skill.list
skill.enable
skill.disable

plugin.list
plugin.connect
plugin.disconnect

mcp.list
mcp.start
mcp.stop

team.create
team.start
team.pause
team.resume
team.stop
team.getState

statusIsland.getState
statusIsland.setPreference
statusIsland.show
statusIsland.hide
statusIsland.pinWidget
```

Validate all payloads.

---

# 106. Domain Event Bus

Use domain events to decouple systems.

Examples:

- SessionCreated
- SessionStarted
- SessionStopped
- ProviderConnected
- ProviderDisconnected
- ProviderUsageUpdated
- TeamTaskCreated
- TeamTaskCompleted
- AgentNeedsInput
- ProjectProgressChanged
- StatusAttentionCreated

Main UI and Status Island subscribe only to relevant event streams.

---

# 107. Background services

Potential background services:

- provider health checks,
- MCP health checks,
- usage refresh,
- team runtime,
- progress calculation,
- status attention.

Avoid excessive polling.

Respect provider rate limits.

---

# 108. Usage refresh

Only fetch usage if supported.

Cache usage.

Suggested default:

- 1–5 minute refresh depending on source/provider.

Do not spam providers.

---

# 109. Settings

Settings areas:

- General
- Appearance
- Providers
- Models
- Skills
- Plugins
- MCP
- Team
- Status Island
- Credentials
- Advanced
- Developer

---

# 110. Appearance

Dark mode first.

Prepare for:

- Light
- System

Optional:

- Accent color
- Density: Comfortable / Compact

---

# 111. Developer Mode

Optional developer mode can expose:

- raw normalized provider events,
- provider stdout/stderr,
- IPC inspector,
- MCP logs,
- team event stream,
- process logs,
- status attention events.

Keep hidden by default.

---

# 112. Performance

Requirements:

- virtualize long chats,
- virtualize long logs,
- paginate/virtualize team events,
- avoid unnecessary React rerenders,
- process streaming efficiently,
- cache metadata sensibly,
- debounce expensive UI updates.


---

# 113. Testing strategy

Tests must cover at least:

- ProviderRegistry
- provider capabilities
- GenericCLITransport
- MockProvider
- SessionManager
- WorkspaceManager
- session persistence
- Skill resolution
- Plugin scope resolution
- credential references
- MCP configuration validation
- Task Graph
- Team Orchestrator
- loop protection
- Agent Mailbox
- Shared Team State
- Usage aggregation
- Status priority engine
- Island widget selection
- IPC validation

Tests must not trigger paid AI calls.

---

# 114. Documentation

Maintain:

- `README.md`
- `ARCHITECTURE.md`
- `PROVIDERS.md`
- `TEAM_SYSTEM.md`
- `STATUS_ISLAND.md`
- `SECURITY.md`
- `DEVELOPMENT.md`
- `PROGRESS.md`

Use ADRs for major decisions.

Examples:

- why Electron,
- why SQLite,
- why provider/transport separation,
- why Team MCP and Orchestrator are separate,
- why StatusAttentionService is separate from Island UI.

---

# 115. Required project progress tracking

`PROGRESS.md` is mandatory.

Progress must be measured from verified acceptance criteria, not intuition.

Do not write:

```text
Project is about 80% complete
```

unless calculated from goals.

Regressions may lower progress.

---

# 116. Overall weighted goals

| Goal | Area | Weight |
|---|---|---:|
| G0 | Repository/Foundation | 5% |
| G1 | Functional Desktop Vertical Slice | 15% |
| G2 | Provider Platform | 15% |
| G3 | Workspace/Developer Tooling | 10% |
| G4 | Skills, Plugins & MCP | 10% |
| G5 | Autonomous Team System | 20% |
| G6 | Status Island & Background Runtime | 10% |
| G7 | UX, Security, Reliability & Performance | 10% |
| G8 | Extensibility, SDK & Packaging | 5% |
| **Total** |  | **100%** |

---

# 117. G0 — Repository/Foundation — 5%

Acceptance criteria:

- [ ] pnpm workspace configured
- [ ] Electron app launches
- [ ] React + TypeScript renderer launches
- [ ] TypeScript strict mode enabled
- [ ] lint/typecheck scripts exist
- [ ] Vitest configured
- [ ] SQLite + Drizzle configured
- [ ] migration system works
- [ ] typed preload IPC baseline exists
- [ ] structured logging baseline exists
- [ ] design token baseline exists
- [ ] CI/basic automated verification exists if practical

G0 is complete only when all critical baseline criteria pass locally.

---

# 118. G1 — Functional Desktop Vertical Slice — 15%

Acceptance criteria:

- [ ] create workspace
- [ ] persist workspace
- [ ] choose working directory
- [ ] create session
- [ ] persist session
- [ ] select MockProvider
- [ ] select mock model
- [ ] send message
- [ ] stream response
- [ ] cancel response
- [ ] persist conversation
- [ ] restart app
- [ ] reopen workspace/session
- [ ] conversation still exists
- [ ] provider/session state restores safely
- [ ] usage mock appears
- [ ] aggregated usage hover/focus works
- [ ] command palette works
- [ ] settings open
- [ ] main UI uses target design language

This is the first true product milestone.

---

# 119. G2 — Provider Platform — 15%

Acceptance criteria:

- [ ] provider adapter contract stable
- [ ] transport abstraction stable
- [ ] provider registry works
- [ ] capability model works
- [ ] MockProvider complete
- [ ] generic CLI transport works
- [ ] provider installation discovery works
- [ ] authentication state reporting works
- [ ] normalized provider streaming works
- [ ] provider errors normalize correctly
- [ ] provider cancellation works
- [ ] session cleanup works
- [ ] model listing works
- [ ] session resume supported where provider supports it
- [ ] first real provider works end-to-end
- [ ] Claude adapter implemented if supported
- [ ] Codex adapter implemented if supported
- [ ] Gemini adapter implemented if supported
- [ ] missing provider does not break app
- [ ] API/custom provider config architecture exists

---

# 120. G3 — Workspace/Developer Tooling — 10%

Acceptance criteria:

- [ ] safe filesystem layer
- [ ] working-directory boundaries
- [ ] integrated terminal
- [ ] terminal resize/input/output
- [ ] terminal cleanup
- [ ] file browser
- [ ] file change representation
- [ ] Git status
- [ ] Git branch display
- [ ] tool call collapsible UI
- [ ] session runtime independent from visible tab
- [ ] multiple sessions can remain active
- [ ] context sidebar works
- [ ] useful keyboard navigation exists

---

# 121. G4 — Skills, Plugins & MCP — 10%

Acceptance criteria:

- [ ] SkillManager implemented
- [ ] global/workspace/session skill scopes work
- [ ] effective skill resolution tested
- [ ] internal provider-neutral skill format exists
- [ ] at least one skill importer works
- [ ] PluginRegistry implemented
- [ ] plugin scope model works
- [ ] central account model exists
- [ ] CredentialManager works
- [ ] MCPManager works
- [ ] local MCP stdio server can connect
- [ ] remote MCP config supported
- [ ] session MCP selection works
- [ ] ToolBridge abstraction works
- [ ] plugin/provider separation remains intact

---

# 122. G5 — Autonomous Team System — 20%

Acceptance criteria:

- [ ] TeamDefinition persisted
- [ ] team agent definitions persisted
- [ ] Lead Agent selectable
- [ ] TeamRun persisted
- [ ] Task Graph works
- [ ] dependencies work
- [ ] ready/blocked transitions work
- [ ] Agent Mailbox works
- [ ] Shared Team State works
- [ ] Decision Log works
- [ ] Artifact registry works
- [ ] Team Event Bus works
- [ ] Team MCP server launches
- [ ] agent can read team state
- [ ] agent can create task
- [ ] task can be delegated
- [ ] worker can complete task
- [ ] result reaches Lead Agent
- [ ] independent tasks can run concurrently
- [ ] TeamOrchestrator enforces concurrency
- [ ] max calls/tasks/depth/runtime enforced
- [ ] agent ping-pong protection works
- [ ] failure recovery works
- [ ] team can finish a goal
- [ ] team run can survive app restart
- [ ] at least two different MockProvider agents collaborate end-to-end
- [ ] at least two real provider adapters can collaborate when available
- [ ] Team UI shows state without becoming permanently cluttered

---

# 123. G6 — Status Island & Background Runtime — 10%

Acceptance criteria:

- [ ] system tray works
- [ ] main window can hide while runtime continues
- [ ] Status Island is a separate Electron window
- [ ] island show/hide works
- [ ] island position persists
- [ ] multi-monitor handling works reasonably
- [ ] automatic mode exists
- [ ] manual widget cycling works
- [ ] pinned widget works
- [ ] Usage widget works
- [ ] Active Agents widget works
- [ ] Needs Attention widget works
- [ ] Team Progress widget works
- [ ] Completed Work widget works
- [ ] Error widget works
- [ ] priority engine is tested
- [ ] high-priority event temporarily overrides low-priority widget
- [ ] user can open relevant main-app context from Island
- [ ] Island returns to compact state after event handling
- [ ] Island remains unobtrusive when idle
- [ ] Island preferences are configurable
- [ ] no fake progress percentages are displayed

---

# 124. G7 — UX, Security, Reliability & Performance — 10%

Acceptance criteria:

- [ ] renderer has no direct Node integration
- [ ] IPC inputs validated
- [ ] secrets are not stored in plaintext
- [ ] secrets do not appear in logs
- [ ] provider crashes are isolated
- [ ] MCP crashes are isolated
- [ ] malformed provider output does not crash app
- [ ] long chats are performant
- [ ] long logs are performant
- [ ] keyboard navigation usable
- [ ] hover information has focus/click alternative
- [ ] dark mode polished
- [ ] visual hierarchy follows Quiet UI principles
- [ ] no excessive card UI
- [ ] no emoji UI icons
- [ ] command palette usable throughout app
- [ ] important background work is always controllable
- [ ] graceful shutdown cleans processes
- [ ] tests cover critical failure paths

---

# 125. G8 — Extensibility, SDK & Packaging — 5%

Acceptance criteria:

- [ ] provider package contract documented
- [ ] plugin package contract documented
- [ ] manifest schema versions exist
- [ ] custom provider UI works
- [ ] OpenAI-compatible provider works
- [ ] external provider package can register without core edits
- [ ] external plugin package can register without core edits
- [ ] production packaging works
- [ ] clean install starts successfully
- [ ] upgrade/migration path documented

---

# 126. Progress calculation

`PROGRESS.md` should contain:

```md
# Project Progress

| Goal | Weight | Completion | Weighted |
|---|---:|---:|---:|
| G0 Foundation | 5 | 100% | 5.0 |
| G1 Vertical Slice | 15 | 60% | 9.0 |
| G2 Provider Platform | 15 | 20% | 3.0 |
| ... | ... | ... | ... |
| TOTAL | 100 | | 17.0% |
```

Within each goal, calculate completion from verified acceptance items.

Example:

```text
G1 has 20 acceptance criteria.
12 verified = 60% goal completion.
15% × 60% = 9 percentage points.
```

Critical regressions must uncheck criteria.

---

# 127. Current work selection rule

When deciding what to implement next:

1. Prefer incomplete criteria in the current active goal.
2. Implement dependencies before dependents.
3. Prefer vertical working slices over broad scaffolding.
4. Do not start Team Mode before G0/G1 foundations are stable.
5. Do not start advanced plugin UI before plugin/MCP core exists.
6. Do not spend large effort polishing low-priority visuals while core workflows are broken.
7. Do not sacrifice clean abstractions for provider-specific hacks.

---

# 128. Implementation phases

## Phase 0 — Foundation

Target:
- G0

## Phase 1 — First Usable Product

Target:
- G1

Vertical slice:

```text
Open app
  ↓
Create workspace
  ↓
Create session
  ↓
Choose MockProvider
  ↓
Choose working directory
  ↓
Send message
  ↓
Stream response
  ↓
Show usage
  ↓
Persist session
  ↓
Restart app
  ↓
Resume work
```

## Phase 2 — Real Provider Platform

Target:
- G2

## Phase 3 — Developer Tooling

Target:
- G3

## Phase 4 — Skills / Plugins / MCP

Target:
- G4

## Phase 5 — Autonomous Teams

Target:
- G5

## Phase 6 — Status Island

Target:
- G6

`StatusAttentionService` may be scaffolded earlier if useful, but do not let it distract from core functionality.

## Phase 7 — Hardening / UX

Target:
- G7

## Phase 8 — SDK / Packaging

Target:
- G8

---

# 129. Definition of done for any Provider

A provider adapter is not complete until:

- installation/status can be detected,
- auth state can be reported,
- models can be listed/configured,
- session can be created,
- message can be sent,
- output streams through normalized events,
- cancellation works,
- errors normalize correctly,
- cleanup works,
- capabilities are accurate,
- session resume works if supported,
- missing optional features degrade safely.

---

# 130. Definition of done for Team Mode

Team Mode is not complete until:

1. user defines a goal,
2. Lead Agent receives it,
3. Lead creates at least one task,
4. task is delegated to another agent,
5. worker processes task,
6. worker returns result,
7. result reaches Lead,
8. task graph updates,
9. team events appear live,
10. loop limits are active,
11. run persists,
12. run can finish,
13. run can recover from restart,
14. collaboration works without manual prompt relaying.

Sending the same prompt to multiple models does not count.

---

# 131. Definition of done for Status Island

Status Island is not complete until:

- it works independently of main-window visibility,
- automatic priority selection works,
- manual pinning works,
- Usage widget works,
- Active Agents widget works,
- Needs Attention widget works,
- Progress widget works,
- Completion widget works,
- Error widget works,
- state is persistent,
- important events deep-link to relevant app context,
- it remains minimal when idle,
- it can be disabled,
- it never fabricates progress.

---

# 132. Product safety and user control

Autonomy must never mean uncontrollability.

Always provide:

- cancel current response,
- pause team run,
- stop team run,
- stop all background work,
- terminate stuck process,
- inspect current work,
- see pending user attention,
- access relevant logs in Developer Mode.

Respect provider-native permission systems.

Do not bypass provider security controls.

---

# 133. No fragile browser automation as core strategy

Do not base provider support on:

- DOM scraping ChatGPT/Claude/Gemini consumer websites,
- cookie injection,
- browser token extraction,
- hidden browser automation.

Prefer:

- official CLI,
- official API,
- OAuth,
- MCP,
- supported local interfaces.

---

# 134. Coding quality

Use:

- strict TypeScript,
- small modules,
- clear interfaces,
- explicit schemas,
- dependency injection where useful,
- minimal shared mutable state,
- testable services.

Avoid:

- God classes,
- giant React components,
- untyped IPC,
- unjustified `any`,
- provider checks in core,
- massive one-file implementations.

---

# 135. Architecture documentation discipline

Whenever architecture changes:

- update relevant docs,
- update ADR if appropriate,
- update `PROGRESS.md`,
- update this specification only if the actual product requirement changes.

Do not silently diverge.

---

# 136. First task for a fresh repository

If repository is empty:

1. Create `PROGRESS.md`.
2. Create monorepo structure.
3. Configure pnpm workspace.
4. Configure Electron + React + TypeScript.
5. Enable strict TypeScript.
6. Configure Vitest.
7. Configure SQLite + Drizzle.
8. Configure migrations.
9. Create safe typed IPC baseline.
10. Create design tokens.
11. Create ProviderAdapter interfaces.
12. Create ProviderRegistry.
13. Create MockProvider.
14. Create WorkspaceManager.
15. Create SessionManager.
16. Implement the first persistent vertical slice.
17. Run typecheck/tests/build.
18. Update `PROGRESS.md`.

Do not begin Team Mode first.

---

# 137. First vertical slice

The first true end-to-end path must work:

```text
Launch AI Workbench
      ↓
Create Workspace
      ↓
Choose Folder
      ↓
Create Solo Session
      ↓
Select MockProvider
      ↓
Select Model
      ↓
Send Message
      ↓
Receive Streaming Response
      ↓
Display Mock Usage
      ↓
Hover/Focus Usage to See All Installed Provider Usage
      ↓
Persist Everything
      ↓
Restart App
      ↓
Continue Session
```

Only after this is stable should broader systems be added.

---

# 138. First implementation workflow for coding agents

Before coding:

1. inspect repository,
2. read this file,
3. read `PROGRESS.md`,
4. identify current active goal,
5. identify smallest coherent vertical slice,
6. briefly explain planned repository changes,
7. implement,
8. run typecheck,
9. run tests,
10. run build,
11. fix regressions,
12. update docs,
13. update `PROGRESS.md`.

Never knowingly leave a broken repository.

---

# 139. UI implementation quality rule

Phase 1 UI should already use the intended design language.

Do not build a deliberately ugly temporary UI that requires full replacement later.

The early UI should already include:

- Sidebar,
- Workspace list,
- Session list,
- Chat,
- Provider picker,
- Model picker,
- Working Directory selection,
- Usage indicator,
- Usage popover,
- Command Palette,
- minimal Context Panel,
- Settings,
- Provider View.

---

# 140. Provider SDK long-term goal

Eventually:

```text
npm package install
↓
provider manifest registers
↓
adapter becomes available
```

Example:

```text
@ai-workbench/provider-example
```

Core code should not need edits.

---

# 141. Plugin SDK long-term goal

Similarly:

```text
@ai-workbench/plugin-example
```

Plugin package may register:

- tools,
- authentication,
- settings UI,
- capabilities,
- optional Status Island widgets.

---

# 142. Versioned manifests

Provider, plugin and skill manifests need:

```text
schemaVersion
```

so migrations are possible later.

---

# 143. Product UX target

The application should look simple at first glance.

Example:

```text
Claude Sonnet        68%

Chat

Input
```

But deeper information should be accessible on demand:

- provider status,
- usage,
- context,
- skills,
- MCP,
- plugins,
- tasks,
- agent messages,
- raw events.

Principle:

# Simple by default. Powerful on demand.

---

# 144. Final product goal

At maturity AI Workbench should allow the user to:

- use Claude independently,
- use Codex independently,
- use Gemini independently,
- add future providers,
- add local models,
- add API-based providers,
- add custom CLI providers,
- manage persistent projects,
- maintain multiple sessions,
- use shared skills,
- use central plugins,
- authenticate external services once,
- centrally manage MCP servers,
- use integrated files,
- use integrated terminals,
- inspect Git,
- monitor provider usage where available,
- let multiple agents collaborate autonomously,
- measure project progress from real task state,
- keep the main app hidden while monitoring through Status Island,
- remain in control of all background activity.

---

# 145. Final implementation command

If this is a fresh repository:

1. inspect repository,
2. create/update `PROGRESS.md`,
3. summarize intended repository structure,
4. summarize major domain interfaces,
5. summarize UI/backend data flow,
6. implement G0,
7. implement the G1 vertical slice,
8. verify with typecheck/tests/build,
9. update `PROGRESS.md`.

Do not stop after planning unless genuinely blocked.

Keep AI Workbench provider-independent from the first line of code.

---

# 146. Final principle

**Simple by default. Powerful on demand. Provider-independent from the first line of code.**
