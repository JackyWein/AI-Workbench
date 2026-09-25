import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  Compass,
  Crown,
  FileText,
  FlaskConical,
  Hammer,
  LayoutPanelTop,
  Palette,
  Plus,
  Rocket,
  SearchCheck,
  Server,
  Shield,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import {
  agentInstructions,
  agentReasoningEffort,
  type ProviderSummary,
  type TeamDefinition,
  type TeamTemplate,
  type TeamTemplateMember,
} from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import { useWorkbench } from "../store/workbench.js";
import { isPickableProvider, providerLabel } from "../lib/provider-label.js";
import { effortLabel, reasoningEffortsFor } from "../lib/reasoning-effort.js";
import {
  CUSTOM_ROLE,
  ROLE_PRESETS,
  TEAM_TEMPLATES,
  presetOf,
  type RoleIcon,
  type RolePreset,
} from "../lib/team-roles.js";
import { Switch } from "./Controls.js";
import { Logo } from "./Logo.js";
import { OwnTeamTemplates } from "./TeamTemplates.js";

const ICONS: Record<RoleIcon, LucideIcon> = {
  compass: Compass,
  hammer: Hammer,
  layout: LayoutPanelTop,
  server: Server,
  "search-check": SearchCheck,
  flask: FlaskConical,
  palette: Palette,
  "book-open": BookOpen,
  "file-text": FileText,
  rocket: Rocket,
  shield: Shield,
  bug: Bug,
  user: User,
};

interface MemberDraft {
  readonly key: number;
  /** The agent's id when it is already on the team. */
  readonly id?: string;
  name: string;
  role: string;
  instructions: string;
  providerId: string;
  modelId: string;
  /** Reasoning effort, or "" for the tool's default. */
  effort: string;
  /** Settings the editor does not show, kept as they were. */
  readonly settings: Record<string, unknown>;
}

function draftFrom(preset: RolePreset | typeof CUSTOM_ROLE, key: number, providerId: string): MemberDraft {
  return {
    key,
    name: preset.name,
    role: preset.role,
    instructions: preset.instructions,
    providerId,
    modelId: "",
    effort: "",
    settings: {},
  };
}

/**
 * Creates a team, or edits one. Members are cards: who they are, the role
 * they start from — each with instructions of its own, editable — and the
 * tool they run on, picked by its mark. A new team can start from a
 * template. A team has no folder of its own unless the person gives it one;
 * a run works in the workspace it is started from.
 */
