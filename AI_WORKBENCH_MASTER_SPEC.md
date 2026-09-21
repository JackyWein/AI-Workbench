# AI Workbench — Master Implementation Specification

> This file is the authoritative implementation brief for coding agents working in this repository.
> Build a real local desktop application, not a static mockup. Work incrementally, keep the repository buildable, and update `PROGRESS.md` after every meaningful milestone.

## 1. Product mission

Build **AI Workbench**, a local desktop environment that can use multiple AI providers from one application.

It must support:

- Claude / Claude Code
- OpenAI / Codex
- Google Gemini
- local LLMs
- OpenAI-compatible APIs
- custom CLI/API providers
- future providers without core rewrites
- independent solo sessions
- autonomous multi-agent team sessions
- shared files, skills, plugins, MCP servers and central external-service accounts
- integrated terminal/files/Git
- provider usage reporting where actually available
- a small floating **Status Island** that can remain visible while the main app is hidden

Example:

```text
Workspace: Home Assistant
  Claude session

Workspace: Minecraft
  Codex session

Workspace: AI Workbench
  Claude architecture
  Codex implementation
  Gemini review
  Team session: Claude + Codex + Gemini
```

Every session may have its own provider, model, working directory, provider-native session, history, skills, plugins, MCP servers, runtime and UI state.

## 2. Non-negotiable rule: provider independence

The core must never depend on provider names.

Avoid logic such as:

```ts
if (provider === "claude") { ... }
```

Provider-specific behavior belongs only in provider adapters. Generic services operate through interfaces, capabilities, normalized events and registry lookups.

AI Workbench is an orchestration/integration layer, not an AI model. Use provider-native features instead of reimplementing them.

## 3. Preferred stack

- Electron
- React
- TypeScript strict mode
- Vite
- pnpm workspaces
- Zustand
- SQLite
- Drizzle ORM
- Zod
- node-pty
- xterm.js
- Vitest
- pino or equivalent structured logger
- Lucide or equivalent restrained icon set

Avoid unnecessary heavy frameworks.

## 4. Electron security

Use:

```ts
contextIsolation = true;
nodeIntegration = false;
```

Use a preload bridge and typed IPC. Validate privileged IPC payloads with Zod.

Renderer must not directly access child processes, filesystem APIs, database internals, raw credentials, shell execution or unrestricted OS APIs.

Never expose a generic "execute arbitrary Node code" bridge.

## 5. High-level architecture

```text
Desktop Shell
├── Main Window
├── Status Island Window
└── System Tray

React UI
├── Workspaces / Sessions
├── Chat
├── Terminal / Files / Git
├── Providers / Models
├── Skills / Plugins / MCP
├── Team
└── Settings

Core
├── WorkspaceManager
├── SessionManager
├── ProviderManager / ProviderRegistry
├── ProcessManager
├── CredentialManager
├── SkillManager
├── PluginManager
├── MCPManager
├── ToolBridge
├── UsageService
├── StatusAttentionService
└── TeamOrchestrator

Provider Layer
├── Base interfaces
├── Transports
│   ├── CLI
│   ├── HTTP
│   ├── OpenAI-compatible
│   ├── MCP
│   └── Custom
└── Adapters
    ├── Mock
    ├── Claude
    ├── Codex
    ├── Gemini
    └── Future providers

Team
├── Team MCP Server
├── Team Service
├── Task Graph
├── Mailboxes
├── Shared State
├── Decisions
├── Artifacts
└── Event Bus
```

Suggested monorepo:

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
    mock/
    claude/
    codex/
    gemini/
  workspaces/
  sessions/
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

## 6. Provider adapter system

