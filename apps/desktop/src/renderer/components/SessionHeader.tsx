import type { JSX } from "react";
import { Square } from "lucide-react";
import type {
  AggregatedUsage,
  ProviderSummary,
  Session,
  SessionStatus,
  Workspace,
} from "@ai-workbench/shared";
import { formatPath } from "../lib/format.js";
import { UsageIndicator } from "./UsageIndicator.js";
import { ModelPicker } from "./ModelPicker.js";

interface SessionHeaderProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly providers: ProviderSummary[];
  readonly usage: AggregatedUsage | null;
  readonly status: SessionStatus | undefined;
  readonly busy: boolean;
  readonly onCancel: () => void;
}

/**
 * Compact session header (spec §78): name, workspace, provider/model and usage.
 * Everything else lives behind the popover, the context panel or the palette.
 */
export function SessionHeader({
  session,
  workspace,
  providers,
  usage,
  status,
  busy,
  onCancel,
}: SessionHeaderProps): JSX.Element {
  const provider = providers.find(
    (entry) => entry.metadata.id === session.providerId,
  );
  const model = provider?.models.find((entry) => entry.id === session.modelId);

  return (
    <header className="header">
      <div className="header__main">
        <h1 className="header__title">{session.name}</h1>
        <span className="header__subtitle">
          {workspace ? workspace.name : formatPath(session.workingDirectory, 28)}
        </span>
        {status && status !== "idle" ? (
          <span className="header__subtitle">{statusLabel(status)}</span>
        ) : null}
      </div>

      <div className="header__actions">
        {busy ? (
          <button type="button" className="quiet-button" onClick={onCancel}>
            <Square size={12} strokeWidth={2} aria-hidden="true" />
            Stop
          </button>
        ) : null}

        <ModelPicker session={session} providers={providers} />

        <UsageIndicator
          usage={usage}
          providers={providers}
          activeProviderId={session.providerId}
          activeModelName={model?.displayName ?? provider?.metadata.displayName ?? null}
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
