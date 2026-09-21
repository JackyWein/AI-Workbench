import type { JSX } from "react";
import type { ProviderSummary, Session } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

interface ModelPickerProps {
  readonly session: Session;
  readonly providers: ProviderSummary[];
}

/**
 * Provider and model selection (spec §90). Both lists come from the registry and
 * the adapter's own capabilities, so nothing here knows a provider brand.
 */
export function ModelPicker({ session, providers }: ModelPickerProps): JSX.Element {
  const updateSession = useWorkbench((state) => state.updateSession);
  const provider = providers.find((entry) => entry.metadata.id === session.providerId);
  const canSelectModel =
    provider?.capabilities.supported.includes("modelSelection") ?? false;

  return (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <label>
        <span className="visually-hidden" hidden>
          Provider
        </span>
        <select
          className="select"
          value={session.providerId ?? ""}
          onChange={(event) =>
            void updateSession({ id: session.id, providerId: event.target.value })
          }
          aria-label="Provider"
        >
          {providers.map((entry) => (
            <option key={entry.metadata.id} value={entry.metadata.id}>
              {entry.metadata.displayName}
            </option>
          ))}
        </select>
      </label>

      {canSelectModel && provider ? (
        <select
          className="select"
          value={session.modelId ?? ""}
          onChange={(event) =>
            void updateSession({ id: session.id, modelId: event.target.value })
          }
          aria-label="Model"
        >
          {session.modelId === null ? <option value="">Default model</option> : null}
          {provider.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