Start from a generic contract similar to:

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
  resumeSession?(
    providerSessionId: string,
    config: ProviderSessionConfig
  ): Promise<ProviderSessionInfo>;

  sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage
  ): AsyncIterable<ProviderEvent>;

  cancel(session: ProviderSessionHandle): Promise<void>;
  destroySession(session: ProviderSessionHandle): Promise<void>;

  getUsage?(): Promise<ProviderUsageSnapshot>;
}
```

Improve the interface if necessary, but preserve provider independence.

Capabilities may include:

- chat
- streaming
- session resume
- model selection
- native tools
- MCP
- terminal/filesystem
- OAuth/API-key/CLI auth
- vision/images
- web
- code execution
- structured output
- usage
- context information
- background work

The UI must enable features from capabilities, not provider names.

## 7. Provider and transport separation

Provider identity and transport are separate abstractions.

Possible transports:

- CLI
- HTTP API
- OpenAI-compatible API
- MCP
- local process
- remote process
- custom

Example:

```text
ClaudeProviderAdapter -> CLITransport
LocalLLMProviderAdapter -> OpenAICompatibleTransport
```

Implement a reusable CLI transport with executable, argument arrays, cwd, env, stdin/stdout/stderr, parser strategy, cancellation, timeout, lifecycle and health checks. Use `child_process.spawn`; use `node-pty` when terminal emulation is required. Avoid unsafe shell string concatenation.

## 8. Normalized provider events

Provider-specific outputs become normalized events:

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

## 9. Authentication and configuration

Supported authentication paths may include:

- official CLI login
- OAuth
- API key
- official API
- provider-supported local auth
- no auth for local models

Never use browser-cookie theft, token scraping, session hijacking or fragile DOM automation against consumer chat sites.

Provider config may include:

```ts
interface ProviderConfig {
  id: string;
  adapterId: string;
  transport: ProviderTransportType;
  authType: "cli" | "oauth" | "apiKey" | "none" | "custom";
  executablePath?: string;
  arguments?: string[];
  environmentVariables?: Record<string, string>;
  baseUrl?: string;
  credentialReference?: string;
  defaultModel?: string;
  settings?: Record<string, unknown>;
}
```

API keys are not phase-1 priority, but the architecture must support them.

Custom provider examples:

```text
Local Llama
Adapter: OpenAI Compatible
URL: http://localhost:11434/v1
Model: llama
```

or:

```text
Company AI
Adapter: Custom CLI
Executable: company-ai
Arguments: ...
```

## 10. Provider registry/discovery

Implement registry methods conceptually equivalent to:

```ts
register()
unregister()
get()
list()
getAvailable()
```

Adapters should detect where possible:

- installation
- executable path
- version
- auth state
- models
- capabilities
- usage support
- MCP support

A missing provider must not crash the app.

Long-term, external packages such as `@ai-workbench/provider-example` should be registrable without core edits.

## 11. MockProvider and real providers

Build MockProvider early. It must simulate:

- streaming
- delays
- errors
- usage
- tool calls
- session resume
- model selection
- context info

Then integrate one real supported CLI provider end-to-end to validate the architecture. Add Claude, Codex and Gemini adapters using official/supported access paths where available.

## 12. Sessions and workspaces

Persistent session model should include:

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

Workspace:

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

If provider supports native resume, persist its session ID. Otherwise reconstruct required context from local persistence.

Validate paths and prevent path traversal.

## 13. Integrated terminal/files/Git

Terminal:

- node-pty backend
- xterm.js frontend
- starts in session cwd
- stdin/output/resize/cancel/cleanup
- later multi-tab

Add safe file browsing/editing and Git status/branch information.

Session runtime must be independent from whether its UI tab is currently visible.

## 14. Skills

Skills are provider-neutral instructions/knowledge.

Examples:

- React
- Git
- Docker
- Home Assistant
- Minecraft Server Administration
- Code Review
- Security Review

Use versioned manifests and support scopes:

```text
session overrides workspace overrides global
```

Design importers for existing formats such as Claude-style skills and generic Markdown while keeping the internal representation provider-neutral.

## 15. Plugins and central accounts

Plugins are external capabilities/services, not behavioral skills.

Examples:

- Gmail
- Google Drive
- Google Calendar
- GitHub
- Notion
- Home Assistant

A user should authenticate to a service once when possible.

One Google account may back Gmail, Drive and Calendar. Claude/Codex/Gemini sessions receive plugin access; they should not each require separate Gmail logins.

Scopes:

- global
- workspace
- session
- team agent

Use secure OS-backed credential storage. Store credential references, not plaintext secrets.

## 16. ToolBridge and MCP

Providers expose tools differently. Implement a ToolBridge abstraction supporting:

- provider-native tools
- MCP
- host-mediated execution
- CLI MCP integration
- provider-specific protocols

MCP is a first-class feature. MCPManager must manage local and remote servers and per-session access.

Support at least stdio and prepare for HTTP/SSE transports.

## 17. Team mode

Team Mode is not "send the same prompt to three models".

Agents must collaborate.

Example:

```text
User gives goal
Lead analyzes goal
Lead creates task for Codex
Codex implements
Codex requests Gemini review
Gemini reviews
Codex fixes
Lead receives results
Lead creates more work or finishes
```

No manual user relay should be necessary for normal handoffs.

Team definition includes arbitrary provider-backed agents. Provider brands must not be hardcoded in Team Core.

## 18. Team MCP

Implement `ai-workbench-team-mcp`.

Tools should include:

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

Architecture:

```text
Agent
  ↓
