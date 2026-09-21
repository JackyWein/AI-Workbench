import { create } from "zustand";
import type {
  AggregatedUsage,
  AppEvent,
  AppSettings,
  ChatMessage,
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
  StoredProviderConfig,
  Workspace,
} from "@ai-workbench/shared";
import { defaultAppSettings } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";

export type MainView = "chat" | "providers" | "skills" | "plugins" | "mcp" | "settings";
export type WorkspaceTab = "terminal" | "files" | "changes";

interface WorkbenchState {
  ready: boolean;
  error: string | null;

  workspaces: Workspace[];
  sessions: Session[];
  providers: ProviderSummary[];
  providerConfigs: Record<string, StoredProviderConfig>;
  usage: AggregatedUsage | null;
  settings: AppSettings;

  skills: SkillManifest[];
  /** Which skills are switched on, per scope, for the current selection. */
  skillScopes: SkillScopes;
  plugins: PluginManifest[];
  pluginScopes: PluginScopes;
  pluginAccounts: PluginAccount[];
  mcpServers: McpServerConfig[];
  mcpStatuses: McpServerStatus[];
  /** MCP servers the active session may use (spec §38). */
  sessionMcpServerIds: string[];

  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  view: MainView;
  paletteOpen: boolean;
  workspacePanelOpen: boolean;
  workspaceTab: WorkspaceTab;

  messages: Record<string, ChatMessage[]>;
  status: Record<string, SessionStatus>;
  busy: Record<string, boolean>;

  initialize(): Promise<void>;
  setError(error: string | null): void;
  setView(view: MainView): void;
  setPaletteOpen(open: boolean): void;
  setWorkspacePanelOpen(open: boolean): void;
  toggleWorkspacePanel(tab?: WorkspaceTab): void;
  setWorkspaceTab(tab: WorkspaceTab): void;

  selectWorkspace(id: string | null): Promise<void>;
  selectSession(id: string | null): Promise<void>;

  createWorkspace(name: string, path: string): Promise<Workspace | null>;
  deleteWorkspace(id: string): Promise<void>;
  chooseDirectory(): Promise<string | null>;

  createSession(input: { name: string; providerId?: string }): Promise<Session | null>;
  updateSession(input: {
    id: string;
    name?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<void>;
  deleteSession(id: string): Promise<void>;

  sendMessage(text: string): Promise<void>;
  cancel(): Promise<void>;

  refreshUsage(): Promise<void>;
  refreshProviders(): Promise<void>;

  refreshSkills(): Promise<void>;
  importSkills(): Promise<void>;
  saveSkill(skill: SkillManifest): Promise<void>;
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

  refreshMcp(): Promise<void>;
  saveMcpServer(config: McpServerConfig): Promise<void>;
  deleteMcpServer(id: string): Promise<void>;
  connectMcpServer(id: string): Promise<void>;
  disconnectMcpServer(id: string): Promise<void>;
  setSessionMcpAccess(serverId: string, enabled: boolean): Promise<void>;
  saveProviderConfig(input: SaveProviderConfigInput): Promise<void>;
  updateSettings(input: Partial<AppSettings>): Promise<void>;

  applyEvent(event: AppEvent): void;
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

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  ready: false,
  error: null,

  workspaces: [],
  sessions: [],
  providers: [],
  providerConfigs: {},
  usage: null,
  settings: defaultAppSettings,

  skills: [],
  skillScopes: {},
  plugins: [],
  pluginScopes: {},
  pluginAccounts: [],
  mcpServers: [],
  mcpStatuses: [],
  sessionMcpServerIds: [],

  activeWorkspaceId: null,
  activeSessionId: null,
  view: "chat",
  paletteOpen: false,
  workspacePanelOpen: false,
  workspaceTab: "terminal",

  messages: {},
  status: {},
  busy: {},

  async initialize() {
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
        providers,
        settings,
        usage,
        providerConfigs: byProviderId(configs),
        ready: true,
      });

      const firstWorkspace = workspaces[0];
      if (firstWorkspace) {
        await get().selectWorkspace(firstWorkspace.id);
      }
    } catch (error) {
      set({ ready: true, error: describeError(error) });
    }
  },

  setError: (error) => set({ error }),
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setWorkspacePanelOpen: (workspacePanelOpen) => set({ workspacePanelOpen }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab, workspacePanelOpen: true }),
  toggleWorkspacePanel: (tab) =>
    set((state) => ({
      workspacePanelOpen: tab && !state.workspacePanelOpen ? true : !state.workspacePanelOpen,
      ...(tab ? { workspaceTab: tab } : {}),
    })),

  async selectWorkspace(id) {
    set({ activeWorkspaceId: id, activeSessionId: null, sessions: [] });
    if (!id) {
      return;
    }
    try {
      const sessions = await invoke("session.list", { workspaceId: id });
      set({ sessions });
      const first = sessions[0];
      if (first) {
        await get().selectSession(first.id);
      }
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async selectSession(id) {
    set({ activeSessionId: id, view: "chat" });
    if (!id || get().messages[id]) {
      return;
    }
    try {
      const [messages, status] = await Promise.all([
        invoke("message.list", { sessionId: id }),
        invoke("session.getStatus", { sessionId: id }),
      ]);
      set((state) => ({
        messages: { ...state.messages, [id]: messages },
        busy: { ...state.busy, [id]: status.busy },
      }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async createWorkspace(name, path) {
    try {
      const workspace = await invoke("workspace.create", { name, path });
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
      await invoke("session.update", input);
    } catch (error) {
      set({ error: describeError(error) });
    }
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

  async sendMessage(text) {
    const sessionId = get().activeSessionId;
    if (!sessionId) {
      return;
    }
    set((state) => ({ busy: { ...state.busy, [sessionId]: true } }));
    try {
      await invoke("session.sendMessage", { sessionId, text });
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
      set({ providers });
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
    } catch (error) {
      set({ error: describeError(error) });
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

  async saveMcpServer(config) {
    try {
      await invoke("mcp.save", config);
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
        set({ error: event.error.message });
        break;
      case "provider.usage.updated":
        set({ usage: event.usage });
        break;
      case "message.delta":
      case "provider.event":
        break;
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
