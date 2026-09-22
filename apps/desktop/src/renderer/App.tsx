import { type JSX, useEffect, useState } from "react";
import type { ChatMessage, MessageUsage } from "@ai-workbench/shared";
import { resolveTheme } from "@ai-workbench/ui";
import { invoke } from "./lib/client.js";
import { attachEventStream } from "./lib/event-stream.js";
import { useWorkbench } from "./store/workbench.js";
import { AgentsView } from "./components/AgentsView.js";
import { ChatView } from "./components/ChatView.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Composer } from "./components/Composer.js";
import { ContextPanel } from "./components/ContextPanel.js";
import { EmptyState } from "./components/EmptyState.js";
import { McpView } from "./components/McpView.js";
import { ConnectionsView } from "./components/ConnectionsView.js";
import { PluginsView } from "./components/PluginsView.js";
import { ProvidersView } from "./components/ProvidersView.js";
import { SessionHeader } from "./components/SessionHeader.js";
import { SettingsView } from "./components/SettingsView.js";
import { Sidebar } from "./components/Sidebar.js";
import { SkillsView } from "./components/SkillsView.js";
import { TeamsView } from "./components/TeamsView.js";
import { WorkspacePanel } from "./components/WorkspacePanel.js";

type AppInfo = { version: string; platform: string; userDataPath: string };

/** Usage of the most recent answer that reported any. */
function latestUsage(messages: readonly ChatMessage[]): MessageUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage;
    if (usage) {
      return usage;
    }
  }
  return null;
}

export function App(): JSX.Element {
  const state = useWorkbench();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const detach = attachEventStream();
    void state.initialize();
    void invoke("app.getInfo", undefined).then(setAppInfo);
    // The Status Island can ask the window to go somewhere (spec §98).
    const detachNavigate = window.workbench.onNavigate((target) => {
      void useWorkbench.getState().goTo(target);
    });
    return () => {
      detach();
      detachNavigate();
    };
    // Runs once: the store and the event stream are module-level singletons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+K / Cmd+K anywhere in the app (spec §81).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useWorkbench.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        store.setPaletteOpen(!store.paletteOpen);
        return;
      }
      // Ctrl+` opens the terminal, the way a developer tool is expected to.
      if ((event.ctrlKey || event.metaKey) && event.key === "`") {
        event.preventDefault();
        store.toggleWorkspacePanel("terminal");
        return;
      }
      // Ctrl+Shift+A flips between the clean conversation and the agents'
      // terminals (also in the palette and on the view toggle's tooltip).
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        const mode = store.workspaceMode === "terminals" ? "chat" : "terminals";
        store.setWorkspaceMode(mode);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset["theme"] = resolveTheme(
        state.settings.theme,
        media.matches,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.settings.theme]);

  useEffect(() => {
    document.documentElement.dataset["density"] = state.settings.density;
  }, [state.settings.density]);

  const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
  const workspace = state.workspaces.find(
    (entry) => entry.id === state.activeWorkspaceId,
  );
  const provider = state.providers.find(
    (entry) => entry.metadata.id === session?.providerId,
  );
  const messages = session ? (state.messages[session.id] ?? []) : [];
  const busy = session ? (state.busy[session.id] ?? false) : false;

  return (
    <div className="app">
      <Sidebar
        workspaces={state.workspaces}
        sessions={state.sessions}
        activeWorkspaceId={state.activeWorkspaceId}
        activeSessionId={state.activeSessionId}
        view={state.view}
      />

      <main className="main">
        {state.view === "chat" && state.workspaceMode === "terminals" && workspace ? (
          <AgentsView workspaceId={workspace.id} workspaceName={workspace.name} />
        ) : null}

        {state.view === "chat" &&
        state.workspaceMode === "terminals" &&
        !workspace ? (
          <div className="main__body">
            <EmptyState title="No workspaces yet" />
          </div>
        ) : null}

        {state.view === "chat" && state.workspaceMode === "chat" && session ? (
          <>
            <SessionHeader
              session={session}
              workspace={workspace}
              providers={state.providers}
              usage={state.usage}
              status={state.status[session.id]}
              busy={busy}
              onCancel={() => void state.cancel()}
            />
            <div className="main__body">
              {messages.length === 0 ? (
                <EmptyState title="No messages yet" />
              ) : (
                <ChatView
                  key={`${session.id}:${messages[0]?.id ?? "start"}`}
                  messages={messages}
                />
              )}
              <Composer
                busy={busy}
                disabled={false}
                onSend={(text) => void state.sendMessage(text)}
                onCancel={() => void state.cancel()}
              />
              {state.workspacePanelOpen ? <WorkspacePanel sessionId={session.id} /> : null}
            </div>
          </>
        ) : null}

        {state.view === "chat" && state.workspaceMode === "chat" && !session ? (
          <div className="main__body">
            <EmptyState
              title={
                state.workspaces.length === 0
                  ? "No workspaces yet"
                  : "No session selected"
              }
              action={
                state.workspaces.length === 0
                  ? {
                      label: "Choose a folder",
                      onClick: () => {
                        void state.chooseDirectory().then((path) => {
                          if (path) {
                            const name =
                              path.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
                            void state.createWorkspace(name, path);
                          }
                        });
                      },
                    }
                  : {
                      label: "New session",
                      onClick: () => void state.createSession({ name: "Session 1" }),
                    }
              }
            />
          </div>
        ) : null}

        {state.view === "providers" ? (
          <ProvidersView providers={state.providers} configs={state.providerConfigs} />
        ) : null}
        {state.view === "skills" ? <SkillsView /> : null}
        {state.view === "plugins" ? <PluginsView /> : null}
        {state.view === "mcp" ? <McpView /> : null}
        {state.view === "connections" ? <ConnectionsView /> : null}
        {state.view === "teams" ? <TeamsView /> : null}
        {state.view === "settings" ? (
          <SettingsView settings={state.settings} appInfo={appInfo} />
        ) : null}
      </main>

      {state.view === "chat" && state.workspaceMode === "chat" && session ? (
        <ContextPanel
          session={session}
          workspace={workspace}
          provider={provider}
          status={state.status[session.id]}
          messageCount={messages.length}
          usage={latestUsage(messages)}
        />
      ) : (
        <div />
      )}

      <CommandPalette />

      {state.error ? (
        <div className="toast" role="status">
          <span>{state.error}</span>
          <button
            type="button"
            className="quiet-button"
            onClick={() => state.setError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
