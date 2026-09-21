import type { JSX } from "react";
import type { ProviderSummary, Session, SessionStatus, Workspace } from "@ai-workbench/shared";
import { formatPath } from "../lib/format.js";

interface ContextPanelProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly provider: ProviderSummary | undefined;
  readonly status: SessionStatus | undefined;
  readonly messageCount: number;
}

/** Optional right-hand context (spec §80). Compact, read-only, no dashboard. */
export function ContextPanel({
  session,
  workspace,
  provider,
  status,
  messageCount,
}: ContextPanelProps): JSX.Element {
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
    </aside>
  );
}

function labelFor(status: SessionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
