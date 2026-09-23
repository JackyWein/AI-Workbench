import { create } from "zustand";
import type {
  AddProviderAccountInput,
  AgentTerminal,
  LaunchAgentTerminalInput,
  UpdateAgentTerminalInput,
  AggregatedUsage,
  AppEvent,
  DetectedProviderAccount,
  PermissionMode,
  ProviderAccount,
  AppSettings,
  ChatMessage,
  DiscoveredSkill,
  MessageAttachment,
  McpServerSaveInput,
  SkillDraftResult,
  UpdateState,
  McpServerConfig,
  McpServerStatus,
  PluginAccount,
  PluginManifest,
  PluginScopes,
  ProviderSummary,
  SaveProviderConfigInput,
  Session,
  SessionStatus,
  SkillManifest,
  SkillScopes,
  IslandPreferences,
  IslandTarget,
  IslandWidgetId,
  TeamDefinition,
  TeamRun,
  TeamRunSnapshot,
  StoredProviderConfig,
  DirectoryEntry,
  SshConnection,
  SshConnectionTest,
  Workspace,
  UpdateTeamInputData,
} from "@ai-workbench/shared";
import { defaultAppSettings, providerSummarySchema } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";

/**
 * Drops malformed provider summaries at the IPC boundary so one bad entry
 * can never crash a view. Invalid entries are logged, never rendered.
 */
function validProviders(value: unknown): ProviderSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const valid: ProviderSummary[] = [];
  for (const entry of value) {
    const parsed = providerSummarySchema.safeParse(entry);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      console.warn("[providers] dropped malformed summary", parsed.error.issues[0]?.message);
    }
  }
  return valid;
}

export type MainView =
  | "chat"
  | "providers"
  | "skills"
  | "connectors"
  | "teams"
  | "usage"
  | "settings";
export type WorkspaceTab = "terminal" | "files" | "changes";
/** The clean conversation, or the workspace's agents in their own terminals. */
export type WorkspaceMode = "chat" | "terminals";

const UI_STORAGE_KEY = "ai-workbench.ui";

interface StoredUi {
  readonly workspaceMode?: WorkspaceMode;
  readonly inspectorOpen?: boolean;
}

/** View preferences that only concern this window; never domain state. */
function readStoredUi(): StoredUi {
  try {
    const raw = window.localStorage.getItem(UI_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredUi) : {};
  } catch {
    return {};
  }
}

function writeStoredUi(patch: StoredUi): void {
  try {
    window.localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ ...readStoredUi(), ...patch }),
    );
  } catch {
    // A preference that cannot be remembered is not worth an error.
  }
}

const storedUi = typeof window === "undefined" ? {} : readStoredUi();

interface WorkbenchState {
  ready: boolean;
  error: string | null;
  /** Startup failure with the exact cause; shown as a full screen, retried. */
  bootError: string | null;

  workspaces: Workspace[];
  sessions: Session[];
  providers: ProviderSummary[];
  providerConfigs: Record<string, StoredProviderConfig>;
  /** Further accounts of tools that keep several (spec §39). */
  accounts: ProviderAccount[];
  detectedAccounts: DetectedProviderAccount[];
  usage: AggregatedUsage | null;
  settings: AppSettings;

  skills: SkillManifest[];
  /** Which skills are switched on, per scope, for the current selection. */
  skillScopes: SkillScopes;
  plugins: PluginManifest[];
  pluginScopes: PluginScopes;
  pluginAccounts: PluginAccount[];
  mcpServers: McpServerConfig[];
  /** The machines a workspace can live on (spec §25). */
  connections: SshConnection[];
  /** The last result of testing a connection, by connection id. */
  connectionTests: Record<string, SshConnectionTest>;
  /** Where the app's own updates stand; null until first read. */
  update: UpdateState | null;
  mcpStatuses: McpServerStatus[];
  /** MCP servers the active session may use (spec §38). */
  sessionMcpServerIds: string[];

  teams: TeamDefinition[];
  /** Runs per team, newest first. */
  teamRuns: Record<string, TeamRun[]>;
  /** The run whose detail is open, and its contents. */
  openRunId: string | null;
  runSnapshots: Record<string, TeamRunSnapshot>;
  /**
   * What each agent is doing right now, keyed `runId:agentId` (spec §50).
   * Progress is an event, not a snapshot field, so it is kept here instead of
   * re-reading the whole run on every heartbeat.
   */
  agentProgress: Record<string, { agentId: string; detail: string; at: number }>;

  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  view: MainView;
  paletteOpen: boolean;
  paletteQuery: string;
  /** Design preview: team inside a session (mock data, developer mode only). */
  teamPreview: boolean;
  workspacePanelOpen: boolean;
  workspaceTab: WorkspaceTab;
  workspaceMode: WorkspaceMode;
  /** The slim session inspector on the right (spec §80). */
  inspectorOpen: boolean;
  /** Terminal agents per workspace. */
  agentTerminals: Record<string, AgentTerminal[]>;

  messages: Record<string, ChatMessage[]>;
  status: Record<string, SessionStatus>;
  busy: Record<string, boolean>;

  initialize(): Promise<void>;
  setError(error: string | null): void;
  setView(view: MainView): void;
  setPaletteOpen(open: boolean, initialQuery?: string): void;
  setTeamPreview(on: boolean): void;
  setWorkspacePanelOpen(open: boolean): void;
  toggleWorkspacePanel(tab?: WorkspaceTab): void;
  setWorkspaceTab(tab: WorkspaceTab): void;
  setWorkspaceMode(mode: WorkspaceMode): void;
  /** An agent tile someone asked to see (from the island); the grid focuses it. */
  focusTileId: string | null;
  clearFocusTile(): void;
  setInspectorOpen(open: boolean): void;

