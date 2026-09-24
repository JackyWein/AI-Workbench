import { useEffect, useMemo, useState, type JSX } from "react";
import { ChevronRight } from "lucide-react";
import type {
  ChatMessage,
  EffectiveSkill,
  ProviderSummary,
  Session,
  SessionStatus,
  Workspace,
} from "@ai-workbench/shared";
import { compactNumber, formatPath, formatUsd } from "../lib/format.js";
import { describeError, invoke } from "../lib/client.js";
import { formatSpan, meterTone, snapshotOf, useNow } from "../lib/usage.js";
import { remainingStatus, soloSessionStats } from "../lib/task-stats.js";
import { useWorkbench } from "../store/workbench.js";
import { Logo } from "./Logo.js";
import { Popover } from "./Popover.js";

interface ContextPanelProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly provider: ProviderSummary | undefined;
  readonly status: SessionStatus | undefined;
  readonly messages: readonly ChatMessage[];
  /** Sends the last request again; null unless the last answer did not finish. */
  readonly onResume: (() => void) | null;
}

/**
 * The session at a glance (spec §80): what it runs on, what it has cost so
 * far and how full its context is. Where it runs and what it may use stay one
 * click away. Every number is summed from what the tool reported per turn.
 */
export function ContextPanel({
  session,
  workspace,
  provider,
  status,
  messages,
  onResume,
}: ContextPanelProps): JSX.Element {
  const cancel = useWorkbench((state) => state.cancel);
  const busy = useWorkbench((state) => state.busy[session.id] ?? false);
  const usage = useWorkbench((state) => state.usage);
  const providers = useWorkbench((state) => state.providers);
  const model = provider?.models.find((entry) => entry.id === session.modelId);
  const stats = useMemo(() => soloSessionStats(messages), [messages]);
  const context = stats.context;
  const now = useNow(30_000);
  // Remaining quota for this session's own tool, read from what the tool
  // reported — never guessed. A tool without the usage capability, or one
  // that reported nothing, reads unknown/unverified instead of a number.
  const remaining = useMemo(
    () =>
      remainingStatus({
        usage,
        providers,
        providerIds: session.providerId ? [session.providerId] : [],
        now,
      }),
    [usage, providers, session.providerId, now],
  );
  const remainingSnapshot =
    session.providerId && provider?.capabilities.supported.includes("usage")
      ? snapshotOf(usage, session.providerId)
      : null;
  const contextPercent =
    context && context.window ? Math.min(100, Math.round((context.used / context.window) * 100)) : null;
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <aside className="context" aria-label="Session context">
      <div className="context__card">
        <div className="context__model">
          <span className="logo-well" aria-hidden="true">
            <Logo name={provider?.metadata.icon} label={provider?.metadata.displayName ?? "?"} size={15} />
          </span>
          <span className="context__model-text">
            <span className="context__model-name">
              {model?.displayName ?? (provider ? "Default model" : "No provider")}
            </span>
            <span className="context__model-provider">
              {provider?.metadata.displayName ?? "Choose one with Ctrl+K"}
            </span>
          </span>
        </div>
        <div className="context__status">
          <StatusPill status={status} />
          <span className="context__resumable">
            {session.providerSessionId ? "Resumable" : "Not started"}
          </span>
        </div>
        {busy ? (
          <button type="button" className="ghost-button context__action" onClick={() => void cancel()}>
            Interrupt
          </button>
        ) : onResume ? (
          <button type="button" className="ghost-button context__action" onClick={onResume}>
            Resume
          </button>
        ) : null}
      </div>

      <div className="context__section">
        <p className="context__heading">This session</p>
        <dl className="stat-grid">
          <Stat label="Turns" value={String(stats.turns)} />
          <Stat
            label="Working time"
            value={stats.durationMs > 0 ? formatSpan(stats.durationMs) : "—"}
            title="Time the tool spent answering, as it measured it"
          />
          <Stat
            label="Tokens"
            value={stats.tokens > 0 ? compactNumber(stats.tokens) : "—"}
            title={
              stats.tokens > 0
                ? `${stats.input.toLocaleString()} in · ${stats.output.toLocaleString()} out${
                    stats.cached > 0 ? ` · ${stats.cached.toLocaleString()} from cache` : ""
                  }`
                : "Not reported"
            }
          />
          <Stat
            label="Cost"
            value={stats.costUsd !== null ? `≈${formatUsd(stats.costUsd)}` : "—"}
            title={
              stats.costUsd !== null
                ? "Computed by the tool at list prices; your bill may differ"
                : "Not reported"
            }
          />
          <Stat
            label="Remaining"
            value={
              remaining.kind === "ready"
                ? `${remaining.percentUsed}% used`
                : remaining.kind === "unknown"
                  ? "unknown"
                  : "unverified"
            }
            title={
              remaining.kind === "ready"
                ? remaining.detail
                : remaining.kind === "unverified"
                  ? (remainingSnapshot?.note ?? remaining.reason)
                  : "The tool has not reported usage yet"
            }
          />
        </dl>
        {context ? (
          <div className="context__meter-block" data-tone={contextPercent === null ? "calm" : meterTone(contextPercent)}>
            <div className="context__meter-row">
              <span>Context</span>
              <span className="context__meter-value">
                {compactNumber(context.used)}
                {context.window ? ` / ${compactNumber(context.window)}` : ""}
              </span>
            </div>
            {contextPercent !== null ? (
              <div
                className="meter"
                role="meter"
                aria-valuenow={contextPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Context used, ${contextPercent} percent`}
              >
                <span className="meter__fill" style={{ width: `${contextPercent}%` }} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <SessionSkills sessionId={session.id} />
      <SessionTools sessionId={session.id} />

      <div className="context__section context__section--foot">
        <button
          type="button"
          className="context__disclosure"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
          Where it runs
        </button>
        {detailsOpen ? (
          <dl className="context__details">
            <div>
              <dt>Workspace</dt>
              <dd>{workspace?.name ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Directory</dt>
              <dd>
                <Popover
                  title="Working directory"
                  triggerClassName="context__path"
                  trigger={<>{formatPath(session.workingDirectory, 30)}</>}
                >
                  <p className="popover__detail">{session.workingDirectory}</p>
                </Popover>
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    </aside>
  );
}

function StatusPill({ status }: { readonly status: SessionStatus | undefined }): JSX.Element {
  const current = status ?? "idle";
  const tone = current === "error" ? "danger" : current === "waiting" ? "warn" : current === "idle" ? undefined : "live";
  return (
    <span className="pill" data-tone={tone}>
      <span
        className="status-dot"
        data-state={
          current === "error" ? "error" : current === "waiting" ? "waiting" : current === "idle" ? "idle" : "running"
        }
        aria-hidden="true"
      />
      {current.charAt(0).toUpperCase() + current.slice(1)}
    </span>
  );
}

function Stat({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}): JSX.Element {
  return (
    <div className="stat" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
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
    <div className="context__section">
      <p className="context__heading">Skills</p>
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

/**
 * Which connectors this session may use (spec §38): the ones available in its
 * workspace, each of which the session can switch off (or on) for itself.
 */
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

  // A switched-off connector is off everywhere; it is not offered here.
  const offered = servers.filter((server) => server.enabled);
  if (offered.length === 0) {
    return null;
  }

  return (
    <div className="context__section">
      <p className="context__heading">Connectors</p>
      {offered.map((server) => {
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
              role="switch"
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
