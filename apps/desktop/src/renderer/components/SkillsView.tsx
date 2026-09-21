import { useEffect, useState, type JSX } from "react";
import { FolderInput, Trash2 } from "lucide-react";
import type { SkillManifest, SkillScopes } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

/**
 * Skills are provider-neutral instruction material (spec §29). A skill can be
 * switched on globally, for a workspace or for a single session, and the
 * narrowest scope wins — which is why each row shows all three.
 */
export function SkillsView(): JSX.Element {
  const skills = useWorkbench((state) => state.skills);
  const scopes = useWorkbench((state) => state.skillScopes);
  const refreshSkills = useWorkbench((state) => state.refreshSkills);
  const importSkills = useWorkbench((state) => state.importSkills);
  const hasWorkspace = useWorkbench((state) => state.activeWorkspaceId !== null);
  const hasSession = useWorkbench((state) => state.activeSessionId !== null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const runImport = async (): Promise<void> => {
    setImporting(true);
    try {
      await importSkills();
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">Skills</h1>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void runImport()}
            disabled={importing}
          >
            <FolderInput size={13} strokeWidth={1.75} aria-hidden="true" />
            {importing ? "Importing" : "Import from folder"}
          </button>
        </div>

        {skills.length === 0 ? (
          <p className="field__description">
            No skills yet. Import a folder of Markdown skills, or a folder of
            Claude-style skills with a <code>SKILL.md</code> in it.
          </p>
        ) : (
          <section>
            {skills.map((skill) => (
              <SkillEntry
                key={skill.id}
                skill={skill}
                scopes={scopes}
                hasWorkspace={hasWorkspace}
                hasSession={hasSession}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function SkillEntry({
  skill,
  scopes,
  hasWorkspace,
  hasSession,
}: {
  readonly skill: SkillManifest;
  readonly scopes: SkillScopes;
  readonly hasWorkspace: boolean;
  readonly hasSession: boolean;
}): JSX.Element {
  const setSkillEnabled = useWorkbench((state) => state.setSkillEnabled);
  const deleteSkill = useWorkbench((state) => state.deleteSkill);

  const decision = (scope: keyof SkillScopes): boolean | undefined =>
    scopes[scope]?.find((entry) => entry.skillId === skill.id)?.enabled;

  return (
    <article className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">{skill.name}</span>
        <span className="row__meta">{skill.version}</span>
      </div>

      {skill.description ? (
        <p className="field__description">{skill.description}</p>
      ) : null}

      <div className="scope-toggles">
        <ScopeToggle
          label="Everywhere"
          checked={decision("global") ?? false}
          onChange={(value) => void setSkillEnabled(skill.id, "global", value)}
        />
        <ScopeToggle
          label="This workspace"
          checked={decision("workspace") ?? false}
          disabled={!hasWorkspace}
          onChange={(value) => void setSkillEnabled(skill.id, "workspace", value)}
        />
        <ScopeToggle
          label="This session"
          checked={decision("session") ?? false}
          disabled={!hasSession}
          onChange={(value) => void setSkillEnabled(skill.id, "session", value)}
        />
      </div>

      {skill.requiredCapabilities.length > 0 ? (
        <div className="tag-list">
          {skill.requiredCapabilities.map((capability) => (
            <span className="tag" key={capability}>
              needs {capability}
            </span>
          ))}
        </div>
      ) : null}

      <div className="provider-entry__config">
        <button
          type="button"
          className="quiet-button"
          onClick={() => void deleteSkill(skill.id)}
        >
          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
          Remove
        </button>
      </div>
    </article>
  );
}

export function ScopeToggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className="scope-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
