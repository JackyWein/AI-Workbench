import type { JSX } from "react";
import type { ProviderSummary, Session } from "@ai-workbench/shared";
import { providerLabel } from "../lib/provider-label.js";
import { useWorkbench } from "../store/workbench.js";

interface ModelPickerProps {
  readonly session: Session;
  readonly providers: ProviderSummary[];
}

/**
 * Provider and model selection (spec §90). Both lists come from the registry and
 * the adapter's own capabilities, so nothing here knows a provider brand.
 * Hidden providers stay selectable for sessions already on them, but no new
 * session can pick one.
 */
export function ModelPicker({ session, providers }: ModelPickerProps): JSX.Element {
  const updateSession = useWorkbench((state) => state.updateSession);
  const setSessionRuntime = useWorkbench((state) => state.setSessionRuntime);
  const provider = providers.find((entry) => entry.metadata.id === session.providerId);
  const visibleProviders = providers.filter(
    (entry) => entry.enabled || entry.metadata.id === session.providerId,
  );
  const canSelectModel =
    provider?.capabilities.supported.includes("modelSelection") ?? false;
  const effortOptions = provider?.metadata.effortOptions ?? [];
  const effort = (session.settings["reasoningEffort"] as string | undefined) ?? "";

  return (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <label>
        <select
          className="select"
          value={session.providerId ?? ""}
          onChange={(event) =>
            void updateSession({ id: session.id, providerId: event.target.value })
          }
          aria-label="Provider"
        >
          {visibleProviders.map((entry) => (
            <option key={entry.metadata.id} value={entry.metadata.id}>
              {providerLabel(entry)}
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
          // A provider that reports no models leaves the tool to pick one.
          disabled={provider.models.length === 0}
          title={
            provider.models.length === 0
              ? "This tool does not list its models. Add them under Providers."
              : undefined
          }
        >
          {provider.models.length === 0 ? (
            <option value="">No models listed</option>
          ) : null}
          {!session.modelId && provider.models.length > 0 ? (
            <option value="">Default model</option>
          ) : null}
          {provider.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      ) : null}

      {effortOptions.length > 0 ? (
        <select
          className="select"
          value={effort}
          onChange={(event) =>
            void setSessionRuntime({
              reasoningEffort: event.target.value === "" ? null : event.target.value,
            })
          }
          aria-label="Reasoning effort"
          title="Reasoning effort, as offered by this tool"
        >
          <option value="">Default effort</option>
          {effortOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