Team MCP
  ↓
Team Service
  ├── Task Graph
  ├── Mailboxes
  ├── Shared State
  ├── Decisions
  └── Artifacts
  ↓
Team Orchestrator
```

The MCP server is the agent-facing interface. The Orchestrator is deterministic software, not an LLM.

## 19. Team Orchestrator

Responsibilities:

- agent lifecycle
- provider session startup/cleanup
- scheduling
- task queue
- concurrency
- timeouts
- failure handling
- deadlock detection
- loop protection
- event dispatch
- persistence/recovery

It must not make semantic software-design decisions; agents do that.

Use a task DAG where appropriate. Support agent mailboxes, structured shared state, decision log and artifacts.

Independent tasks may run concurrently.

## 20. Autonomy limits

Configurable limits must include concepts such as:

- max agent calls
- max tasks
- max task depth
- max runtime
- max failures
- max concurrent agents
- max messages
- max delegations per task

Prevent infinite loops, agent ping-pong and uncontrolled provider use.

Version 1 should support a selectable Lead Agent. Later decentralized teams may be added.

Persist Team Runs and restore them after restart.

## 21. Usage

Optional provider usage model:

```ts
interface ProviderUsageSnapshot {
  providerId: string;
  modelId?: string;
  limits: UsageLimit[];
  updatedAt: Date;
  source: "provider" | "cli" | "api" | "estimated";
}
```

Never invent account usage.

States:

- available
- partial
- unavailable
- estimated

Estimated values must be clearly labeled.

## 22. Database

Use SQLite + Drizzle migrations.

At minimum:

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

## 23. Logging and graceful failure

Structured log categories:

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

Never log secrets.

The app must degrade gracefully when provider CLI, auth, MCP, plugin, agent, terminal, usage or session-resume functionality fails.

## 24. UI design language

Build a calm, minimal, high-quality desktop UI inspired by Apple-style restraint and modern professional developer tools, but do not clone Apple.

Avoid:

- excessive glassmorphism
- card grids everywhere
- neon gradients
- gaming/cyberpunk look
- emojis as icons
- noisy animations

Use:

- quiet neutral surfaces
- whitespace
- typography
- thin separators
- subtle translucency only for overlays/popovers/floating surfaces
- semantic color
- restrained 120–180 ms motion
- Lucide-style icons

### Quiet UI / progressive disclosure

The default surface shows only what matters now. More detail appears through hover, keyboard focus, click, context menus, command palette and dedicated views.

Example:

```text
Claude Sonnet   68%
```

Hover/focus can reveal:

```text
Provider: Claude
Model: ...
Auth: Connected
CLI: Installed
Weekly usage: 68% remaining
MCP: 3 connected
Context: ...
```

Hover cannot be the only access method; keyboard/focus/click alternatives are required.

The usage popover should aggregate all connected providers where real data exists.

## 25. Main UI

Primary shell:

```text
LEFT SIDEBAR | CENTER | OPTIONAL RIGHT CONTEXT
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

Chat should be document-like rather than giant bubble UI. Tool calls collapse by default:

```text
Terminal · 3 commands
Filesystem · 4 files changed
```

Command Palette:

- Ctrl+K
- Cmd+K

Commands include session/workspace/provider/model switching, terminal/files, skills, plugins, settings, Team actions and Status Island controls.

## 26. Status Island

Implement an optional small floating companion window, conceptually similar to a dynamic/floating island but not an Apple clone.

