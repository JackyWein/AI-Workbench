import { type JSX, useEffect, useMemo, useState } from "react";
import { Download, Sparkles, Trash2, Upload } from "lucide-react";
import type { TeamTemplate, TeamTemplateDraft } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import {
  draftingProviders,
  initialDraftChoice,
  rememberDraftChoice,
  type DraftChoice,
} from "../lib/draft-choice.js";
import { useWorkbench } from "../store/workbench.js";
import { DraftChoicePicker } from "./DraftChoicePicker.js";

/**
 * The person's own team templates, next to the built-in ones: pick one to
 * fill the editor, remove it, export or import them as JSON, or have a model
 * draft a new one — which is only stored once the person saves it.
 */
export function OwnTeamTemplates({
  templates,
  selected,
  onApply,
  onChanged,
}: {
  readonly templates: readonly TeamTemplate[];
  readonly selected: string | null;
  readonly onApply: (template: TeamTemplate) => void;
  /** After a template was saved, removed or imported; the saved one when there is one. */
  readonly onChanged: (saved?: TeamTemplate) => void;
}): JSX.Element {
  const [drafting, setDrafting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const remove = async (template: TeamTemplate): Promise<void> => {
    try {
      await invoke("teamTemplate.delete", { id: template.id });
      onChanged();
    } catch (error) {
      setNote(describeError(error));
    }
  };

  const exportAll = async (): Promise<void> => {
    try {
      const result = await invoke("teamTemplate.export", {});
      setNote(result.saved ? `Exported ${result.count} ${result.count === 1 ? "template" : "templates"}.` : null);
    } catch (error) {
      setNote(describeError(error));
    }
  };

  const importFile = async (): Promise<void> => {
    try {
      const result = await invoke("teamTemplate.import", undefined);
      const parts = [
        ...(result.imported > 0 ? [`Imported ${result.imported} ${result.imported === 1 ? "template" : "templates"}.`] : []),
        ...result.errors,
      ];
      setNote(parts.length > 0 ? parts.join(" ") : null);
      onChanged();
    } catch (error) {
      setNote(describeError(error));
    }
  };

  return (
    <div className="own-templates">
      <div className="own-templates__head">
        <span className="field__description">Your templates</span>
        <button type="button" className="quiet-button" onClick={() => setDrafting((open) => !open)} aria-expanded={drafting}>
          <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
          Draft with AI
        </button>
        <button type="button" className="quiet-button" onClick={() => void importFile()}>
          <Upload size={12} strokeWidth={1.75} aria-hidden="true" />
          Import
        </button>
        {templates.length > 0 ? (
          <button type="button" className="quiet-button" onClick={() => void exportAll()}>
            <Download size={12} strokeWidth={1.75} aria-hidden="true" />
            Export
          </button>
        ) : null}
      </div>
      {templates.length > 0 ? (
        <div className="team-editor__templates" role="radiogroup" aria-label="Your templates">
          {templates.map((template) => (
            <span key={template.id} className="own-template">
              <button
                type="button"
                role="radio"
                aria-checked={selected === template.id}
                className="team-template"
                onClick={() => onApply(template)}
              >
                <span className="team-template__name">{template.name}</span>
                <span className="team-template__summary">
                  {template.summary || template.members.map((member) => member.name).join(", ")}
                </span>
              </button>
              <button
                type="button"
                className="icon-button own-template__remove"
                aria-label={`Remove the template ${template.name}`}
                title="Remove this template"
                onClick={() => void remove(template)}
              >
                <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {note ? <p className="field__description" role="status">{note}</p> : null}
      {drafting ? (
        <TemplateDrafter
          onSaved={(saved) => {
            setDrafting(false);
            onChanged(saved);
          }}
          onClose={() => setDrafting(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * Describe a team, pick the tool and model that drafts it, read the draft,
 * and save it — or not. Nothing is stored before Save.
 */
function TemplateDrafter({
  onSaved,
  onClose,
}: {
  readonly onSaved: (template: TeamTemplate) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const usable = useMemo(() => draftingProviders(providers), [providers]);
  const [choice, setChoice] = useState<DraftChoice>(() => initialDraftChoice("team-template", usable));
  useEffect(() => {
    if (!usable.some((entry) => entry.metadata.id === choice.providerId)) {
      setChoice(initialDraftChoice("team-template", usable));
    }
  }, [usable, choice.providerId]);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamTemplateDraft | null>(null);

  const run = async (): Promise<void> => {
    if (!choice.providerId) {
      return;
    }
    setBusy(true);
    setProblem(null);
    setDraft(null);
    try {
      rememberDraftChoice("team-template", choice);
      setDraft(
        await invoke("teamTemplate.draft", {
          providerId: choice.providerId,
          ...(choice.modelId ? { modelId: choice.modelId } : {}),
          ...(choice.effort ? { reasoningEffort: choice.effort } : {}),
          request: request.trim(),
        }),
      );
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!draft) {
      return;
    }
    setBusy(true);
    try {
      const { modelId: _drafter, ...template } = draft;
      onSaved(await invoke("teamTemplate.save", { template }));
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="template-drafter" role="group" aria-label="Draft a team template">
      {usable.length === 0 ? (
        <p className="field__description">No tool can draft right now — install one or switch one on under Providers.</p>
      ) : (
        <DraftChoicePicker usable={usable} value={choice} onChange={setChoice} label="Drafted by" />
      )}
      <textarea
        className="text-input template-drafter__request"
        aria-label="What the team should be"
        rows={2}
        placeholder="A team that builds and tests small games; one member only reviews performance"
        value={request}
        onChange={(event) => setRequest(event.target.value)}
      />
      <div className="changes__commit-actions">
        <button type="button" className="quiet-button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="ghost-button push-right"
          disabled={busy || !choice.providerId || request.trim().length < 3}
          onClick={() => void run()}
        >
          {busy && !draft ? "Drafting…" : "Draft"}
        </button>
      </div>
      {problem ? (
        <p className="setting__error" role="alert">
          {problem}
        </p>
      ) : null}
      {draft ? (
        <div className="template-preview">
          <p className="template-preview__name">{draft.name}</p>
          {draft.summary ? <p className="field__description">{draft.summary}</p> : null}
          <ol className="template-preview__members">
            {draft.members.map((member, index) => (
              <li key={`${member.name}-${index}`}>
                <span className="template-preview__member">
                  {member.name}
                  {index === draft.leadIndex ? " · leads" : ""}
                </span>
                {member.role ? <span className="field__description"> — {member.role}</span> : null}
              </li>
            ))}
          </ol>
          <p className="field__description">
            {draft.modelId ? `Drafted by ${draft.modelId}. ` : ""}Not saved yet — nothing is kept until you save it.
          </p>
          <div className="changes__commit-actions">
            <button type="button" className="quiet-button" onClick={() => setDraft(null)}>
              Discard
            </button>
            <button type="button" className="primary-button push-right" disabled={busy} onClick={() => void save()}>
              Save template
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