  refreshAgentTerminals(workspaceId?: string): Promise<void>;
  launchAgentTerminal(
    input: Omit<LaunchAgentTerminalInput, "workspaceId">,
  ): Promise<AgentTerminal | null>;
  startAgentTerminal(id: string, size?: { cols: number; rows: number }): Promise<void>;
  stopAgentTerminal(id: string): Promise<void>;
  removeAgentTerminal(id: string): Promise<void>;
  updateAgentTerminal(input: UpdateAgentTerminalInput): Promise<void>;
  /** Opens a provider's own sign-in in the workspace's terminals. */
  startProviderLogin(providerId: string): Promise<void>;
  /** Runs a provider's own one-time setup in the active workspace's terminals. */
  startProviderSetup(providerId: string): Promise<void>;

  selectWorkspace(id: string | null): Promise<void>;
  selectSession(id: string | null): Promise<void>;

  createWorkspace(
    name: string,
    path: string,
    connectionId?: string | null,
  ): Promise<Workspace | null>;
  deleteWorkspace(id: string): Promise<void>;
  chooseDirectory(): Promise<string | null>;

  createSession(input: { name: string; providerId?: string }): Promise<Session | null>;
  updateSession(input: {
    id: string;
    name?: string;
    providerId?: string;
    /** Null clears it: the tool then runs its own default model. */
    modelId?: string | null;
    /** Replaces the whole record; the caller merges what it wants to keep. */
    uiState?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Puts this session in team mode: the chosen team and, when it has one, its
   * most recent run (the live one if there is one) become what the session
   * shows instead of a single provider conversation.
   */
  setSessionTeam(input: {
    sessionId: string;
    teamId: string;
    /** Starts a run with this goal instead of opening an existing one. */
    goal?: string;
  }): Promise<void>;
  /** Leaves team mode; the session is a normal solo conversation again. */
  clearSessionTeam(sessionId: string): Promise<void>;
  deleteSession(id: string): Promise<void>;

  sendMessage(text: string, attachments?: MessageAttachment[]): Promise<void>;
  /** Files picked in the system's dialog; empty when the person cancels. */
  chooseAttachments(): Promise<MessageAttachment[]>;
  cancel(): Promise<void>;

  refreshUsage(): Promise<void>;
  refreshProviders(): Promise<void>;
  /** Asks a tool again which models it offers. */
  rescanModels(providerId: string): Promise<void>;
  refreshAccounts(): Promise<void>;
  addAccount(input: AddProviderAccountInput): Promise<ProviderAccount | null>;
  removeAccount(id: string): Promise<void>;
  /** Effort and permission for the active session; null clears a choice. */
  setSessionRuntime(input: {
    reasoningEffort?: string | null;
    permissionMode?: PermissionMode | null;
  }): Promise<void>;

  refreshSkills(): Promise<void>;
  importSkills(): Promise<void>;
  /** Saves a skill; the reason when it is refused. */
  saveSkill(skill: SkillManifest): Promise<string | null>;
  /** Skills the person's tools keep, to import. */
  discoverSkills(): Promise<DiscoveredSkill[]>;
  /** Imports skills found by discoverSkills; returns how it went. */
  importDiscoveredSkills(paths: string[]): Promise<{ imported: number; failed: string | null }>;
  /** Imports Markdown files picked in the system's dialog. */
  importSkillFiles(): Promise<void>;
  /** Has a tool draft a skill; the draft, or why there is none. */
  draftSkill(input: {
    providerId: string;
    modelId?: string;
    request: string;
  }): Promise<{ draft: SkillDraftResult } | { error: string }>;
  deleteSkill(id: string): Promise<void>;
  setSkillEnabled(
    skillId: string,
    scope: "global" | "workspace" | "session",
    enabled: boolean,
  ): Promise<void>;

  refreshPlugins(): Promise<void>;
  setPluginEnabled(
    pluginId: string,
    scope: "global" | "session",
    enabled: boolean,
  ): Promise<void>;
  connectAccount(input: {
    accountType: string;
    label: string;
    secret: string;
  }): Promise<void>;
  disconnectAccount(id: string): Promise<void>;

  setIslandPreferences(patch: Partial<IslandPreferences>): Promise<void>;
  cycleIslandWidget(direction: 1 | -1): Promise<void>;
  /** Keeps one widget on the island; null returns to automatic (spec §100). */
  pinIslandWidget(widget: IslandWidgetId | null): Promise<void>;
  /** Opens the place an island entry is about (spec §98). */
  goTo(target: IslandTarget): Promise<void>;

  refreshTeams(): Promise<void>;
  createTeam(input: {
    name: string;
    agents: Array<{
      displayName: string;
      providerId: string;
      modelId?: string;
      role: string;
    }>;
  }): Promise<void>;
  deleteTeam(teamId: string): Promise<void>;
  setTeamLead(teamId: string, agentId: string): Promise<void>;
  /** Moves a team to a folder; outside the workspace needs the explicit flag. */
  setTeamWorkingDirectory(input: {
    teamId: string;
    workingDirectory: string | null;
    allowOutsideWorkspace?: boolean;
  }): Promise<boolean>;
  /** Starts a run in the workspace that is open (or the given one). */
  startTeamRun(teamId: string, goal: string, workspaceId?: string): Promise<void>;
  /** Name, members, lead and instructions; false (and an error) if refused. */
  updateTeam(input: UpdateTeamInputData): Promise<boolean>;
  /** A note to a running team's lead, read on its next turn. */
  sendTeamNote(runId: string, content: string): Promise<boolean>;
  openTeamRun(runId: string | null): Promise<void>;
  refreshTeamRun(runId: string): Promise<void>;
  pauseTeamRun(runId: string): Promise<void>;
  resumeTeamRun(runId: string): Promise<void>;
  cancelTeamRun(runId: string): Promise<void>;

  refreshMcp(): Promise<void>;
  /** Saves a connector; the reason comes back when it is refused. */
  saveMcpServer(config: McpServerSaveInput): Promise<string | null>;
  /** Signs in to a connector in the browser; the reason when it fails. */
  signInMcp(id: string, clientSecret?: string): Promise<string | null>;
  signOutMcp(id: string): Promise<void>;

  refreshConnections(): Promise<void>;
  /** Adds a machine; a refusal (a key that cannot work) comes back as its reason. */
  createConnection(input: {
    name: string;
    host: string;
    port: number;
    username: string;
    auth: "password" | "key" | "agent";
    secret?: string;
    passphrase?: string;
    keyFile?: string;
  }): Promise<{ connection: SshConnection } | { error: string }>;
  /** Changes how a machine is signed in to; the reason when it is refused. */
  updateConnectionSignIn(input: {
    id: string;
    auth: "password" | "key" | "agent";
    secret?: string;
    passphrase?: string;
    keyFile?: string;
  }): Promise<{ connection: SshConnection } | { error: string }>;
  /** A private key file picked in the system's dialog; its path only. */
  chooseKeyFile(): Promise<string | null>;
  deleteConnection(id: string): Promise<void>;
  testConnection(id: string): Promise<SshConnectionTest | null>;
  forgetConnectionHostKey(id: string): Promise<void>;
  /** Lists a directory on a machine, for picking a remote workspace root. */
  browseConnection(
    id: string,
    path: string,
  ): Promise<{ path: string; entries: DirectoryEntry[] } | null>;
  deleteMcpServer(id: string): Promise<void>;
  connectMcpServer(id: string): Promise<void>;
  disconnectMcpServer(id: string): Promise<void>;
  setSessionMcpAccess(serverId: string, enabled: boolean): Promise<void>;
  saveProviderConfig(input: SaveProviderConfigInput): Promise<void>;
  updateSettings(input: Partial<AppSettings>): Promise<void>;

  applyEvent(event: AppEvent): void;
  refreshUpdate(): Promise<void>;
  appendDeltas(deltas: Map<string, { sessionId: string; text: string }>): void;
}

/** The scopes an assignment lookup should include for the current selection. */
function scopeIdsOf(state: {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
}): { workspaceId?: string; sessionId?: string } {
  return {
    ...(state.activeWorkspaceId ? { workspaceId: state.activeWorkspaceId } : {}),
    ...(state.activeSessionId ? { sessionId: state.activeSessionId } : {}),
  };
}

function byProviderId(
  configs: StoredProviderConfig[],
): Record<string, StoredProviderConfig> {
  return Object.fromEntries(configs.map((config) => [config.providerId, config]));
}

/**
 * Guards async selections against fast switching: only the latest request for
 * a workspace/session may write its result. Stale answers are dropped.
 */
let workspaceRequest = 0;
let sessionRequest = 0;

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  ready: false,
  error: null,
  bootError: null,

  workspaces: [],
  sessions: [],
  providers: [],
  providerConfigs: {},
  accounts: [],
  detectedAccounts: [],
  usage: null,
  settings: defaultAppSettings,

  skills: [],
  skillScopes: {},
  plugins: [],
  pluginScopes: {},
  pluginAccounts: [],
  mcpServers: [],
  connections: [],
  connectionTests: {},
  update: null,
  mcpStatuses: [],
  sessionMcpServerIds: [],

  teams: [],
  teamRuns: {},
  openRunId: null,
  runSnapshots: {},
  agentProgress: {},

  activeWorkspaceId: null,
  activeSessionId: null,
  view: "chat",
  paletteOpen: false,
  focusTileId: null,
  clearFocusTile() {
    set({ focusTileId: null });
  },
  paletteQuery: "",
  teamPreview: false,
  workspacePanelOpen: false,
  workspaceTab: "terminal",
  workspaceMode: storedUi.workspaceMode ?? "chat",
  inspectorOpen: storedUi.inspectorOpen ?? false,
  agentTerminals: {},

  messages: {},
  status: {},
  busy: {},

  async initialize() {
    // A retry starts clean: the boot screen stays until this run settles.
    set({ bootError: null });
    try {
      const [workspaces, providers, settings, usage, configs] = await Promise.all([
        invoke("workspace.list", undefined),
        invoke("provider.list", undefined),
        invoke("settings.get", undefined),
        invoke("provider.getUsage", undefined),
        invoke("provider.getConfigs", undefined),
      ]);

      set({
        workspaces,
        providers: validProviders(providers),
        settings,
        usage,
        providerConfigs: byProviderId(configs),
        ready: true,
        error: null,
        bootError: null,
      });

      void get().refreshUpdate();
      const firstWorkspace = workspaces[0];
      if (firstWorkspace) {
        await get().selectWorkspace(firstWorkspace.id);
      }
    } catch (error) {
      const message = describeError(error);
      set({ ready: true, error: message, bootError: message });
    }
  },

  setError: (error) => set({ error }),
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen, initialQuery) =>
    set((state) => ({
      paletteOpen,
      paletteQuery: paletteOpen ? (initialQuery ?? state.paletteQuery) : state.paletteQuery,
    })),
  setTeamPreview: (teamPreview) => set({ teamPreview }),
  setWorkspacePanelOpen: (workspacePanelOpen) => set({ workspacePanelOpen }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab, workspacePanelOpen: true }),
  setWorkspaceMode: (workspaceMode) => {
    writeStoredUi({ workspaceMode });
    set({ workspaceMode, view: "chat" });
    if (workspaceMode === "terminals") {
      void get().refreshAgentTerminals();
    }
  },
  setInspectorOpen: (inspectorOpen) => {
    writeStoredUi({ inspectorOpen });
    set({ inspectorOpen });
  },

  async refreshAgentTerminals(workspaceId) {
    const id = workspaceId ?? get().activeWorkspaceId;
    if (!id) {
      return;
    }
    try {
      const list = await invoke("agentTerminal.list", { workspaceId: id });
      set((state) => ({ agentTerminals: { ...state.agentTerminals, [id]: list } }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async launchAgentTerminal(input) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      return null;
    }
    try {
      const terminal = await invoke("agentTerminal.launch", { ...input, workspaceId });
      await get().refreshAgentTerminals(workspaceId);
      if (terminal.state === "failed" && terminal.detail) {
        set({ error: terminal.detail });
      }
      return terminal;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async startAgentTerminal(id, size) {
    try {
      const terminal = await invoke("agentTerminal.start", { id, ...(size ?? {}) });
      if (terminal.state === "failed" && terminal.detail) {
        set({ error: terminal.detail });
      }
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async stopAgentTerminal(id) {
    try {
      await invoke("agentTerminal.stop", { id });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async removeAgentTerminal(id) {
    try {
      await invoke("agentTerminal.remove", { id });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async updateAgentTerminal(input) {
    try {
      await invoke("agentTerminal.update", input);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async startProviderLogin(providerId) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      set({ error: "Open a workspace first; the sign-in runs in its terminals." });
      return;
    }
    try {
      await invoke("agentTerminal.login", { workspaceId, providerId });
      writeStoredUi({ workspaceMode: "terminals" });
      set({ workspaceMode: "terminals", view: "chat" });
      await get().refreshAgentTerminals(workspaceId);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async startProviderSetup(providerId) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      set({ error: "Open a workspace first; the setup runs in its terminals." });
      return;
    }
    try {
      await invoke("agentTerminal.setup", { workspaceId, providerId });
      writeStoredUi({ workspaceMode: "terminals" });
      set({ workspaceMode: "terminals", view: "chat" });
      await get().refreshAgentTerminals(workspaceId);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },
  toggleWorkspacePanel: (tab) =>
    set((state) => {
      if (!tab) {
        return { workspacePanelOpen: !state.workspacePanelOpen };
      }
      // Switching to a different tab opens the panel instead of closing it;
      // only pressing the active tab again toggles it shut.
      if (!state.workspacePanelOpen || state.workspaceTab !== tab) {
        return { workspacePanelOpen: true, workspaceTab: tab };
      }
      return { workspacePanelOpen: false };
    }),

  async selectWorkspace(id) {
    const token = ++workspaceRequest;
    set({ activeWorkspaceId: id, activeSessionId: null, sessions: [] });
    if (!id) {
      return;
    }
    void get().refreshAgentTerminals(id);
    try {
      const sessions = await invoke("session.list", { workspaceId: id });
      if (token !== workspaceRequest || get().activeWorkspaceId !== id) {
        return;
      }
      set({ sessions });
      const first = sessions[0];
      if (first) {
        await get().selectSession(first.id);
      }
    } catch (error) {
      if (token !== workspaceRequest) {
        return;
      }
      set({ error: describeError(error) });
    }
  },

  async selectSession(id) {
    const token = ++sessionRequest;
    set({ activeSessionId: id, view: "chat" });
    if (!id || get().messages[id]) {
      return;
    }
    try {
      const [messages, status] = await Promise.all([
        invoke("message.list", { sessionId: id }),
        invoke("session.getStatus", { sessionId: id }),
      ]);
      if (token !== sessionRequest || get().activeSessionId !== id) {
        return;
      }
      set((state) => ({
        messages: { ...state.messages, [id]: messages },
        busy: { ...state.busy, [id]: status.busy },
      }));
    } catch (error) {
      if (token !== sessionRequest) {
        return;
      }
      set({ error: describeError(error) });
    }
  },

  async createWorkspace(name, path, connectionId = null) {
    try {
      const workspace = await invoke("workspace.create", { name, path, connectionId });
      await get().selectWorkspace(workspace.id);
      return workspace;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async deleteWorkspace(id) {
    try {
      await invoke("workspace.delete", { id });
      const remaining = get().workspaces.filter((workspace) => workspace.id !== id);
      await get().selectWorkspace(remaining[0]?.id ?? null);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async chooseDirectory() {
    try {
      const result = await invoke("workspace.chooseDirectory", undefined);
      return result.path;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async createSession(input) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      return null;
    }
    try {
      const session = await invoke("session.create", {
        workspaceId,
        name: input.name,
        type: "solo",
        ...(input.providerId ? { providerId: input.providerId } : {}),
      });
      await get().selectSession(session.id);
      return session;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async updateSession(input) {
    try {
      const updated = await invoke("session.update", input);
      // Adopt what the host stored, so the view shows the change immediately
      // (a team binding lives in the session's own record).
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === updated.id ? updated : session,
        ),
      }));
      return;
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setSessionTeam({ sessionId, teamId, goal }) {
    try {
      const session = get().sessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return;
      }
      let runId: string | null = null;
      const value = goal?.trim();
      if (value) {
        // A goal means a new run; otherwise the newest run of the team is
        // shown, the live one first if there is one.
        // The run works in this session's workspace, wherever the team was made.
        const started = await invoke("team.startRun", {
          teamId,
          goal: value,
          workspaceId: session.workspaceId,
        });
        runId = started.id;
      } else {
        const runs = await invoke("team.listRuns", { teamId });
        runId =
          runs.find((run) => run.status === "running" || run.status === "paused")?.id ??
          runs[0]?.id ??
          null;
      }
      const updated = await invoke("session.update", {
        id: sessionId,
        uiState: { ...session.uiState, teamId, teamRunId: runId },
      });
      set((state) => ({
        sessions: state.sessions.map((entry) => (entry.id === sessionId ? updated : entry)),
        view: "chat",
        workspaceMode: "chat",
      }));
      if (runId) {
        await get().refreshTeamRun(runId);
      }
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async clearSessionTeam(sessionId) {
    const session = get().sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }
    const { teamId: _teamId, teamRunId: _runId, ...rest } = session.uiState as Record<
      string,
      unknown
    >;
    await get().updateSession({ id: sessionId, uiState: rest });
  },

  async deleteSession(id) {
    try {
      await invoke("session.delete", { id });
      const remaining = get().sessions.filter((session) => session.id !== id);
      await get().selectSession(remaining[0]?.id ?? null);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async chooseAttachments() {
    try {
      return await invoke("session.chooseAttachments", undefined);
    } catch (error) {
      set({ error: describeError(error) });
      return [];
    }
  },

  async sendMessage(text, attachments = []) {
    const value = text.trim();
    if (!value) {
      return;
    }
    const sessionId = get().activeSessionId;
    if (!sessionId) {
      return;
    }
    set((state) => ({ busy: { ...state.busy, [sessionId]: true } }));
    try {
      await invoke("session.sendMessage", {
        sessionId,
        text: value,
        ...(attachments.length > 0
          ? { attachments: attachments.map(({ path, name, kind }) => ({ path, name, kind })) }
          : {}),
      });
    } catch (error) {
      set((state) => ({
        error: describeError(error),
        busy: { ...state.busy, [sessionId]: false },
      }));
    }
  },

  async cancel() {
    const sessionId = get().activeSessionId;
    if (!sessionId) {
      return;
    }
    try {
      await invoke("session.cancel", { sessionId });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refreshUsage() {
    try {
      const usage = await invoke("provider.refreshUsage", undefined);
      set({ usage });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refreshProviders() {
    try {
      const providers = await invoke("provider.refresh", undefined);
      set({ providers: validProviders(providers) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async rescanModels(providerId) {
    try {
      const summary = await invoke("provider.rescanModels", { providerId });
      const parsed = providerSummarySchema.safeParse(summary);
      if (!parsed.success) {
        set({ error: "The tool reported models in an unreadable form." });
        return;
      }
      set((state) => ({
        providers: state.providers.map((provider) =>
          provider.metadata.id === parsed.data.metadata.id ? parsed.data : provider,
        ),
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refreshAccounts() {
    try {
      const [accounts, detectedAccounts] = await Promise.all([
        invoke("account.list", undefined),
        invoke("account.detect", undefined),
      ]);
      set({ accounts, detectedAccounts });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async addAccount(input) {
    try {
      const account = await invoke("account.add", input);
      await get().refreshAccounts();
      return account;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async removeAccount(id) {
    try {
      await invoke("account.remove", { id });
      await get().refreshAccounts();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setSessionRuntime(input) {
    const session = get().sessions.find((entry) => entry.id === get().activeSessionId);
    if (!session) {
      return;
    }
    const settings: Record<string, unknown> = { ...session.settings };
    for (const key of ["reasoningEffort", "permissionMode"] as const) {
      const value = input[key];
      if (value === null) {
        delete settings[key];
      } else if (value !== undefined) {
        settings[key] = value;
      }
    }
    try {
      await invoke("session.update", { id: session.id, settings });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async saveProviderConfig(input) {
    try {
      const { config, summary } = await invoke("provider.saveConfig", input);
      set((state) => ({
        providerConfigs: { ...state.providerConfigs, [config.providerId]: config },
        providers: state.providers.map((provider) =>
          provider.metadata.id === summary.metadata.id ? summary : provider,
        ),
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  /**
   * Skills, plugins and MCP servers are loaded when their screen is opened
   * rather than at startup: nothing in the chat depends on them, and the app
   * should not pay for a screen nobody looked at.
   */
  async refreshSkills() {
    try {
      const [skills, skillScopes] = await Promise.all([
        invoke("skill.list", undefined),
        invoke("skill.assignments", scopeIdsOf(get())),
      ]);
      set({ skills, skillScopes });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async importSkills() {
    try {
      const result = await invoke("skill.importFromDirectory", undefined);
      if (result.cancelled) {
        return;
      }
      await get().refreshSkills();
      if (result.failed.length > 0) {
        // Whatever could be imported was; the rest is named, not swallowed.
        const first = result.failed[0];
        set({
          error: `Imported ${result.imported.length}, ${result.failed.length} failed — ${first?.path}: ${first?.reason}`,
        });
      }
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async saveSkill(skill) {
    try {
      await invoke("skill.save", skill);
      await get().refreshSkills();
      return null;
    } catch (error) {
      return describeError(error);
    }
  },

  async discoverSkills() {
    try {
      const workspaceId = get().activeWorkspaceId;
      return await invoke("skill.discover", workspaceId ? { workspaceId } : {});
    } catch (error) {
      set({ error: describeError(error) });
      return [];
    }
  },

  async importDiscoveredSkills(paths) {
    try {
      const workspaceId = get().activeWorkspaceId;
      const result = await invoke("skill.importDiscovered", {
        paths,
        ...(workspaceId ? { workspaceId } : {}),
      });
      await get().refreshSkills();
      const first = result.failed[0];
      return {
        imported: result.imported.length,
        failed: first ? `${result.failed.length} could not be imported — ${first.reason}` : null,
      };
    } catch (error) {
      return { imported: 0, failed: describeError(error) };
    }
  },

  async importSkillFiles() {
    try {
      const result = await invoke("skill.importFiles", undefined);
      if (result.cancelled) {
        return;
      }
      await get().refreshSkills();
      const first = result.failed[0];
      if (first) {
        set({ error: `Imported ${result.imported.length}, ${result.failed.length} failed — ${first.reason}` });
      }
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async draftSkill(input) {
    try {
      return { draft: await invoke("skill.draft", input) };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async deleteSkill(id) {
    try {
      await invoke("skill.delete", { id });
      await get().refreshSkills();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setSkillEnabled(skillId, scope, enabled) {
    const state = get();
    const scopeId =
      scope === "workspace"
        ? state.activeWorkspaceId
        : scope === "session"
          ? state.activeSessionId
          : null;
    if (scope !== "global" && !scopeId) {
      return;
    }
    try {
      await invoke("skill.assign", {
        skillId,
        scope,
        enabled,
        ...(scopeId ? { scopeId } : {}),
      });
      set({ skillScopes: await invoke("skill.assignments", scopeIdsOf(get())) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refreshPlugins() {
    try {
      const [plugins, pluginScopes, pluginAccounts] = await Promise.all([
        invoke("plugin.list", undefined),
        invoke("plugin.assignments", scopeIdsOf(get())),
        invoke("plugin.accounts", undefined),
      ]);
      set({ plugins, pluginScopes, pluginAccounts });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setPluginEnabled(pluginId, scope, enabled) {
    const sessionId = get().activeSessionId;
    if (scope === "session" && !sessionId) {
      return;
    }
    try {
      await invoke("plugin.assign", {
        pluginId,
        scope,
        enabled,
        ...(scope === "session" && sessionId ? { scopeId: sessionId } : {}),
      });
      set({ pluginScopes: await invoke("plugin.assignments", scopeIdsOf(get())) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async connectAccount(input) {
    try {
      await invoke("plugin.connectAccount", input);
      set({ pluginAccounts: await invoke("plugin.accounts", undefined) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async disconnectAccount(id) {
    try {
      await invoke("plugin.disconnectAccount", { id });
      set({ pluginAccounts: await invoke("plugin.accounts", undefined) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setIslandPreferences(patch) {
    try {
      const state = await invoke("statusIsland.setPreferences", patch);
      set((current) => ({
        settings: { ...current.settings, statusIsland: state.preferences },
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async cycleIslandWidget(direction) {
    try {
      const state = await invoke("statusIsland.cycle", { direction });
      set((current) => ({
        settings: { ...current.settings, statusIsland: state.preferences },
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async pinIslandWidget(widget) {
    try {
      const state = await invoke("statusIsland.pinWidget", { widget });
      set((current) => ({
        settings: { ...current.settings, statusIsland: state.preferences },
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async goTo(target) {
    // An agent's tile: its workspace, the agents grid, that tile in focus.
    if (target.tileId && target.workspaceId) {
      if (get().activeWorkspaceId !== target.workspaceId) {
        await get().selectWorkspace(target.workspaceId);
      }
      set({ view: "chat", workspaceMode: "terminals", focusTileId: target.tileId });
      return;
    }
    if (target.sessionId) {
      await get().selectSession(target.sessionId);
      set({ workspaceMode: "chat" });
      return;
    }
    if (target.runId) {
      // A run that works in a session is shown there, not on the Teams screen.
      const sessions = await invoke("session.list", {}).catch(() => []);
      const host = sessions.find((session) => session.uiState["teamRunId"] === target.runId);
      if (host) {
        if (get().activeWorkspaceId !== host.workspaceId) {
          await get().selectWorkspace(host.workspaceId);
        }
        await get().selectSession(host.id);
        set({ workspaceMode: "chat" });
        return;
      }
      set({ view: "teams" });
      await get().refreshTeams();
      await get().openTeamRun(target.runId);
      return;
    }
    // The island names the MCP screen by its old name; it is Connectors now.
    set({ view: target.view === "mcp" ? "connectors" : target.view });
  },

  async refreshTeams() {
    try {
      // Teams live globally: once created they stay available everywhere and
      // new goals can start on them from any workspace.
      const teams = await invoke("team.list", {});
      const runs = await Promise.all(
        teams.map(async (team) => [team.id, await invoke("team.listRuns", { teamId: team.id })] as const),
      );
      set({ teams, teamRuns: Object.fromEntries(runs) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async createTeam(input) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      set({ error: "Select a workspace first — it becomes the new team's home." });
      return;
    }
    try {
      await invoke("team.create", {
        workspaceId,
        name: input.name,
        agents: input.agents.map((agent) => ({
          displayName: agent.displayName,
          providerId: agent.providerId,
          ...(agent.modelId === undefined || agent.modelId === "" ? {} : { modelId: agent.modelId }),
          role: agent.role,
          skills: [],
          plugins: [],
          mcpServers: [],
          settings: {},
        })),
      });
      await get().refreshTeams();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async deleteTeam(teamId) {
    try {
      await invoke("team.delete", { teamId });
      await get().refreshTeams();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setTeamLead(teamId, agentId) {
    try {
      await invoke("team.setLead", { teamId, agentId });
      await get().refreshTeams();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  /**
   * Points a team at a folder, or back at its workspace with null. A folder
   * outside the workspace is refused by the host unless the person allowed it
   * here — this is the switch that makes it a decision, not a side effect.
   */
  async sendTeamNote(runId, content) {
    try {
      await invoke("team.sendMessage", { runId, content });
      await get().refreshTeamRun(runId);
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async updateTeam(input) {
    try {
      const team = await invoke("team.update", input);
      set((state) => ({
        teams: state.teams.map((entry) => (entry.id === team.id ? team : entry)),
      }));
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async setTeamWorkingDirectory(input: {
    teamId: string;
    workingDirectory: string | null;
    allowOutsideWorkspace?: boolean;
  }): Promise<boolean> {
    try {
      const team = await invoke("team.setWorkingDirectory", input);
      set((state) => ({
        teams: state.teams.map((entry) => (entry.id === team.id ? team : entry)),
      }));
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async startTeamRun(teamId, goal, workspaceId) {
    try {
      const where = workspaceId ?? get().activeWorkspaceId ?? undefined;
      const run = await invoke("team.startRun", {
        teamId,
        goal,
        ...(where ? { workspaceId: where } : {}),
      });
      await get().refreshTeams();
      await get().openTeamRun(run.id);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async openTeamRun(runId) {
    set({ openRunId: runId });
    if (runId) {
      await get().refreshTeamRun(runId);
    }
  },

  async refreshTeamRun(runId) {
    try {
      const snapshot = await invoke("team.getRun", { runId });
      set((state) => ({
        runSnapshots: { ...state.runSnapshots, [runId]: snapshot },
        teamRuns: {
          ...state.teamRuns,
          [snapshot.run.teamId]: (state.teamRuns[snapshot.run.teamId] ?? []).map((run) =>
            run.id === runId ? snapshot.run : run,
          ),
        },
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async pauseTeamRun(runId) {
    try {
      await invoke("team.pauseRun", { runId });
      await get().refreshTeamRun(runId);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async resumeTeamRun(runId) {
    try {
      await invoke("team.resumeRun", { runId });
      await get().refreshTeamRun(runId);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async cancelTeamRun(runId) {
    try {
      await invoke("team.cancelRun", { runId });
      await get().refreshTeamRun(runId);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refreshMcp() {
    try {
      const sessionId = get().activeSessionId;
      const [mcpServers, mcpStatuses] = await Promise.all([
        invoke("mcp.list", undefined),
        invoke("mcp.statuses", undefined),
      ]);
      const access = sessionId
        ? await invoke("mcp.sessionAccess", { sessionId })
        : { serverIds: [] };
      set({ mcpServers, mcpStatuses, sessionMcpServerIds: access.serverIds });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refreshConnections() {
    try {
      set({ connections: await invoke("connection.list", undefined) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async createConnection(input) {
    try {
      const connection = await invoke("connection.create", input);
      await get().refreshConnections();
      return { connection };
    } catch (error) {
      // Shown in the form it came from, where it can be fixed.
      return { error: describeError(error) };
    }
  },

  async updateConnectionSignIn(input) {
    try {
      const connection = await invoke("connection.update", input);
      await get().refreshConnections();
      return { connection };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async chooseKeyFile() {
    try {
      return (await invoke("connection.chooseKeyFile", undefined)).path;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async deleteConnection(id) {
    try {
      await invoke("connection.delete", { id });
      await get().refreshConnections();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async testConnection(id) {
    try {
      const result = await invoke("connection.test", { id });
      // A failed test is a result to show, not an error to swallow: the
      // reason is the only thing that lets the user fix it.
      set({ connectionTests: { ...get().connectionTests, [id]: result } });
      await get().refreshConnections();
      return result;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async forgetConnectionHostKey(id) {
    try {
      await invoke("connection.update", { id, forgetHostKey: true });
      await get().refreshConnections();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async browseConnection(id, path) {
    try {
      return await invoke("connection.browse", { id, path });
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async saveMcpServer(config) {
    try {
      await invoke("mcp.save", config);
      await get().refreshMcp();
      return null;
    } catch (error) {
      await get().refreshMcp();
      return describeError(error);
    }
  },

  async signInMcp(id, clientSecret) {
    try {
      await invoke("mcp.signIn", { id, ...(clientSecret ? { clientSecret } : {}) });
      await get().refreshMcp();
      return null;
    } catch (error) {
      await get().refreshMcp();
      return describeError(error);
    }
  },

  async signOutMcp(id) {
    try {
      await invoke("mcp.signOut", { id });
      await get().refreshMcp();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async deleteMcpServer(id) {
    try {
      await invoke("mcp.delete", { id });
      await get().refreshMcp();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async connectMcpServer(id) {
    try {
      await invoke("mcp.connect", { id });
      await get().refreshMcp();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async disconnectMcpServer(id) {
    try {
      await invoke("mcp.disconnect", { id });
      await get().refreshMcp();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setSessionMcpAccess(serverId, enabled) {
    const sessionId = get().activeSessionId;
    if (!sessionId) {
      return;
    }
    try {
      await invoke("mcp.setSessionAccess", { sessionId, serverId, enabled });
      const access = await invoke("mcp.sessionAccess", { sessionId });
      set({ sessionMcpServerIds: access.serverIds });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async updateSettings(input) {
    try {
      const settings = await invoke("settings.update", input);
      set({ settings });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  applyEvent(event) {
    switch (event.type) {
      case "workspace.created":
        set((state) => ({ workspaces: [...state.workspaces, event.workspace] }));
        break;
      case "workspace.updated":
        set((state) => ({
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === event.workspace.id ? event.workspace : workspace,
          ),
        }));
        break;
      case "workspace.deleted":
        set((state) => ({
          workspaces: state.workspaces.filter(
            (workspace) => workspace.id !== event.workspaceId,
          ),
        }));
        break;
      case "session.created":
        set((state) =>
          state.sessions.some((session) => session.id === event.session.id)
            ? state
            : { sessions: [event.session, ...state.sessions] },
        );
        break;
      case "session.updated":
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === event.session.id ? event.session : session,
          ),
        }));
        break;
      case "session.deleted":
        set((state) => ({
          sessions: state.sessions.filter((session) => session.id !== event.sessionId),
        }));
        break;
      case "session.status.changed":
        set((state) => ({
          status: { ...state.status, [event.sessionId]: event.status },
          busy: {
            ...state.busy,
            [event.sessionId]: event.status !== "idle" && event.status !== "error",
          },
        }));
        break;
      case "message.created":
        set((state) => {
          const existing = state.messages[event.message.sessionId] ?? [];
          if (existing.some((message) => message.id === event.message.id)) {
            return state;
          }
          return {
            messages: {
              ...state.messages,
              [event.message.sessionId]: [...existing, event.message],
            },
          };
        });
        break;
      case "message.updated":
        set((state) => {
          const existing = state.messages[event.message.sessionId] ?? [];
          return {
            messages: {
              ...state.messages,
              [event.message.sessionId]: existing.map((message) =>
                message.id === event.message.id ? event.message : message,
              ),
            },
          };
        });
        break;
      case "message.failed":
        set((state) => ({
          error: event.error.message,
          busy: { ...state.busy, [event.sessionId]: false },
        }));
        break;
      case "provider.usage.updated":
        set({ usage: event.usage });
        break;
      case "provider.updated":
        set((state) => ({
          providers: state.providers.some(
            (provider) => provider.metadata.id === event.summary.metadata.id,
          )
            ? state.providers.map((provider) =>
                provider.metadata.id === event.summary.metadata.id ? event.summary : provider,
              )
            : [...state.providers, event.summary],
        }));
        break;
      case "provider.list.changed":
        void get().refreshProviders();
        break;
      case "agentTerminal.changed":
        set((state) => {
          const list = state.agentTerminals[event.terminal.workspaceId] ?? [];
          const exists = list.some((entry) => entry.id === event.terminal.id);
          return {
            agentTerminals: {
              ...state.agentTerminals,
              [event.terminal.workspaceId]: exists
                ? list.map((entry) => (entry.id === event.terminal.id ? event.terminal : entry))
                : [...list, event.terminal],
            },
          };
        });
        break;
      case "agentTerminal.removed":
        set((state) => ({
          agentTerminals: {
            ...state.agentTerminals,
            [event.workspaceId]: (state.agentTerminals[event.workspaceId] ?? []).filter(
              (entry) => entry.id !== event.id,
            ),
          },
        }));
        break;
      case "team.event": {
        // The run's own state is the source of truth, so a team event refreshes
        // it rather than being replayed into a second copy here (spec §50).
        const { runId } = event.event;
        if (event.event.type === "AGENT_PROGRESS") {
          // A heartbeat arrives every few seconds per agent: keep it as
          // display state and do NOT re-read the whole run snapshot for it.
          const { agentId, detail } = event.event;
          set((state) => ({
            agentProgress: {
              ...state.agentProgress,
              [`${runId}:${agentId}`]: { agentId, detail, at: Date.now() },
            },
          }));
          break;
        }
        if (get().openRunId === runId) {
          void get().refreshTeamRun(runId);
        }
        if (event.event.type === "TEAM_FINISHED" || event.event.type === "TEAM_STARTED") {
          void get().refreshTeams();
        }
        break;
      }
      case "update.progress":
        set((state) => ({
          update: state.update
            ? { ...state.update, status: "downloading", progress: event.percent }
            : state.update,
        }));
        break;
      case "update.checking":
      case "update.available":
      case "update.downloaded":
      case "update.not-available":
      case "update.error":
        void get().refreshUpdate();
        break;
      case "message.delta":
      case "provider.event":
        break;
    }
  },

  async refreshUpdate() {
    try {
      set({ update: await invoke("update.getStatus", undefined) });
    } catch {
      // The update state is a convenience; the app works without it.
    }
  },

  /** Deltas are applied in batches so a fast stream cannot thrash React. */
  appendDeltas(deltas) {
    if (deltas.size === 0) {
      return;
    }
    set((state) => {
      const messages = { ...state.messages };
      for (const [messageId, delta] of deltas) {
        const list = messages[delta.sessionId];
        if (!list) {
          continue;
        }
        messages[delta.sessionId] = list.map((message) =>
          message.id === messageId
            ? { ...message, content: message.content + delta.text }
            : message,
        );
      }
      return { messages };
    });
  },
}));
