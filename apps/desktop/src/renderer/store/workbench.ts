import { create } from "zustand";
import type {
  AggregatedUsage,
  AppEvent,
  AppSettings,
  ChatMessage,
  ProviderSummary,
  Session,
  SessionStatus,
  Workspace,
} from "@ai-workbench/shared";
import { defaultAppSettings } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";

export type MainView = "chat" | "providers" | "settings";

interface WorkbenchState {
  ready: boolean;
  error: string | null;

  workspaces: Workspace[];
  sessions: Session[];
  providers: ProviderSummary[];
  usage: AggregatedUsage | null;
  settings: AppSettings;

  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  view: MainView;
  paletteOpen: boolean;

  messages: Record<string, ChatMessage[]>;
  status: Record<string, SessionStatus>;
  busy: Record<string, boolean>;

  initialize(): Promise<void>;
  setError(error: string | null): void;
  setView(view: MainView): void;
  setPaletteOpen(open: boolean): void;

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
  updateSettings(input: Partial<AppSettings>): Promise<void>;

  applyEvent(event: AppEvent): void;
  appendDeltas(deltas: Map<string, { sessionId: string; text: string }>): void;
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  ready: false,
  error: null,

  workspaces: [],
  sessions: [],
  providers: [],
  usage: null,
  settings: defaultAppSettings,

  activeWorkspaceId: null,
  activeSessionId: null,
  view: "chat",
  paletteOpen: false,

  messages: {},
  status: {},
  busy: {},

  async initialize() {
    try {
      const [workspaces, providers, settings, usage] = await Promise.all([
        invoke("workspace.list", undefined),
        invoke("provider.list", undefined),
        invoke("settings.get", undefined),
        invoke("provider.getUsage", undefined),
      ]);

      set({ workspaces, providers, settings, usage, ready: true });

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