Purpose: the user should not need the main app visible to know what AI Workbench is doing.

The main window may be minimized/hidden/closed to tray while background work continues.

Use a separate Electron window. Desired behavior:

- frameless
- compact
- transparent where appropriate
- optional always-on-top
- draggable
- multi-monitor aware
- configurable position
- independent from main window visibility
- persistent preferences

Compact examples:

```text
Claude · Working
```

```text
Claude 68%   Codex 42%
```

```text
AI Workbench · 3 agents active
```

Important events may temporarily expand it:

```text
Codex needs your attention
Open   Dismiss
```

or:

```text
Project completed
11 / 11 tasks
Open project
```

### Island widgets

Create a registry of widgets:

- Provider Usage
- Active Agents
- Needs Attention
- Team Progress
- Project Activity
- Completed Work
- Errors
- Connection Health

Future plugins should be able to register widgets.

### Priority engine

Suggested default priority:

```text
100 user action required
90 permission/security action
80 agent blocked / critical error
70 provider or MCP failure affecting work
60 project/team completed
50 important task completed
40 active project/team progress
30 agent activity
20 usage
10 idle
```

This must be centralized in `StatusAttentionService`, not scattered UI conditions.

Manual behavior:

- cycle widgets
- pin Usage
- pin a project
- pin Active Agents
- return to Automatic

Settings:

- enable/disable
- start with app
- always on top
- monitor
- position
- enabled widgets
- idle widget
- auto rotate
- auto-expand important events

## 27. Honest project progress

Never invent project percentages.

For Team Mode calculate progress from the task graph, e.g.:

```text
11 tasks
7 complete
2 running
1 pending
1 blocked
=> 64% completed tasks
```

If later using weighted tasks, document weighting.

For solo sessions without structured tasks, use semantic status such as:

- Planning
- Implementing
- Testing
- Reviewing
- Waiting

not fake percentages.

## 28. System tray/background control

Tray should allow:

- Open AI Workbench
- Show/Hide Status Island
- inspect active sessions
- pause autonomous runs
- stop all active work
- quit

Background processes must never become invisible and uncontrollable.

## 29. Typed IPC and domain events

Use typed/validated IPC domains for workspace, session, provider, terminal, skills, plugins, MCP, team and status-island actions.

Use domain events to decouple subsystems, e.g.:

- SessionCreated
- ProviderConnected
- ProviderUsageUpdated
- TeamTaskCompleted
- AgentNeedsInput
- ProjectProgressChanged
- StatusAttentionCreated

Main UI and Status Island subscribe only to what they need.

## 30. Performance/accessibility

- virtualize long chats/logs
- avoid unnecessary React rerenders
- efficiently stream provider output
- support keyboard navigation
- use ARIA appropriately
- make hover details accessible by focus/click
- preserve visible focus state

## 31. Documentation

Maintain:

- `README.md`
- `ARCHITECTURE.md`
- `PROVIDERS.md`
- `TEAM_SYSTEM.md`
- `STATUS_ISLAND.md`
- `SECURITY.md`
- `DEVELOPMENT.md`
- `PROGRESS.md`

Use ADRs for major architecture decisions.

## 32. Measurable project goals

`PROGRESS.md` is mandatory. Measure progress from verified acceptance criteria, not intuition.

Weights:

| Goal | Area | Weight |
|---|---|---:|
| G0 | Foundation | 5% |
| G1 | First functional vertical slice | 15% |
| G2 | Provider platform | 15% |
| G3 | Workspace/developer tooling | 10% |
| G4 | Skills, plugins and MCP | 10% |
| G5 | Autonomous team system | 20% |
| G6 | Status Island/background runtime | 10% |
| G7 | UX, security, reliability, performance | 10% |
| G8 | Extensibility, SDK, packaging | 5% |
| **Total** | | **100%** |

### G0 — Foundation — 5%

- [ ] pnpm workspace
- [ ] Electron launches
- [ ] React/TypeScript renderer
- [ ] strict TypeScript
- [ ] Vitest
- [ ] SQLite/Drizzle
- [ ] migrations
- [ ] safe typed IPC baseline
- [ ] structured logging
- [ ] design tokens
- [ ] build/typecheck/test scripts

### G1 — First functional vertical slice — 15%

