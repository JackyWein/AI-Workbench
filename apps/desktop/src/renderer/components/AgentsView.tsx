import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ChevronDown, Crosshair, MessageSquare, Play, Square, Terminal, Trash2 } from "lucide-react";
import type { AgentTerminal, ProviderSummary } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { ActivityTrace } from "./ActivityTrace.js";
import { Logo } from "./Logo.js";
import { TerminalMetricsStrip } from "./TerminalMetrics.js";
import { XtermPane } from "./XtermPane.js";
import { isPickableProvider, providerLabel } from "../lib/provider-label.js";
import { useNow } from "../lib/usage.js";

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
  const live = terminals.filter((terminal) => terminal.state === "running").length;

  useEffect(() => {
    void refreshAgentTerminals(workspaceId);
  }, [refreshAgentTerminals, workspaceId]);

  return (
    <div className="agents-view">
      <LaunchBar providers={providers} live={live} />
      {terminals.length === 0 ? (
        <div className="agents-empty">
          <p className="agents-empty__title">No agents in {workspaceName} yet</p>
          <p className="agents-empty__hint">
            Start a tool above. It runs in its own terminal, keeps working while
            you look elsewhere, and reports its time, tokens and limits here.
          </p>
        </div>
      ) : (
        <div className="agents-grid" data-count={Math.min(terminals.length, 4)}>
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
        title="Clean conversation (Ctrl+Shift+A)"
      >
        <MessageSquare size={12} strokeWidth={1.75} aria-hidden="true" />
        Chat
      </button>
      <button
        type="button"
        className="quiet-button"
        aria-pressed={workspaceMode === "terminals"}
        onClick={() => setWorkspaceMode("terminals")}
        title="Agents in terminals (Ctrl+Shift+A)"
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
  return providers.filter(
    (provider) =>
      isPickableProvider(provider) &&
      provider.capabilities.supported.includes("interactiveTerminal"),
  );
}

/**
 * One chip per tool that can run here: a click starts it with its default
 * model, the chevron picks another first. Nothing is launched unseen.
 */
function LaunchBar({
  providers,
  live,
}: {
  readonly providers: ProviderSummary[];
  readonly live: number;
}): JSX.Element {
  const launchAgentTerminal = useWorkbench((state) => state.launchAgentTerminal);
  const candidates = useMemo(() => launchableProviders(providers), [providers]);
  const [launching, setLaunching] = useState<string | null>(null);

  const launch = async (providerId: string | null, modelId?: string): Promise<void> => {
    if (launching) {
      return;
    }
    setLaunching(providerId ?? "shell");
    try {
      await launchAgentTerminal(
        providerId
          ? { purpose: "agent", providerId, ...(modelId ? { modelId } : {}) }
          : { purpose: "shell" },
      );
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div className="agents-bar">
      <ModeToggle />
      <span className="agents-bar__divider" aria-hidden="true" />
      {candidates.length > 0 ? (
        <div className="launch-chips" role="group" aria-label="Start an agent">
          {candidates.map((entry) => (
            <LaunchChip
              key={entry.metadata.id}
              provider={entry}
              busy={launching === entry.metadata.id}
              disabled={launching !== null}
              onLaunch={(modelId) => void launch(entry.metadata.id, modelId)}
            />
          ))}
        </div>
      ) : (
        <span className="agents-bar__hint">No installed tool offers a terminal interface.</span>
      )}
      <span className="agents-bar__spacer" />
      {live > 0 ? (
        <span className="pill pill--live" aria-label={`${live} running`}>
          <span className="status-dot" data-state="running" aria-hidden="true" />
          {live} live
        </span>
      ) : null}
      <button
        type="button"
        className="quiet-button"
        onClick={() => void launch(null)}
        disabled={launching !== null}
        title="Open a plain shell in this workspace"
      >
        <Terminal size={12} strokeWidth={1.75} aria-hidden="true" />
        Shell
      </button>
    </div>
  );
}

function LaunchChip({
  provider,
  busy,
  disabled,
  onLaunch,
}: {
  readonly provider: ProviderSummary;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onLaunch: (modelId?: string) => void;
}): JSX.Element {
  const models = provider.capabilities.supported.includes("modelSelection") ? provider.models : [];
  const name = providerLabel(provider);
  return (
    <span className="launch-chip" data-busy={busy}>
      <button
        type="button"
        className="launch-chip__main"
        onClick={() => onLaunch()}
        disabled={disabled}
        title={`Start ${name}`}
      >
        <Logo name={provider.metadata.icon} label={name} size={14} />
        <span>{busy ? "Starting…" : name}</span>
      </button>
      {models.length > 1 ? (
        <span className="launch-chip__more">
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
          <select
            aria-label={`Start ${name} with a model`}
            value=""
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) {
                onLaunch(event.target.value);
              }
            }}
          >
            <option value="" disabled>
              Start with…
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </span>
      ) : null}
    </span>
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
  const now = useNow(1000);

  const provider = terminal.providerId
    ? providers.find((entry) => entry.metadata.id === terminal.providerId)
    : undefined;
  // What the tool says it runs beats what it was asked to run.
  const modelName =
    terminal.metrics?.model ??
    (terminal.modelId && provider
      ? (provider.models.find((model) => model.id === terminal.modelId)?.displayName ??
        terminal.modelId)
      : (terminal.modelId ?? null));

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
        {running ? (
          <ActivityTrace terminalId={terminal.terminalId} width={40} height={10} />
        ) : null}
        <span className="agent-tile__status" data-state={dotState(terminal)}>
          <span
            className="status-dot"
            data-state={dotState(terminal)}
            aria-hidden="true"
          />
          {stateLabel(terminal)}
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
      {terminal.purpose === "agent" ? (
        <footer className="agent-tile__foot">
          <TerminalMetricsStrip terminal={terminal} now={now} />
        </footer>
      ) : null}
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