export function TeamEditor({
  team,
  onDone,
}: {
  readonly team?: TeamDefinition;
  readonly onDone: () => void;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const createTeam = useWorkbench((state) => state.createTeam);
  const updateTeam = useWorkbench((state) => state.updateTeam);
  const setWorkingDirectory = useWorkbench((state) => state.setTeamWorkingDirectory);

  const pickable = useMemo(() => providers.filter((entry) => isPickableProvider(entry)), [providers]);
  const firstProviderId = pickable[0]?.metadata.id ?? "";

  const [name, setName] = useState(team?.name ?? "");
  const [instructions, setInstructions] = useState(team?.settings.instructions ?? "");
  const keyRef = useRef(1);
  const nextKey = (): number => {
    const key = keyRef.current;
    keyRef.current += 1;
    return key;
  };
  const [members, setMembers] = useState<MemberDraft[]>(() =>
    team
      ? team.agents.map((agent) => ({
          key: nextKey(),
          id: agent.id,
          name: agent.displayName,
          role: agent.role,
          instructions: agentInstructions(agent),
          providerId: agent.providerId,
          modelId: agent.modelId ?? "",
          effort: agentReasoningEffort(agent),
          settings: agent.settings,
        }))
      : templateMembers(TEAM_TEMPLATES[0]?.members ?? [], nextKey, ""),
  );
  const [leadKey, setLeadKey] = useState<number>(() => {
    const index = team ? team.agents.findIndex((agent) => agent.id === team.leadAgentId) : 0;
    return (index >= 0 ? index : 0) + 1;
  });
  const [template, setTemplate] = useState<string | null>(team ? null : (TEAM_TEMPLATES[0]?.id ?? null));
  const [fixedFolder, setFixedFolder] = useState(team?.settings.workingDirectory ?? "");
  const [useFixed, setUseFixed] = useState(Boolean(team?.settings.workingDirectory));
  const [outside, setOutside] = useState(team?.settings.allowOutsideWorkspace ?? false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ownTemplates, setOwnTemplates] = useState<TeamTemplate[]>([]);
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  const loadOwnTemplates = async (): Promise<TeamTemplate[]> => {
    try {
      const listed = await invoke("teamTemplate.list", undefined);
      setOwnTemplates(listed);
      return listed;
    } catch (error) {
      setTemplateNote(describeError(error));
      return [];
    }
  };

  useEffect(() => {
    if (!team) {
      void loadOwnTemplates();
    }
    // Loaded once when a new team is started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Providers load after the editor opens; members without a tool get the
  // first one that can be picked instead of staying empty.
  useEffect(() => {
    if (firstProviderId.length === 0) {
      return;
    }
    setMembers((current) =>
      current.map((member) => (member.providerId.length > 0 ? member : { ...member, providerId: firstProviderId })),
    );
  }, [firstProviderId]);

  const patch = (key: number, change: Partial<MemberDraft>): void => {
    setMembers((current) =>
      current.map((member) => {
        if (member.key !== key) {
          return member;
        }
        const next = { ...member, ...change };
        // Another tool drops a model it does not offer.
        if (change.providerId !== undefined) {
          const provider = providers.find((entry) => entry.metadata.id === change.providerId);
          if (!provider?.models.some((model) => model.id === next.modelId)) {
            next.modelId = "";
          }
        }
        // Another tool or model drops an effort it does not offer.
        if (change.providerId !== undefined || change.modelId !== undefined || change.effort !== undefined) {
          const provider = providers.find((entry) => entry.metadata.id === next.providerId);
          if (next.effort && !reasoningEffortsFor(provider, next.modelId || null).includes(next.effort)) {
            next.effort = "";
          }
        }
        return next;
      }),
    );
  };

  const applyTemplate = (id: string): void => {
    const chosen = TEAM_TEMPLATES.find((entry) => entry.id === id);
    if (!chosen) {
      return;
    }
    setTemplate(id);
    const fresh = templateMembers(chosen.members, nextKey, firstProviderId);
    setMembers(fresh);
    setLeadKey(fresh[0]?.key ?? 1);
    // A name that came from a template follows the template; one the person
    // typed stays.
    if (
      name.trim() === "" ||
      TEAM_TEMPLATES.some((entry) => entry.name === name) ||
      ownTemplates.some((entry) => entry.name === name)
    ) {
      setName(chosen.name);
    }
  };

  /** Fills the editor from one of the person's own templates. */
  const applyOwnTemplate = (chosen: TeamTemplate): void => {
    setTemplate(chosen.id);
    const fresh = chosen.members.map((member) => memberFromTemplate(member, nextKey(), pickable, firstProviderId));
    setMembers(fresh);
    setLeadKey(fresh[chosen.leadIndex]?.key ?? fresh[0]?.key ?? 1);
    setName(chosen.name);
  };

  /** Keeps the members as they are now as a template of the person's own. */
  const saveAsTemplate = async (): Promise<void> => {
    const roster = members.filter((member) => member.name.trim().length > 0);
    if (roster.length === 0) {
      return;
    }
    try {
      const saved = await invoke("teamTemplate.save", {
        template: {
          name: name.trim() || "My team",
          summary: "",
          leadIndex: Math.max(0, roster.findIndex((member) => member.key === leadKey)),
          members: roster.map((member) => ({
            name: member.name.trim(),
            role: member.role.trim(),
            instructions: member.instructions.trim(),
            ...(member.providerId ? { providerId: member.providerId } : {}),
            ...(member.modelId ? { modelId: member.modelId } : {}),
            ...(member.effort ? { reasoningEffort: member.effort } : {}),
          })),
        },
      });
      await loadOwnTemplates();
      setTemplate(saved.id);
      setTemplateNote(`Saved as the template "${saved.name}".`);
    } catch (error) {
      setTemplateNote(describeError(error));
    }
  };

  const addMember = (preset: RolePreset | typeof CUSTOM_ROLE): void => {
    setMembers((current) => [...current, draftFrom(preset, nextKey(), firstProviderId)]);
    setAdding(false);
    setTemplate(null);
  };

  const removeMember = (key: number): void => {
    setMembers((current) => {
      if (current.length <= 1) {
        return current;
      }
      const rest = current.filter((member) => member.key !== key);
      if (leadKey === key) {
        setLeadKey(rest[0]?.key ?? 1);
      }
      return rest;
    });
    setTemplate(null);
  };

  const submit = async (): Promise<void> => {
    const roster = members.filter(
      (member) => member.name.trim().length > 0 && (member.providerId || firstProviderId).length > 0,
    );
    if (name.trim().length === 0 || roster.length === 0) {
      return;
    }
    const leadIndex = Math.max(0, roster.findIndex((member) => member.key === leadKey));
    const settingsOf = (member: MemberDraft): Record<string, unknown> => {
      const next: Record<string, unknown> = {
        ...member.settings,
        instructions: member.instructions.trim(),
      };
      // Empty means the tool's default; no stale effort may survive a reset.
      // Only an effort the member's tool actually offers is kept — a stored
      // value from another tool or an older model list is dropped, never sent.
      const provider = providers.find((entry) => entry.metadata.id === (member.providerId || firstProviderId));
      const offered = reasoningEffortsFor(provider, member.modelId || null);
      if (member.effort && offered.includes(member.effort)) {
        next["reasoningEffort"] = member.effort;
      } else {
        delete next["reasoningEffort"];
      }
      return next;
    };
    setSaving(true);
    try {
      if (!team) {
        // A new team's first member leads it.
        const ordered = [roster[leadIndex]!, ...roster.filter((_, index) => index !== leadIndex)];
        await createTeam({
          name: name.trim(),
          agents: ordered.map((member) => ({
            displayName: member.name.trim(),
            role: member.role.trim(),
            providerId: member.providerId || firstProviderId,
            ...(member.modelId ? { modelId: member.modelId } : {}),
            settings: settingsOf(member),
          })),
        });
        onDone();
        return;
      }
      const updated = await updateTeam({
        teamId: team.id,
        name: name.trim(),
        instructions,
        leadAgentIndex: leadIndex,
        agents: roster.map((member) => ({
          ...(member.id ? { id: member.id } : {}),
          displayName: member.name.trim(),
          role: member.role.trim(),
          providerId: member.providerId || firstProviderId,
          ...(member.modelId ? { modelId: member.modelId } : {}),
          settings: settingsOf(member),
        })),
      });
      const folder = useFixed && fixedFolder.trim().length > 0 ? fixedFolder.trim() : null;
      const folderChanged =
        folder !== (team.settings.workingDirectory ?? null) || outside !== team.settings.allowOutsideWorkspace;
      const placed = folderChanged
        ? await setWorkingDirectory({ teamId: team.id, workingDirectory: folder, allowOutsideWorkspace: outside })
        : true;
      if (updated && placed) {
        onDone();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="team-editor" role="group" aria-label={team ? `Edit ${team.name}` : "New team"}>
      <div className="team-editor__top">
        <input
          className="team-editor__name"
          value={name}
          placeholder="Team name"
          aria-label="Team name"
          onChange={(event) => setName(event.target.value)}
        />
        <p className="team-editor__hint">
          The lead plans the work and hands it out; every member works in its role, on the tool you pick.
        </p>
      </div>

      {team ? null : (
        <div className="team-editor__templates" role="radiogroup" aria-label="Start from">
          {TEAM_TEMPLATES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={template === entry.id}
              className="team-template"
              onClick={() => applyTemplate(entry.id)}
            >
              <span className="team-template__icons" aria-hidden="true">
                {entry.members.map((id) => {
                  const Icon = ICONS[ROLE_PRESETS.find((preset) => preset.id === id)?.icon ?? "user"];
                  return <Icon key={id} size={13} strokeWidth={1.75} />;
                })}
              </span>
              <span className="team-template__name">{entry.name}</span>
              <span className="team-template__summary">{entry.summary}</span>
            </button>
          ))}
        </div>
      )}

      {team ? null : (
        <OwnTeamTemplates
          templates={ownTemplates}
          selected={template}
          onApply={applyOwnTemplate}
          onChanged={(saved) => {
            void loadOwnTemplates();
            if (saved) {
              applyOwnTemplate(saved);
            }
          }}
        />
      )}
      {templateNote ? (
        <p className="field__description" role="status">
          {templateNote}
        </p>
      ) : null}

      {firstProviderId.length === 0 ? (
        <p className="field__description" role="note">
          No tool can take a member right now — install one or switch one on under Providers.
        </p>
      ) : null}

      <div className="team-editor__members">
        {members.map((member, index) => (
          <MemberEditor
            key={member.key}
            member={member}
            index={index}
            lead={member.key === leadKey}
            providers={providers}
            pickable={pickable}
            removable={members.length > 1}
            onPatch={(change) => patch(member.key, change)}
            onLead={() => setLeadKey(member.key)}
            onRemove={() => removeMember(member.key)}
          />
        ))}
        <div className="team-editor__add">
          {adding ? (
            <RoleMenu onPick={addMember} onClose={() => setAdding(false)} />
          ) : (
            <button type="button" className="team-editor__add-button" onClick={() => setAdding(true)}>
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              Add a member
            </button>
          )}
        </div>
      </div>

      {team ? (
        <div className="team-editor__settings">
          <label className="stacked-field">
            <span className="field__description">Instructions every member gets, on top of its own</span>
            <textarea
              className="text-input text-input--multiline"
              rows={2}
              value={instructions}
              placeholder="Keep changes small. Write tests first."
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>

          <fieldset className="team-editor__folder">
            <legend className="field__description">Where this team works</legend>
            <label className="radio-row">
              <input
                type="radio"
                name={`folder-${team.id}`}
                checked={!useFixed}
                onChange={() => setUseFixed(false)}
              />
              <span>
                In the workspace a run is started from
                <span className="field__description">From a session, that is the session&apos;s workspace.</span>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name={`folder-${team.id}`}
                checked={useFixed}
                onChange={() => setUseFixed(true)}
              />
              <span>Always in one folder</span>
            </label>
            {useFixed ? (
              <>
                <input
                  className="text-input"
                  value={fixedFolder}
                  placeholder="Absolute path"
                  spellCheck={false}
                  aria-label="Team folder"
                  onChange={(event) => setFixedFolder(event.target.value)}
                />
                <div className="setting setting--inline">
                  <div className="setting__text">
                    <p className="setting__label">Allow a folder outside the workspace</p>
                    <p className="setting__description">Off, the folder must be inside the team&apos;s workspace.</p>
                  </div>
                  <Switch label="Allow a folder outside the workspace" checked={outside} onChange={setOutside} />
                </div>
              </>
            ) : null}
          </fieldset>
        </div>
      ) : null}

      <div className="team-editor__actions">
        <button type="button" className="quiet-button" onClick={onDone}>
          Cancel
        </button>
        {team ? null : (
          <button type="button" className="quiet-button" onClick={() => void saveAsTemplate()}>
            Save as template
          </button>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={saving || name.trim().length === 0}
          onClick={() => void submit()}
        >
          {saving ? "Saving…" : team ? "Save team" : "Create team"}
        </button>
      </div>
    </div>
  );
}

/**
 * A member from a template of the person's own. The tool, model and effort it
 * suggests are taken only where they can be picked now; otherwise the member
 * starts on the first tool that can.
 */
function memberFromTemplate(
  member: TeamTemplateMember,
  key: number,
  pickable: readonly ProviderSummary[],
  fallbackProviderId: string,
): MemberDraft {
  const provider = member.providerId ? pickable.find((entry) => entry.metadata.id === member.providerId) : undefined;
  const modelId = provider && member.modelId && provider.models.some((model) => model.id === member.modelId) ? member.modelId : "";
  const effort =
    provider && member.reasoningEffort && reasoningEffortsFor(provider, modelId || null).includes(member.reasoningEffort)
      ? member.reasoningEffort
      : "";
  return {
    key,
    name: member.name,
    role: member.role,
    instructions: member.instructions,
    providerId: provider?.metadata.id ?? fallbackProviderId,
    modelId,
    effort,
    settings: {},
  };
}

function templateMembers(ids: readonly string[], nextKey: () => number, providerId: string): MemberDraft[] {
  return ids.flatMap((id) => {
    const preset = ROLE_PRESETS.find((entry) => entry.id === id);
    return preset ? [draftFrom(preset, nextKey(), providerId)] : [];
  });
}

/** One member as a card: who, in which role, on which tool. */
function MemberEditor({
  member,
  index,
  lead,
  providers,
  pickable,
  removable,
  onPatch,
  onLead,
  onRemove,
}: {
  readonly member: MemberDraft;
  readonly index: number;
  readonly lead: boolean;
  readonly providers: readonly ProviderSummary[];
  readonly pickable: readonly ProviderSummary[];
  readonly removable: boolean;
  readonly onPatch: (change: Partial<MemberDraft>) => void;
  readonly onLead: () => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const [choosingRole, setChoosingRole] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const preset = presetOf(member.role, member.instructions);
  const Icon = ICONS[preset?.icon ?? "user"];
  const provider = providers.find((entry) => entry.metadata.id === member.providerId);
  // A member keeps the tool it has even when that tool can no longer be
  // picked for someone new.
  const choices = provider && !pickable.includes(provider) ? [...pickable, provider] : pickable;
  const models = provider?.capabilities.supported.includes("modelSelection") ? provider.models : [];
  // Only what the member's tool offers for this model — same source as the
  // chat picker, so a team never offers an effort its tool does not know.
  const efforts = reasoningEffortsFor(provider, member.modelId || null);
  const edited = preset !== null && preset.instructions !== member.instructions;

  return (
    <article className="member-card" data-lead={lead}>
      <header className="member-card__head">
        <span className="member-card__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.75} />
          {provider ? (
            <span className="member-card__tool">
              <Logo name={provider.metadata.icon} label={provider.metadata.displayName} size={12} />
            </span>
          ) : null}
        </span>
        <input
          className="member-card__name"
          value={member.name}
          placeholder="Name"
          aria-label={`Name of member ${index + 1}`}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
        {lead ? (
          <span className="member-card__lead" title="Plans the work and hands it out">
            <Crown size={12} strokeWidth={2} aria-hidden="true" />
            Lead
          </span>
        ) : (
          <button type="button" className="member-card__make-lead" onClick={onLead} title="Make this member the lead">
            <Crown size={12} strokeWidth={1.75} aria-hidden="true" />
            Make lead
          </button>
        )}
        {removable ? (
          <button
            type="button"
            className="icon-button"
            onClick={onRemove}
            aria-label={`Remove ${member.name || `member ${index + 1}`}`}
            title="Remove from the team"
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div className="member-card__field">
        <span className="member-card__label">Role</span>
        {choosingRole ? (
          <RoleMenu
            current={preset?.id ?? "custom"}
            onPick={(picked) => {
              onPatch({
                role: picked.role,
                instructions: picked.instructions,
                // A name that only echoed the old role follows the new one.
                ...(member.name.trim() === "" || ROLE_PRESETS.some((entry) => entry.name === member.name)
                  ? { name: picked.name || member.name }
                  : {}),
              });
              setChoosingRole(false);
            }}
            onClose={() => setChoosingRole(false)}
          />
        ) : (
          <button type="button" className="member-card__role" onClick={() => setChoosingRole(true)} aria-haspopup="listbox">
            <span className="member-card__role-name">{preset ? preset.name : "Custom"}</span>
            <span className="member-card__role-text">{member.role || "No role yet"}</span>
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="member-card__field">
        <span className="member-card__label">Runs on</span>
        <div className="tool-chips" role="radiogroup" aria-label={`Tool for member ${index + 1}`}>
          {choices.map((entry) => (
            <button
              key={entry.metadata.id}
              type="button"
              role="radio"
              aria-checked={entry.metadata.id === member.providerId}
              className="tool-chip"
              title={providerLabel(entry)}
              onClick={() => onPatch({ providerId: entry.metadata.id })}
            >
              <Logo name={entry.metadata.icon} label={entry.metadata.displayName} size={15} />
              <span className="tool-chip__name">{providerLabel(entry)}</span>
            </button>
          ))}
        </div>
        {models.length > 0 ? (
          <select
            className="select member-card__model"
            aria-label={`Model for member ${index + 1}`}
            value={member.modelId}
            onChange={(event) => onPatch({ modelId: event.target.value })}
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
            className="select member-card__model"
            aria-label={`Reasoning effort for member ${index + 1}`}
            value={efforts.includes(member.effort) ? member.effort : ""}
            onChange={(event) => onPatch({ effort: event.target.value })}
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

      <div className="member-card__field">
        <button
          type="button"
          className="member-card__disclosure"
          aria-expanded={showInstructions}
          onClick={() => setShowInstructions((value) => !value)}
        >
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
          How it works{edited ? " · edited" : member.instructions ? "" : " · none"}
        </button>
        {showInstructions ? (
          <>
            <label className="stacked-field">
              <span className="sr-only">Role the team sees</span>
              <input
                className="text-input"
                value={member.role}
                placeholder="What the team sees next to its name"
                aria-label={`Role of member ${index + 1}`}
                onChange={(event) => onPatch({ role: event.target.value })}
              />
            </label>
            <textarea
              className="text-input text-input--multiline member-card__instructions"
              rows={6}
              value={member.instructions}
              placeholder="Only this member gets these instructions."
              aria-label={`Instructions for member ${index + 1}`}
              onChange={(event) => onPatch({ instructions: event.target.value })}
            />
            {edited ? (
              <button
                type="button"
                className="link-button"
                onClick={() => onPatch({ instructions: preset.instructions })}
              >
                Back to the {preset.name} instructions
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

/** The roles to pick from, each with what it does. */
function RoleMenu({
  current,
  onPick,
  onClose,
}: {
  readonly current?: string;
  readonly onPick: (preset: RolePreset | typeof CUSTOM_ROLE) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"], button')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const onPointer = (event: PointerEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);
  return (
    <div className="role-menu" ref={root} role="listbox" aria-label="Roles">
      {[...ROLE_PRESETS, CUSTOM_ROLE].map((preset) => {
        const Icon = ICONS[preset.icon];
        const selected = preset.id === current;
        return (
          <button
            key={preset.id}
            type="button"
            role="option"
            aria-selected={selected}
            className="role-menu__option"
            onClick={() => onPick(preset)}
          >
            <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="role-menu__text">
              <span className="role-menu__name">{preset.id === "custom" ? "Custom" : preset.name}</span>
              <span className="role-menu__summary">{preset.summary}</span>
            </span>
            {selected ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
