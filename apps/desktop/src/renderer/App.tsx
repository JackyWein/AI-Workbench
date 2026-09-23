import { type JSX, useEffect, useState } from "react";
import type { ChatMessage, ProviderSummary } from "@ai-workbench/shared";
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
import { RendererErrorBoundary } from "./components/ErrorBoundary.js";
import { ConnectorsView } from "./components/ConnectorsView.js";
import { ProvidersView } from "./components/ProvidersView.js";
import { SessionHeader } from "./components/SessionHeader.js";
import { SettingsView } from "./components/SettingsView.js";
import {
  TeamPreviewPanel,
  TeamSessionPreview,
} from "./components/TeamSessionPreview.js";
import { TeamSessionView } from "./components/TeamSessionView.js";
import { TeamPanel } from "./components/TeamPanel.js";
import { UsageView } from "./components/UsageView.js";
import { Sidebar } from "./components/Sidebar.js";
import { SkillsView } from "./components/SkillsView.js";
import { TeamsView } from "./components/TeamsView.js";
import { WorkspacePanel } from "./components/WorkspacePanel.js";

type AppInfo = { version: string; platform: string; userDataPath: string; username: string };

/**
 * True when the last request did not get a finished answer: it failed, was
 * stopped, or never got one. Only then is there something to resume.
 */
function needsResume(messages: readonly ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) {
    return false;
  }
  if (last.role === "user") {
    return last.content.trim().length > 0;
  }
  return (
    last.role === "assistant" &&
    (last.status === "failed" || last.status === "cancelled") &&
    messages.some((entry) => entry.role === "user" && entry.content.trim().length > 0)
  );
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

  // A session can be bound to a team (its own record says so, not a guess):
  // then the session shows that team working instead of one conversation.
  const teamId = typeof session?.uiState["teamId"] === "string" ? session.uiState["teamId"] : null;
  const teamRunId =
    typeof session?.uiState["teamRunId"] === "string" ? session.uiState["teamRunId"] : null;
  const sessionTeam = teamId ? state.teams.find((entry) => entry.id === teamId) : undefined;
  const teamSnapshot = teamRunId ? state.runSnapshots[teamRunId] : undefined;

  // Boot faces belong here, never on the island: a loading screen while the
  // store fills, and the exact error with a retry when startup itself fails.
  if (!state.ready) {
    return (
      <div className="boot" role="status" aria-label="Starting AI Workbench">
        <span className="boot__mark" aria-hidden="true">
          W
        </span>
        <p className="boot__text">Starting AI Workbench…</p>
      </div>
    );
  }

  if (state.bootError) {
    return (
      <div className="boot" role="alert" aria-label="AI Workbench failed to start">
        <span className="boot__mark" aria-hidden="true">
          W
        </span>
        <p className="boot__text">Could not start AI Workbench</p>
        <p className="boot__error">{state.bootError}</p>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void state.initialize()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        workspaces={state.workspaces}
        sessions={state.sessions}
        activeWorkspaceId={state.activeWorkspaceId}
        activeSessionId={state.activeSessionId}
        view={state.view}
        appVersion={appInfo?.version ?? null}
        username={appInfo?.username ?? null}
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
          state.teamPreview && state.settings.developerMode ? (
            <TeamSessionPreview
              session={session}
              workspace={workspace}
              providers={state.providers}
              usage={state.usage}
              status={state.status[session.id]}
            />
          ) : sessionTeam ? (
            <RendererErrorBoundary fallbackTitle="Team session">
              <TeamSessionView
                session={session}
                team={sessionTeam}
                snapshot={teamSnapshot ?? null}
              />
            </RendererErrorBoundary>
          ) : (
          <>
            <SessionHeader
              session={session}
              workspace={workspace}
              providers={state.providers}
              usage={state.usage}
              status={state.status[session.id]}
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
                onSend={(text, attachments) => void state.sendMessage(text, attachments)}
                onCancel={() => void state.cancel()}
                attach={attachSupport(state.providers.find((entry) => entry.metadata.id === session.providerId))}
              />
              {state.workspacePanelOpen ? <WorkspacePanel sessionId={session.id} /> : null}
            </div>
          </>
          )
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
          <RendererErrorBoundary fallbackTitle="Providers">
            <ProvidersView providers={state.providers} configs={state.providerConfigs} />
          </RendererErrorBoundary>
        ) : null}
        {state.view === "skills" ? (
          <RendererErrorBoundary fallbackTitle="Skills">
            <SkillsView />
          </RendererErrorBoundary>
        ) : null}
        {state.view === "connectors" ? (
          <RendererErrorBoundary fallbackTitle="Connectors">
            <ConnectorsView />
          </RendererErrorBoundary>
        ) : null}
        {state.view === "teams" ? (
          <RendererErrorBoundary fallbackTitle="Teams">
            <TeamsView />
          </RendererErrorBoundary>
        ) : null}
        {state.view === "usage" ? (
          <RendererErrorBoundary fallbackTitle="Usage">
            <UsageView />
          </RendererErrorBoundary>
        ) : null}

        {state.view === "settings" ? (
          <RendererErrorBoundary fallbackTitle="Settings">
            <SettingsView settings={state.settings} appInfo={appInfo} />
          </RendererErrorBoundary>
        ) : null}
      </main>

      {state.view === "chat" && state.workspaceMode === "chat" && session ? (
        state.teamPreview && state.settings.developerMode ? (
          <TeamPreviewPanel />
        ) : sessionTeam ? (
          <TeamPanel team={sessionTeam} snapshot={teamSnapshot ?? null} />
        ) : (
        <ContextPanel
          session={session}
          workspace={workspace}
          provider={provider}
          status={state.status[session.id]}
          messages={messages}
          onResume={needsResume(messages)
            ? () => {
                const store = useWorkbench.getState();
                const list = store.messages[session.id] ?? [];
                for (let index = list.length - 1; index >= 0; index -= 1) {
                  const candidate = list[index];
                  if (candidate?.role === "user" && candidate.content.trim().length > 0) {
                    void store.sendMessage(candidate.content);
                    return;
                  }
                }
              }
            : null}
        />
        )
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

/** Whether the session's provider takes files, and why not when it does not. */
function attachSupport(
  provider: ProviderSummary | undefined,
): { supported: boolean; reason?: string } {
  if (!provider) {
    return { supported: false, reason: "Choose a provider to attach files" };
  }
  return provider.capabilities.supported.includes("attachments")
    ? { supported: true }
    : { supported: false, reason: `${provider.metadata.displayName} can't take files` };
}
