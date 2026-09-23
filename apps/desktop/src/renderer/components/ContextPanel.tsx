import { useEffect, useState, type JSX } from "react";
import type {
  EffectiveSkill,
  MessageUsage,
  ProviderSummary,
  Session,
  SessionStatus,
  Workspace,
} from "@ai-workbench/shared";
import { formatPath } from "../lib/format.js";
import { describeError, invoke } from "../lib/client.js";
import { useWorkbench } from "../store/workbench.js";
import { Popover } from "./Popover.js";

interface ContextPanelProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly provider: ProviderSummary | undefined;
  readonly status: SessionStatus | undefined;
  readonly messageCount: number;
  /** Usage of the most recent answer, when the provider reported any. */
  readonly usage: MessageUsage | null;
  /** Resends the last user turn; omitted while there is nothing to resume. */
  readonly onResume: (() => void) | null;
}

/** Optional right-hand context (spec §80). Compact, read-only, no dashboard. */
export function ContextPanel({
  session,
  workspace,
  provider,
  status,
  messageCount,
  usage,
  onResume,
}: ContextPanelProps): JSX.Element {
  const context = describeContext(usage);
  const percent = contextPercent(usage);
  const cancel = useWorkbench((state) => state.cancel);
  const busy = useWorkbench((state) => state.busy[session.id] ?? false);
  const model = provider?.models.find((entry) => entry.id === session.modelId);

  return (
    <aside className="context" aria-label="Session context">
      <div className="context__group">
        <p className="context__label">Status</p>
        <p className="context__value">
          <span
            className="pill"
            data-tone={
              status === "error" ? "danger" : status === "waiting" ? "warn" : "live"
            }
          >
            {status === "waiting" || (status !== "idle" && status !== undefined) ? (
              <span
                className="status-dot"
                data-state={status === "error" ? "error" : status === "waiting" ? "waiting" : "running"}
                aria-hidden="true"
              />
            ) : null}
            {status ? labelFor(status) : "Idle"}
          </span>
        </p>
        {busy || onResume ? (
          <div className="context__actions">
            {busy ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void cancel()}
              >
                Interrupt
              </button>
            ) : null}
            {!busy && onResume ? (
              <button type="button" className="btn-ghost" onClick={onResume}>
                Resume
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="context__group">
        <p className="context__label">Workspace</p>
        <p className="context__value">{workspace?.name ?? "Unknown"}</p>
      </div>

      <div className="context__group">
        <p className="context__label">Working directory</p>
        <Popover
          title="Working directory"
          triggerClassName="context__value"
          trigger={<>{formatPath(session.workingDirectory, 34)}</>}
        >
          <p className="popover__detail">{session.workingDirectory}</p>
        </Popover>
      </div>

      <div className="context__group">
        <p className="context__label">Provider</p>
        <p className="context__value">
          {provider?.metadata.displayName ?? "None selected"}
        </p>
      </div>

      <div className="context__group">
        <p className="context__label">Model</p>
        <p className="context__value">{model?.displayName ?? "Default"}</p>
      </div>

      <div className="context__group">
        <p className="context__label">Session</p>
        <p className="context__value">
          {session.providerSessionId ? "Resumable" : "Not started yet"}
        </p>
      </div>

      <div className="context__group">
        <p className="context__label">Messages</p>
        <p className="context__value">{messageCount}</p>
      </div>

      {context ? (
        <div className="context__group">
          <p className="context__label">Context</p>
          <p className="context__value">{context}</p>
          {percent !== null ? (
            <div
              className="context__meter"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Context used, ${percent} percent`}
            >
              <i style={{ width: `${percent}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      <SessionSkills sessionId={session.id} />
      <SessionTools sessionId={session.id} />
    </aside>
  );
}

/** What this session actually composes into its instructions (spec §30). */
function SessionSkills({ sessionId }: { readonly sessionId: string }): JSX.Element | null {
  const [skills, setSkills] = useState<EffectiveSkill[]>([]);

  useEffect(() => {
    let current = true;
    void invoke("skill.effectiveForSession", { sessionId })
      .then((effective) => {
        if (current) {
          setSkills(effective);
        }
      })
      // A skill list that cannot be read must not break the panel.
      .catch(() => setSkills([]));
    return () => {
      current = false;
    };
  }, [sessionId]);

  if (skills.length === 0) {
    return null;
  }

  return (
    <div className="context__group">
      <p className="context__label">Skills</p>
      <div className="chip-row">
        {skills.map((entry) => (
          <span className="chip" key={entry.skill.id}>
            {entry.skill.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Which MCP servers this session may use (spec §38). */
function SessionTools({ sessionId }: { readonly sessionId: string }): JSX.Element | null {
  const servers = useWorkbench((state) => state.mcpServers);
  const enabledIds = useWorkbench((state) => state.sessionMcpServerIds);
  const statuses = useWorkbench((state) => state.mcpStatuses);
  const refreshMcp = useWorkbench((state) => state.refreshMcp);
  const setSessionMcpAccess = useWorkbench((state) => state.setSessionMcpAccess);
  const setError = useWorkbench((state) => state.setError);

  useEffect(() => {
    let current = true;
    void (async () => {
      if (current) {
        await refreshMcp();
      }
    })();
    return () => {
      current = false;
    };
  }, [sessionId, refreshMcp]);

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="context__group">
      <p className="context__label">MCP servers</p>
      {servers.map((server) => {
        const status = statuses.find((entry) => entry.id === server.id);
        const enabled = enabledIds.includes(server.id);
        return (
          <label className="mcp-switch" key={server.id}>
            <span
              className="status-dot"
              data-state={status && status.state !== "connected" ? "waiting" : "running"}
              aria-hidden="true"
            />
            <span className="mcp-switch__name">{server.name}</span>
            <input
              type="checkbox"
              className="mini-switch"
              checked={enabled}
              onChange={(event) => {
                void setSessionMcpAccess(server.id, event.target.checked).catch(
                  (error: unknown) => setError(describeError(error)),
                );
              }}
              aria-label={`${enabled ? "Disable" : "Enable"} ${server.name} for this session`}
            />
          </label>
        );
      })}
    </div>
  );
}

function labelFor(status: SessionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Percent width for the thin context meter; null when no window is known. */
function contextPercent(usage: MessageUsage | null): number | null {
  if (!usage || usage.contextTokens === undefined) {
    return null;
  }
  if (usage.contextWindow === undefined || usage.contextWindow <= 0) {
    return null;
  }
  return Math.round((usage.contextTokens / usage.contextWindow) * 100);
}

/** Context is shown only when a provider actually reports it (spec §56). */
function describeContext(usage: MessageUsage | null): string | null {  if (!usage || usage.contextTokens === undefined) {
    return null;
  }
  const used = formatTokens(usage.contextTokens);
  if (usage.contextWindow === undefined || usage.contextWindow <= 0) {
    return `${used} used`;
  }
  const percent = Math.round((usage.contextTokens / usage.contextWindow) * 100);
  return `${used} of ${formatTokens(usage.contextWindow)} · ${percent}%`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}
