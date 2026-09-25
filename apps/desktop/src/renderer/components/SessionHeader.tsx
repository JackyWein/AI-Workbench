import { useEffect, useState, type JSX } from "react";
import type {
  AggregatedUsage,
  GitStatus,
  ProviderSummary,
  Session,
  SessionStatus,
  Workspace,
} from "@ai-workbench/shared";
import { formatPath } from "../lib/format.js";
import { invoke } from "../lib/client.js";
import { ModeToggle } from "./AgentsView.js";
import { UsageIndicator } from "./UsageIndicator.js";
import { ModelPicker } from "./ModelPicker.js";
import { ContinueSession } from "./ContinueSession.js";

interface SessionHeaderProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly providers: ProviderSummary[];
  readonly usage: AggregatedUsage | null;
  readonly status: SessionStatus | undefined;
}

/**
 * Breadcrumb header (mock A): workspace / session on the left, branch, model
 * and usage pills on the right. Everything else lives behind the palette
 * (Ctrl+K), shortcuts, or the rows and cards themselves.
 */
export function SessionHeader({
  session,
  workspace,
  providers,
  usage,
  status,
}: SessionHeaderProps): JSX.Element {
  const [git, setGit] = useState<GitStatus | null>(null);

  useEffect(() => {
    let current = true;
    void invoke("git.status", { sessionId: session.id })
      .then((next) => {
        if (current) {
          setGit(next);
        }
      })
      // A branch pill that cannot be read is omitted, never guessed.
      .catch(() => {
        if (current) {
          setGit(null);
        }
      });
    return () => {
      current = false;
    };
  }, [session.id]);

  const branchPill =
    git && git.isRepository ? (
      <span className="pill" title={git.detached ? "Detached head" : `Branch ${git.branch}`}>
        <span className="status-dot" data-state={git.clean ? "ready" : "waiting"} aria-hidden="true" />
        {git.detached ? "detached" : git.branch} ·{" "}
        {git.clean ? "clean" : `${git.changes.length} changed`}
      </span>
    ) : null;

  const statusPill =
    status && status !== "idle" ? (
      <span
        className="pill"
        data-tone={status === "error" ? "danger" : status === "waiting" ? "warn" : "live"}
      >
        {status === "waiting" ? (
          <span className="status-dot" data-state="waiting" aria-hidden="true" />
        ) : null}
        {statusLabel(status)}
      </span>
    ) : null;

  return (
    <header className="header">
      <div className="header__main">
        <ModeToggle />
        <span className="agents-bar__divider" aria-hidden="true" />
        <span className="header__ws">
          {workspace ? workspace.name : formatPath(session.workingDirectory, 28)}
        </span>
        <span className="header__sl" aria-hidden="true">
          /
        </span>
        <h1 className="header__title">{session.name}</h1>
      </div>

      <div className="header__actions">
        {branchPill}
        {statusPill}
        <ContinueSession key={session.id} session={session} providers={providers} busy={status === "working" || status === "streaming" || status === "planning" || status === "waiting"} />
        <ModelPicker />

        <UsageIndicator
          usage={usage}
          providers={providers}
          activeProviderId={session.providerId}
        />
      </div>
    </header>
  );
}

/** Semantic status, never a fabricated percentage (spec §103). */
function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "planning":
      return "Planning";
    case "working":
      return "Working";
    case "streaming":
      return "Responding";
    case "waiting":
      return "Waiting";
    case "error":
      return "Error";
    default:
      return "";
  }
}