- [ ] create/persist workspace
- [ ] choose working directory
- [ ] create/persist session
- [ ] select MockProvider/model
- [ ] send message
- [ ] streaming response
- [ ] cancel
- [ ] persist conversation
- [ ] restart/resume
- [ ] mock usage
- [ ] aggregated usage hover/focus
- [ ] command palette
- [ ] settings
- [ ] final design language already visible

### G2 — Provider platform — 15%

- [ ] adapter contract
- [ ] transport abstraction
- [ ] registry
- [ ] capabilities
- [ ] MockProvider
- [ ] generic CLI transport
- [ ] discovery
- [ ] auth status
- [ ] normalized streams/errors
- [ ] cancellation/cleanup
- [ ] model listing
- [ ] resume where supported
- [ ] first real provider end-to-end
- [ ] Claude adapter where supported
- [ ] Codex adapter where supported
- [ ] Gemini adapter where supported
- [ ] custom/API config architecture

### G3 — Workspace/developer tooling — 10%

- [ ] safe filesystem
- [ ] working-directory boundaries
- [ ] integrated terminal
- [ ] file browser
- [ ] file-change/diff display
- [ ] Git status/branch
- [ ] collapsible tool calls
- [ ] multiple active sessions
- [ ] context sidebar
- [ ] keyboard workflow

### G4 — Skills/plugins/MCP — 10%

- [ ] SkillManager
- [ ] global/workspace/session scopes
- [ ] tested skill resolution
- [ ] provider-neutral skill format
- [ ] one importer
- [ ] PluginRegistry
- [ ] plugin scopes
- [ ] central accounts
- [ ] CredentialManager
- [ ] MCPManager
- [ ] local stdio MCP connection
- [ ] remote config
- [ ] session MCP selection
- [ ] ToolBridge

### G5 — Autonomous team system — 20%

- [ ] persistent TeamDefinition
- [ ] agents
- [ ] selectable Lead
- [ ] TeamRun persistence
- [ ] task graph/dependencies
- [ ] mailbox
- [ ] shared state
- [ ] decisions
- [ ] artifacts
- [ ] team events
- [ ] Team MCP
- [ ] create/delegate/complete tasks
- [ ] result reaches Lead
- [ ] parallel independent tasks
- [ ] concurrency limits
- [ ] call/task/depth/runtime limits
- [ ] ping-pong protection
- [ ] failure recovery
- [ ] finish goal
- [ ] restart recovery
- [ ] two Mock agents collaborate end-to-end
- [ ] two real providers collaborate when available
- [ ] compact Team UI

### G6 — Status Island/background runtime — 10%

- [ ] system tray
- [ ] runtime continues while main window hidden
- [ ] separate Island window
- [ ] show/hide
- [ ] persisted position
- [ ] multi-monitor behavior
- [ ] automatic mode
- [ ] manual cycling
- [ ] pinned widget
- [ ] Usage widget
- [ ] Active Agents
- [ ] Needs Attention
- [ ] Team Progress
- [ ] Completed Work
- [ ] Error widget
- [ ] tested priority engine
- [ ] high priority overrides lower priority
- [ ] click opens relevant app context
- [ ] returns to compact state
- [ ] configurable preferences
- [ ] no fake progress

### G7 — UX/security/reliability/performance — 10%

- [ ] no direct Node renderer access
- [ ] IPC validation
- [ ] secure secret storage
- [ ] no secrets in logs
- [ ] provider/MCP failure isolation
- [ ] malformed output isolation
- [ ] long-chat/log performance
- [ ] keyboard accessibility
- [ ] hover alternatives
- [ ] polished dark mode
- [ ] Quiet UI
- [ ] no excessive cards
- [ ] no emoji UI icons
- [ ] useful command palette
- [ ] background work controllable
- [ ] clean process shutdown
- [ ] critical failure tests

### G8 — Extensibility/SDK/packaging — 5%

- [ ] provider package contract docs
- [ ] plugin package contract docs
- [ ] versioned manifests
- [ ] custom provider UI
- [ ] OpenAI-compatible provider
- [ ] external provider package registration without core edit
- [ ] external plugin package registration without core edit
- [ ] production packaging
- [ ] clean install
- [ ] migration/upgrade documentation

