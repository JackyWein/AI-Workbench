import { useEffect, useMemo, useState, type JSX } from "react";
import { BookOpen, ChevronDown, Download, PenLine, Sparkles, X } from "lucide-react";
import type { DiscoveredSkill, SkillManifest, SkillScopes } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { DraftChoicePicker } from "./DraftChoicePicker.js";
import {
  type DraftChoice,
  draftingProviders,
  initialDraftChoice,
  rememberDraftChoice,
} from "../lib/draft-choice.js";

type Panel =
  | { kind: "edit"; skill: SkillManifest | null; draftedBy?: string }
  | { kind: "draft" }
  | { kind: "import" };

/**
 * Skills are instructions every agent follows where they apply (spec §29).
 * A skill is written here, drafted by one of the person's own tools, or
 * brought over from the folders their tools already keep skills in — so a
 * skill made for one tool works for all of them.
 */
export function SkillsView(): JSX.Element {
  const skills = useWorkbench((state) => state.skills);
  const scopes = useWorkbench((state) => state.skillScopes);
  const refreshSkills = useWorkbench((state) => state.refreshSkills);
  const importFolder = useWorkbench((state) => state.importSkills);
  const importFiles = useWorkbench((state) => state.importSkillFiles);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const decided = (skill: SkillManifest): string => {
    const at = (scope: keyof SkillScopes): boolean | undefined =>
      scopes[scope]?.find((entry) => entry.skillId === skill.id)?.enabled;
    if (at("session") !== undefined) {
      return at("session") ? "On in this session" : "Off in this session";
    }
    if (at("workspace") !== undefined) {
      return at("workspace") ? "On in this workspace" : "Off in this workspace";
    }
    return at("global") ? "On everywhere" : "Off";
  };

  return (
    <div className="connectors">
      <div className="view">
        <div className="view__inner">
          <header className="view__header connectors__header">
            <div className="view__heading">
              <h1 className="view__title">Skills</h1>
              <p className="view__lede">
                Instructions your agents follow where they apply. Write one, have a tool draft it, or
                bring over the ones you made for another tool.
              </p>
            </div>
            <div className="view__actions">
              <div className="menu-anchor">
                <button
                  type="button"
                  className="ghost-button"
                  aria-expanded={menu}
                  onClick={() => setMenu((value) => !value)}
                >
                  <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                  Import
                  <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {menu ? (
                  <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        setPanel({ kind: "import" });
                      }}
                    >
                      From your tools…
                      <span>Claude Code, Codex, Gemini CLI, OpenCode</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        void importFiles();
                      }}
                    >
                      Markdown files…
                      <span>A SKILL.md, or any .md</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        void importFolder();
                      }}
                    >
                      A folder…
                      <span>Every skill in it</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <button type="button" className="ghost-button" onClick={() => setPanel({ kind: "draft" })}>
                <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
                Draft with AI
              </button>
              <button type="button" className="primary-button" onClick={() => setPanel({ kind: "edit", skill: null })}>
                <PenLine size={13} strokeWidth={1.75} aria-hidden="true" />
                New skill
              </button>
            </div>
          </header>

          {skills.length === 0 ? (
            <div className="start-tiles">
              <button type="button" className="start-tile" onClick={() => setPanel({ kind: "edit", skill: null })}>
                <PenLine size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="start-tile__title">Write a skill</span>
                <span className="start-tile__text">In your own words, in Markdown.</span>
              </button>
              <button type="button" className="start-tile" onClick={() => setPanel({ kind: "draft" })}>
                <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="start-tile__title">Draft with AI</span>
                <span className="start-tile__text">Say what it should do; a tool of yours writes it.</span>
              </button>
              <button type="button" className="start-tile" onClick={() => setPanel({ kind: "import" })}>
                <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="start-tile__title">Import from your tools</span>
                <span className="start-tile__text">Skills you keep for Claude Code, Codex and others.</span>
              </button>
            </div>
          ) : (
            <div className="connector-grid">
              {skills.map((skill) => (
                <button
                  type="button"
                  key={skill.id}
                  className="connector-card"
                  onClick={() => setPanel({ kind: "edit", skill })}
                >
                  <span className="connector-logo" style={{ width: 36, height: 36 }} aria-hidden="true">
                    <BookOpen size={16} strokeWidth={1.75} />
                  </span>
                  <span className="connector-card__text">
                    <span className="connector-card__name">{skill.name}</span>
                    {skill.description ? (
                      <span className="connector-card__description">{skill.description}</span>
                    ) : null}
                    <span className="connector-card__meta">
                      {decided(skill)} · {sourceWords(skill)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {panel ? (
        <aside className="connector-panel" aria-label="Skill">
          <button
            type="button"
            className="icon-button connector-panel__close"
            aria-label="Close"
            onClick={() => setPanel(null)}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {panel.kind === "edit" ? (
            <SkillEditor
              key={panel.skill?.id ?? `new-${panel.draftedBy ?? ""}`}
              skill={panel.skill}
              draftedBy={panel.draftedBy}
              onDone={() => setPanel(null)}
            />
          ) : panel.kind === "draft" ? (
            <SkillDrafter
              onDrafted={(skill, by) => setPanel({ kind: "edit", skill, draftedBy: by })}
            />
          ) : (
            <ImportFromTools onDone={() => setPanel(null)} />
          )}
        </aside>
      ) : null}
    </div>
  );
}

function sourceWords(skill: SkillManifest): string {
  switch (skill.source.kind) {
    case "authored":
      return "written here";
    case "import":
      return skill.source.importer === "tool-skill" ? "from a tool's skills" : "imported";
    case "directory":
      return "from a folder";
    default:
      return "built in";
  }
}

/** A short id from the name, unique among the skills there are. */
function skillId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill";
  let id = base;
  for (let count = 2; taken.includes(id); count += 1) {
    id = `${base}-${count}`;
  }
  return id;
}

function SkillEditor({
  skill,
  draftedBy,
  onDone,
}: {
  readonly skill: SkillManifest | null;
  readonly draftedBy: string | undefined;
  readonly onDone: () => void;
}): JSX.Element {
  const skills = useWorkbench((state) => state.skills);
  const scopes = useWorkbench((state) => state.skillScopes);
  const save = useWorkbench((state) => state.saveSkill);
  const remove = useWorkbench((state) => state.deleteSkill);
  const setEnabled = useWorkbench((state) => state.setSkillEnabled);
  const hasWorkspace = useWorkbench((state) => state.activeWorkspaceId !== null);
  const hasSession = useWorkbench((state) => state.activeSessionId !== null);
  const existing = skill !== null && skills.some((entry) => entry.id === skill.id);
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [everywhere, setEverywhere] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const decision = (scope: keyof SkillScopes): boolean =>
    (skill ? scopes[scope]?.find((entry) => entry.skillId === skill.id)?.enabled : undefined) ?? false;
  const ready = name.trim() !== "" && instructions.trim() !== "";

  const submit = async (): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      const id = existing && skill ? skill.id : skillId(name, skills.map((entry) => entry.id));
      const failed = await save({
        schemaVersion: 1,
        id,
        name: name.trim(),
        description: description.trim(),
        version: skill?.version ?? "1.0.0",
        instructions: instructions.trim(),
        requiredCapabilities: skill?.requiredCapabilities ?? [],
        tools: skill?.tools ?? [],
        mcpDependencies: skill?.mcpDependencies ?? [],
        metadata: skill?.metadata ?? {},
        source: existing && skill ? skill.source : { kind: "authored" },
      });
      if (failed) {
        setProblem(failed);
        return;
      }
      // A new skill is meant to be used; it starts on everywhere unless
      // the person said otherwise.
      if (!existing && everywhere) {
        await setEnabled(id, "global", true);
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="connector-panel__head">
        <span className="connector-logo" style={{ width: 44, height: 44 }} aria-hidden="true">
          <BookOpen size={18} strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="connector-panel__title">{existing ? name || skill?.name : "New skill"}</h2>
          <p className="connector-panel__publisher">
            {draftedBy ? `Drafted by ${draftedBy} — read it before you save it` : existing && skill ? sourceWords(skill) : "Written here"}
          </p>
        </div>
      </div>
      <div className="connector-panel__fields">
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="stacked-field">
          <span className="field__description">When it applies (one sentence)</span>
          <input
            className="text-input"
            value={description}
            placeholder="Use when reviewing a pull request"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Instructions (Markdown)</span>
          <textarea
            className="text-input text-input--multiline skill-editor__instructions"
            rows={14}
            spellCheck={false}
            value={instructions}
            placeholder={"1. Read the whole change first.\n2. …"}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
      </div>
      <div className="connector-panel__section">
        <p className="connector-panel__label">Used in</p>
        {existing && skill ? (
          <>
            <label className="radio-row">
              <input
                type="checkbox"
                checked={decision("global")}
                onChange={(event) => void setEnabled(skill.id, "global", event.target.checked)}
              />
              <span>Every session</span>
            </label>
            <label className="radio-row">
              <input
                type="checkbox"
                checked={decision("workspace")}
                disabled={!hasWorkspace}
                onChange={(event) => void setEnabled(skill.id, "workspace", event.target.checked)}
              />
              <span>This workspace</span>
            </label>
            <label className="radio-row">
              <input
                type="checkbox"
                checked={decision("session")}
                disabled={!hasSession}
                onChange={(event) => void setEnabled(skill.id, "session", event.target.checked)}
              />
              <span>
                This session
                <span className="field__description">The narrowest choice wins.</span>
              </span>
            </label>
          </>
        ) : (
          <label className="radio-row">
            <input type="checkbox" checked={everywhere} onChange={(event) => setEverywhere(event.target.checked)} />
            <span>Every session, from now on</span>
          </label>
        )}
      </div>
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="connector-panel__actions">
        {existing && skill ? (
          <button
            type="button"
            className="ghost-button"
            data-tone="danger"
            onClick={() => void remove(skill.id).then(onDone)}
          >
            Remove
          </button>
        ) : null}
        <button type="button" className="primary-button" disabled={!ready || saving} onClick={() => void submit()}>
          {saving ? "Saving…" : "Save skill"}
        </button>
      </div>
    </>
  );
}

function SkillDrafter({
  onDrafted,
}: {
  readonly onDrafted: (skill: SkillManifest, by: string) => void;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const draft = useWorkbench((state) => state.draftSkill);
  const usable = useMemo(() => draftingProviders(providers), [providers]);
  const [choice, setChoice] = useState<DraftChoice>(() => initialDraftChoice("skill", usable));
  // Providers load after the panel opens; a choice made before they did
  // starts from the remembered one once they are there.
  useEffect(() => {
    if (!usable.some((entry) => entry.metadata.id === choice.providerId)) {
      setChoice(initialDraftChoice("skill", usable));
    }
  }, [usable, choice.providerId]);
  const provider = usable.find((entry) => entry.metadata.id === choice.providerId);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (!provider) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      rememberDraftChoice("skill", choice);
      const result = await draft({
        providerId: provider.metadata.id,
        ...(choice.modelId ? { modelId: choice.modelId } : {}),
        ...(choice.effort ? { reasoningEffort: choice.effort } : {}),
        request: request.trim(),
      });
      if ("error" in result) {
        setProblem(result.error);
        return;
      }
      onDrafted(
        {
          schemaVersion: 1,
          id: "",
          name: result.draft.name,
          description: result.draft.description,
          version: "1.0.0",
          instructions: result.draft.instructions,
          requiredCapabilities: [],
          tools: [],
          mcpDependencies: [],
          metadata: {},
          source: { kind: "authored" },
        },
        result.draft.modelId
          ? `${provider.metadata.displayName} · ${
              provider.models.find((model) => model.id === result.draft.modelId)?.displayName ?? result.draft.modelId
            }`
          : provider.metadata.displayName,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="connector-panel__head">
        <span className="connector-logo" style={{ width: 44, height: 44 }} aria-hidden="true">
          <Sparkles size={18} strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="connector-panel__title">Draft a skill</h2>
          <p className="connector-panel__publisher">One of your tools writes it; you read and save it.</p>
        </div>
      </div>
      <div className="connector-panel__fields">
        <label className="stacked-field">
          <span className="field__description">What should the skill do?</span>
          <textarea
            className="text-input text-input--multiline"
            rows={6}
            value={request}
            placeholder="Review pull requests the way our team does: security first, then tests, then naming…"
            onChange={(event) => setRequest(event.target.value)}
          />
        </label>
        <div className="stacked-field">
          <span className="field__description">Written by</span>
          {usable.length === 0 ? (
            <p className="setting__description">No provider is ready. Install and sign in to one under Providers.</p>
          ) : (
            <DraftChoicePicker usable={usable} value={choice} onChange={setChoice} label="Written by" />
          )}
        </div>
        <p className="setting__description">
          It runs once in an empty folder with read-only access, and uses your plan like any other
          message.
        </p>
      </div>
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="connector-panel__actions">
        <button
          type="button"
          className="primary-button"
          disabled={!provider || request.trim().length < 3 || busy}
          onClick={() => void run()}
        >
          {busy ? `${provider?.metadata.displayName ?? "It"} is writing…` : "Draft"}
        </button>
      </div>
    </>
  );
}

function ImportFromTools({ onDone }: { readonly onDone: () => void }): JSX.Element {
  const discover = useWorkbench((state) => state.discoverSkills);
  const importPaths = useWorkbench((state) => state.importDiscoveredSkills);
  const [found, setFound] = useState<DiscoveredSkill[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void discover().then((skills) => {
      if (current) {
        setFound(skills);
      }
    });
    return () => {
      current = false;
    };
  }, [discover]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await importPaths([...chosen]);
      if (result.failed) {
        setProblem(result.failed);
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const byTool = new Map<string, DiscoveredSkill[]>();
  for (const skill of found ?? []) {
    byTool.set(skill.providerName, [...(byTool.get(skill.providerName) ?? []), skill]);
  }

  return (
    <>
      <div className="connector-panel__head">
        <span className="connector-logo" style={{ width: 44, height: 44 }} aria-hidden="true">
          <Download size={18} strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="connector-panel__title">Import from your tools</h2>
          <p className="connector-panel__publisher">Skills your tools keep in their own folders.</p>
        </div>
      </div>
      {found === null ? (
        <p className="setting__description">Looking…</p>
      ) : found.length === 0 ? (
        <p className="setting__description">
          None of your tools keeps skills yet. Claude Code keeps them in ~/.claude/skills, Codex in
          ~/.codex/skills, Gemini CLI in ~/.gemini/skills — each one a folder with a SKILL.md.
        </p>
      ) : (
        [...byTool.entries()].map(([tool, skills]) => (
          <div className="connector-panel__section" key={tool}>
            <p className="connector-panel__label">{tool}</p>
            {skills.map((skill) => (
              <label className="radio-row" key={skill.path} title={skill.path}>
                <input
                  type="checkbox"
                  disabled={skill.imported}
                  checked={skill.imported || chosen.has(skill.path)}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) {
                      next.add(skill.path);
                    } else {
                      next.delete(skill.path);
                    }
                    setChosen(next);
                  }}
                />
                <span>
                  {skill.name}
                  {skill.imported ? " · imported" : ""}
                  <span className="field__description">
                    {skill.description ? `${skill.description} · ` : ""}
                    {skill.source}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ))
      )}
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="connector-panel__actions">
        <button type="button" className="primary-button" disabled={chosen.size === 0 || busy} onClick={() => void run()}>
          {busy ? "Importing…" : chosen.size > 0 ? `Import ${chosen.size}` : "Import"}
        </button>
      </div>
    </>
  );
}
