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

interface ContextPanelProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly provider: ProviderSummary | undefined;
  readonly status: SessionStatus | undefined;
  readonly messageCount: number;
  /** Usage of the most recent answer, when the provider reported any. */
  readonly usage: MessageUsage | null;
}

/** Optional right-hand context (spec §80). Compact, read-only, no dashboard. */
export function ContextPanel({
  session,
  workspace,
  provider,
  status,
  messageCount,
  usage,
}: ContextPanelProps): JSX.Element {
  const context = describeContext(usage);

  return (
    <aside className="context" aria-label="Session context">
      <div className="context__group">
        <p className="context__label">Status</p>
        <p className="context__value">{status ? labelFor(status) : "Idle"}</p>
      </div>

      <div className="context__group">
        <p className="context__label">Workspace</p>
        <p className="context__value">{workspace?.name ?? "Unknown"}</p>
      </div>

      <div className="context__group">
        <p className="context__label">Working directory</p>
        <p className="context__value" title={session.workingDirectory}>
          {formatPath(session.workingDirectory, 34)}
        </p>
      </div>

      <div className="context__group">
        <p className="context__label">Provider</p>
        <p className="context__value">
          {provider?.metadata.displayName ?? "None selected"}
        </p>
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
      {skills.map((entry) => (
        <p className="context__value" key={entry.skill.id}>
          {entry.skill.name}
        </p>
      ))}
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
    void refreshMcp();
  }, [sessionId, refreshMcp]);

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="context__group">
      <p className="context__label">MCP servers</p>
      {servers.map((server) => {
        const status = statuses.find((entry) => entry.id === server.id);
        return (
          <label className="scope-toggle" key={server.id}>
            <input
              type="checkbox"
              checked={enabledIds.includes(server.id)}
              onChange={(event) => {
                void setSessionMcpAccess(server.id, event.target.checked).catch(
                  (error: unknown) => setError(describeError(error)),
                );
              }}
            />
            <span>{server.name}</span>
            {status && status.state !== "connected" ? (
              <span className="row__meta">{status.state}</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

function labelFor(status: SessionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Context is shown only when a provider actually reports it (spec §56). */
function describeContext(usage: MessageUsage | null): string | null {
  if (!usage || usage.contextTokens === undefined) {
    return null;
  }
  const used = formatTokens(usage.contextTokens);
  if (usage.contextWindow === undefined) {
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
