import { type JSX } from "react";
import type { ProviderSummary } from "@ai-workbench/shared";
import type { DraftChoice } from "../lib/draft-choice.js";
import { providerLabel } from "../lib/provider-label.js";
import { effortLabel, reasoningEffortsFor } from "../lib/reasoning-effort.js";
import { Logo } from "./Logo.js";

/**
 * The tool, its model and — where the model has levels — the effort that
 * something drafted by AI runs on. One component for every "made by AI"
 * flow, so none offers the tool without its model.
 */
export function DraftChoicePicker({
  usable,
  value,
  onChange,
  label,
}: {
  readonly usable: readonly ProviderSummary[];
  readonly value: DraftChoice;
  readonly onChange: (choice: DraftChoice) => void;
  /** Names the group for assistive technology, e.g. "Written by". */
  readonly label: string;
}): JSX.Element {
  const provider = usable.find((entry) => entry.metadata.id === value.providerId);
  const models = provider?.models ?? [];
  const efforts = reasoningEffortsFor(provider, value.modelId || null);
  return (
    <div className="draft-choice">
      <div className="tool-chips" role="radiogroup" aria-label={label}>
        {usable.map((entry) => (
          <button
            key={entry.metadata.id}
            type="button"
            role="radio"
            aria-checked={entry.metadata.id === value.providerId}
            className="tool-chip"
            title={providerLabel(entry)}
            onClick={() => onChange({ providerId: entry.metadata.id, modelId: "", effort: "" })}
          >
            <Logo name={entry.metadata.icon ?? entry.metadata.id} label={entry.metadata.displayName} size={15} />
            <span className="tool-chip__name">{providerLabel(entry)}</span>
          </button>
        ))}
      </div>
      {models.length > 0 ? (
        <select
          className="select draft-choice__select"
          aria-label="Model"
          value={value.modelId}
          onChange={(event) => onChange({ ...value, modelId: event.target.value, effort: "" })}
        >
          <option value="">The tool's default model</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      ) : null}
      {efforts.length > 0 ? (
        <select
          className="select draft-choice__select"
          aria-label="Reasoning effort"
          value={efforts.includes(value.effort) ? value.effort : ""}
          onChange={(event) => onChange({ ...value, effort: event.target.value })}
        >
          <option value="">The tool's default effort</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effortLabel(effort)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
