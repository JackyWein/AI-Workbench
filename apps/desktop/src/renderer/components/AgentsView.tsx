import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Crosshair, MessageSquare, Play, Plus, Square, Terminal, Trash2 } from "lucide-react";
import type { AgentTerminal, ProviderSummary } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { ActivityTrace } from "./ActivityTrace.js";
import { Logo } from "./Logo.js";
import { XtermPane } from "./XtermPane.js";
import { providerLabel } from "../lib/provider-label.js";

interface AgentsViewProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
}

/**
 * Stable empty list for selectors below: `?? []` would hand zustand a new
 * array identity on every call and re-render the view in a loop.
 */
const EMPTY_TERMINALS: AgentTerminal[] = [];

/**
 * The workspace's agents side by side (spec §26): each tile is one provider's
 * own interactive interface in a real terminal, kept running while it is not
 * visible. What a tile shows comes from the terminal record and the provider
 * registry — never from a guess about which brand it is.
 */
export function AgentsView({ workspaceId, workspaceName }: AgentsViewProps): JSX.Element {
  const terminals = useWorkbench((state) => state.agentTerminals[workspaceId] ?? EMPTY_TERMINALS);
  const providers = useWorkbench((state) => state.providers);
  const refreshAgentTerminals = useWorkbench((state) => state.refreshAgentTerminals);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    void refreshAgentTerminals(workspaceId);
  }, [refreshAgentTerminals, workspaceId]);

  return (
    <div className="agents-view">
      <LaunchBar providers={providers} />
      {terminals.length === 0 ? (
        <div className="agents-empty">
          <p className="agents-empty__title">No agents in {workspaceName} yet</p>
          <p className="agents-empty__hint">
            Pick a tool above to open its own interface in a terminal tile.
          </p>
        </div>
      ) : (
        <div className="agents-grid">
          {terminals.map((terminal) => (
            <AgentTile
              key={terminal.id}
              terminal={terminal}
              providers={providers}
              focused={focusedId === terminal.id}
              onFocused={() => setFocusedId(terminal.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Quiet switch between the clean conversation and the agents' terminals. */
export function ModeToggle(): JSX.Element {
  const workspaceMode = useWorkbench((state) => state.workspaceMode);
  const setWorkspaceMode = useWorkbench((state) => state.setWorkspaceMode);
  return (
    <div className="mode-toggle" role="group" aria-label="Workspace view">
      <button
        type="button"
        className="quiet-button"
        aria-pressed={workspaceMode === "chat"}
        onClick={() => setWorkspaceMode("chat")}
      >
        <MessageSquare size={12} strokeWidth={1.75} aria-hidden="true" />
        Chat
      </button>
      <button
        type="button"
        className="quiet-button"
        aria-pressed={workspaceMode === "terminals"}
        onClick={() => setWorkspaceMode("terminals")}
      >
        <Terminal size={12} strokeWidth={1.75} aria-hidden="true" />
        Agents
      </button>
    </div>
  );
}

/**
 * Which tools can open here. Only entries the registry reports with an
 * interactive terminal interface — never a hard-coded brand list.
 */
function launchableProviders(providers: readonly ProviderSummary[]): ProviderSummary[] {
  return providers.filter((provider) =>
    provider.capabilities.supported.includes("interactiveTerminal"),
  );
}

/** Provider, label and start for a new agent tile. Nothing is launched unseen. */
function LaunchBar({ providers }: { readonly providers: ProviderSummary[] }): JSX.Element {
  const launchAgentTerminal = useWorkbench((state) => state.launchAgentTerminal);
  const candidates = useMemo(() => launchableProviders(providers), [providers]);
  const [providerId, setProviderId] = useState<string>("");
  const [label, setLabel] = useState("");
  const [modelId, setModelId] = useState("");
  const [launching, setLaunching] = useState(false);

  const activeProviderId = candidates.some((entry) => entry.metadata.id === providerId)
    ? providerId
    : (candidates[0]?.metadata.id ?? "");
  const activeProvider = candidates.find((entry) => entry.metadata.id === activeProviderId);
  const canSelectModel =
    (activeProvider?.capabilities.supported.includes("modelSelection") ?? false) &&
    (activeProvider?.models.length ?? 0) > 0;
  const activeModelId = canSelectModel
    ? (activeProvider?.models.some((model) => model.id === modelId) ? modelId : "")
    : "";

  const launch = async (): Promise<void> => {
    if (!activeProviderId || launching) {
      return;
    }
    setLaunching(true);
    try {
      const terminal = await launchAgentTerminal({
        purpose: "agent",
        providerId: activeProviderId,
        ...(label.trim().length > 0 ? { label: label.trim() } : {}),
        ...(activeModelId.length > 0 ? { modelId: activeModelId } : {}),
      });
      if (terminal) {
        setLabel("");
        setModelId("");
      }
    } finally {
      setLaunching(false);
    }
  };

  const launchShell = async (): Promise<void> => {
    if (launching) {
      return;
    }
    setLaunching(true);
    try {
      await launchAgentTerminal({ purpose: "shell" });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="agents-bar">
      <ModeToggle />
      {candidates.length > 0 ? (
        <>
          <label>
            <select
              className="select"
              aria-label="Tool"
              value={activeProviderId}
              disabled={launching}
              onChange={(event) => {
                setProviderId(event.target.value);
                setModelId("");
              }}
            >
              {candidates.map((entry) => (
                <option key={entry.metadata.id} value={entry.metadata.id}>
                  {providerLabel(entry)}
                </option>
              ))}
            </select>
          </label>
          {canSelectModel && activeProvider ? (
            <label>
              <select
                className="select"
                aria-label="Model"
                value={activeModelId}
                disabled={launching}
                onChange={(event) => setModelId(event.target.value)}
              >
                <option value="">Default model</option>
                {activeProvider.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <input
            className="text-input agents-bar__label"
            value={label}
            placeholder="Label, e.g. Search"
            maxLength={120}
            disabled={launching}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void launch();
              }
            }}
            aria-label="Agent label"
          />
          <button
            type="button"
            className="primary-button"
            onClick={() => void launch()}
            disabled={!activeProviderId || launching}
          >
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
            {launching ? "Starting" : "Start agent"}
          </button>
        </>
      ) : (
        <span className="agents-bar__hint">
          No installed tool reports an interactive terminal interface.
        </span>
      )}
      <span className="agents-bar__spacer" />
      <button
        type="button"
        className="quiet-button"
        onClick={() => void launchShell()}
        disabled={launching}
        title="Open a plain shell in this workspace"
      >
        <Terminal size={12} strokeWidth={1.75} aria-hidden="true" />
        Shell
      </button>
    </div>
  );
}

/** One agent: identity, honest state, its controls and its live terminal. */
function AgentTile({
  terminal,
  providers,
  focused,
  onFocused,
}: {
  readonly terminal: AgentTerminal;
  readonly providers: readonly ProviderSummary[];
  readonly focused: boolean;
  readonly onFocused: () => void;
}): JSX.Element {
  const startAgentTerminal = useWorkbench((state) => state.startAgentTerminal);
  const stopAgentTerminal = useWorkbench((state) => state.stopAgentTerminal);
  const removeAgentTerminal = useWorkbench((state) => state.removeAgentTerminal);
  const tileRef = useRef<HTMLElement>(null);

  const provider = terminal.providerId
    ? providers.find((entry) => entry.metadata.id === terminal.providerId)
    : undefined;
  const modelName =
    terminal.modelId && provider
      ? (provider.models.find((model) => model.id === terminal.modelId)?.displayName ??
        terminal.modelId)
      : (terminal.modelId ?? null);

  const focusTerminal = (): void => {
    onFocused();
    tileRef.current?.querySelector("textarea")?.focus();
  };

  const running = terminal.state === "running";

  return (
    <article
      ref={tileRef}
      className="agent-tile"
      data-focused={focused}
      data-state={terminal.state}
      role="group"
      aria-label={`${terminal.label}, ${stateLabel(terminal)}`}
    >
      <header className="agent-tile__head">
        <div className="agent-tile__identity">
          <Logo name={provider?.metadata.icon} label={terminal.label} size={16} />
          <span className="agent-tile__label">{terminal.label}</span>
          {modelName ? <span className="agent-tile__model">{modelName}</span> : null}
        </div>
        <span className="agent-tile__status">
          <span
            className="status-dot"
            data-state={dotState(terminal)}
            aria-hidden="true"
          />
          {stateLabel(terminal)}
          <ActivityTrace terminalId={terminal.terminalId} width={48} height={12} />
        </span>
        <div className="agent-tile__actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="icon-button"
            onClick={focusTerminal}
            title="Focus this terminal"
            aria-label={`Focus ${terminal.label}`}
          >
            <Crosshair size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {running ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => void stopAgentTerminal(terminal.id)}
              title="Stop this agent"
              aria-label={`Stop ${terminal.label}`}
            >
              <Square size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button"
              onClick={() => void startAgentTerminal(terminal.id)}
              title="Start this agent"
              aria-label={`Start ${terminal.label}`}
            >
              <Play size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={() => void removeAgentTerminal(terminal.id)}
            title="Remove this tile"
            aria-label={`Remove ${terminal.label}`}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>
      {terminal.state === "failed" && terminal.detail ? (
        <p className="agent-tile__detail" role="note">
          {terminal.detail}
        </p>
      ) : null}
      <div className="agent-tile__body">
        <XtermPane terminalId={terminal.terminalId} onFocus={onFocused} />
      </div>
    </article>
  );
}

/** Says what the process is doing; never a fabricated percentage. */
function stateLabel(terminal: AgentTerminal): string {
  switch (terminal.state) {
    case "running":
      return terminal.purpose === "login" ? "Signing in" : "Live";
    case "stopped":
      return "Stopped";
    case "exited":
      return terminal.exitCode === 0 ? "Done" : `Exited · code ${terminal.exitCode ?? "?"}`;
    case "failed":
      return "Failed";
  }
}

function dotState(terminal: AgentTerminal): string {
  if (terminal.state === "running") {
    return "running";
  }
  if (terminal.state === "failed" || (terminal.state === "exited" && terminal.exitCode !== 0)) {
    return "error";
  }
  if (terminal.state === "exited") {
    return "ready";
  }
  return "idle";
}