## 33. Progress calculation

`PROGRESS.md` should calculate progress from checked acceptance items.

Example:

```md
| Goal | Weight | Completion | Weighted |
| G0 | 5 | 100% | 5.0 |
| G1 | 15 | 60% | 9.0 |
| ... | ... | ... | ... |
| TOTAL | 100 | | 14.0% |
```

If 12 of 20 criteria in a 15%-weighted goal are verified, the goal is 60% complete and contributes 9 percentage points.

Regressions may lower progress.

## 34. Implementation order

1. G0 Foundation
2. G1 first vertical slice
3. G2 provider platform
4. G3 developer tooling
5. G4 skills/plugins/MCP
6. G5 autonomous teams
7. G6 Status Island/background runtime
8. G7 hardening/UX
9. G8 SDK/packaging

StatusAttentionService may be scaffolded earlier, but do not distract from the working core.

## 35. First vertical slice

For a fresh repo, the first end-to-end path must be:

```text
Launch
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
Stream Response
  ↓
Show Mock Usage
  ↓
Hover/Focus Usage to see all installed mock provider usage
  ↓
Persist
  ↓
Restart
  ↓
Continue the same session
```

Do not begin Team Mode before this works.

## 36. Definition of done for a provider

A provider is complete only when:

- install/status detection works
- auth status works
- models work
- session creation works
- send/stream works
- cancel works
- normalized errors work
- cleanup works
- capabilities are accurate
- native resume works if supported
- unsupported features degrade safely

## 37. Definition of done for Team Mode

Team Mode is complete only when:

1. user provides a goal
2. Lead receives it
3. Lead creates work
4. task is delegated to another agent
5. worker processes it
6. worker returns result
7. Lead receives result
8. task graph updates
9. events stream to UI
10. loop limits operate
11. run persists
12. restart recovery works
13. goal can finish without manual prompt relaying

Sending the same prompt to multiple models does not count.

## 38. Definition of done for Status Island

Status Island is complete only when:

- it functions while main window is hidden
- automatic priority selection works
- manual pinning works
- Usage, Active Agents, Needs Attention, Progress, Completion and Error widgets work
- preferences persist
- important events deep-link into relevant app context
- it remains minimal when idle
- it can be disabled
- it never fabricates progress

## 39. Safety and user control

Autonomy must remain controllable.

Always support:

- cancel current response
- pause team run
- stop team run
- stop all background work
- terminate stuck process
- inspect current work
- see pending attention
- inspect logs in Developer Mode

Respect provider-native sandbox/permission systems.

Do not bypass provider security controls.

## 40. Coding discipline

Use:

- strict TypeScript
- clear interfaces
- small modules
- explicit schemas
- dependency injection where useful
- testable services

Avoid:

- God classes
- giant React components
- untyped IPC
- unjustified `any`
- provider branches in core
- massive one-file implementations

Maintain:

- `README.md`
- `ARCHITECTURE.md`
- `PROVIDERS.md`
- `TEAM_SYSTEM.md`
- `STATUS_ISLAND.md`
- `SECURITY.md`
- `DEVELOPMENT.md`
- `PROGRESS.md`

If a provider limitation makes a feature impossible:

1. document it
2. preserve the abstraction
3. implement graceful fallback
4. never fake support

## 41. Fresh-repository first task

If this repository is empty:

1. Create `PROGRESS.md`.
2. Create monorepo structure.
3. Configure pnpm.
4. Configure Electron/React/TypeScript.
5. Enable strict TypeScript.
6. Configure Vitest.
7. Configure SQLite/Drizzle/migrations.
8. Create typed preload IPC.
9. Create design tokens.
10. Create ProviderAdapter contracts.
11. Create ProviderRegistry.
12. Create MockProvider.
13. Create WorkspaceManager.
14. Create SessionManager.
15. Implement the G1 vertical slice.
16. Run typecheck/tests/build.
17. Update `PROGRESS.md`.

Before coding, briefly summarize:

- intended repository structure
- main domain interfaces
- data flow
- first implementation slice

Then implement. Do not stop at planning unless genuinely blocked.

# Final principle

**Simple by default. Powerful on demand. Provider-independent from the first line of code.**
