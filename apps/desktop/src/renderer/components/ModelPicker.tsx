import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { isPickableProvider } from "../lib/provider-label.js";

/**
 * Where a model name comes from, in the same words as the command palette:
 * reported by the tool itself, shipped with the application, or added by
 * the person. Unknown (no source) shows nothing rather than guessing.
 */
function modelOrigin(model: ModelInfo): string | null {
  if (model.source === "user") {
    return "added by you";
  }
  if (model.source === "profile") {
    return "built-in name";
  }
  if (model.source === "provider") {
    return "reported by the tool";
  }
  return null;
}

/**
 * Provider → model dropdown for the chat header and composer (spec §56).
 * Unlike the command palette it shows providers grouped with their models
 * right away, plus the globally available teams. Teams open in the Teams
 * view: a chat session stays one provider, a team run lives on its team.
 */
export function ModelPicker(): JSX.Element {
  const sessions = useWorkbench((state) => state.sessions);
  const activeSessionId = useWorkbench((state) => state.activeSessionId);
  const providers = useWorkbench((state) => state.providers);
  const teams = useWorkbench((state) => state.teams);
  const teamRuns = useWorkbench((state) => state.teamRuns);
  const updateSession = useWorkbench((state) => state.updateSession);
  const setSessionTeam = useWorkbench((state) => state.setSessionTeam);
  const clearSessionTeam = useWorkbench((state) => state.clearSessionTeam);
  const setView = useWorkbench((state) => state.setView);
  const refreshTeams = useWorkbench((state) => state.refreshTeams);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const session = sessions.find((entry) => entry.id === activeSessionId);
  const provider = providers.find((entry) => entry.metadata.id === session?.providerId);
  const model = provider?.models.find((entry) => entry.id === session?.modelId);
  // A session bound to a team shows the team, not one of its models.
  const teamId = typeof session?.uiState["teamId"] === "string" ? session.uiState["teamId"] : null;
  const sessionTeam = teamId ? teams.find((entry) => entry.id === teamId) : undefined;
  const label = sessionTeam
    ? `${sessionTeam.name} · Team`
    : (model?.displayName ?? session?.modelId ?? provider?.metadata.displayName ?? "No model");

  useEffect(() => {
    if (open) {
      setQuery("");
      void refreshTeams();
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const modelProviders = useMemo(
    () =>
      providers.filter(
        (entry) =>
          isPickableProvider(entry) &&
          entry.capabilities.supported.includes("modelSelection"),
      ),
    [providers],
  );

  const visibleTeams = useMemo(() => {
    if (!needle) {
      return teams;
    }
    return teams.filter((team) => team.name.toLowerCase().includes(needle));
  }, [teams, needle]);

  const visibleProviders = useMemo(
    () =>
      modelProviders
        .map((entry) => {
          const models = entry.models.filter(
            (candidate) =>
              !needle ||
              `${candidate.displayName} ${candidate.id}`.toLowerCase().includes(needle),
          );
          const providerHit = !needle || entry.metadata.displayName.toLowerCase().includes(needle);
          return { entry, models: providerHit && !needle ? entry.models : models, providerHit };
        })
        .filter(({ entry, models, providerHit }) => providerHit || models.length > 0 || !needle && entry.models.length === 0),
    [modelProviders, needle],
  );

  const pickModel = (providerId: string, modelId: string | null): void => {
    if (!session) {
      return;
    }
    setOpen(false);
    void updateSession({ id: session.id, providerId, modelId });
  };

  const openTeam = (teamId: string): void => {
    // Picking a team in a session means: this session now shows that team
    // working. It does not send you away to the Teams screen.
    if (!session) {
      setView("teams");
      return;
    }
    setOpen(false);
    void setSessionTeam({ sessionId: session.id, teamId });
  };

  return (
    <div className="popover" ref={rootRef}>
      <button
        type="button"
        className="pill pill--acc"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Change model or open a team"
        disabled={!session}
      >
        {label} ▾
      </button>
      {open && session ? (
        <div className="popover__panel" role="listbox" aria-label="Models and teams" style={{ minWidth: 300 }}>
          <input
            ref={inputRef}
            className="text-input"
            value={query}
            placeholder="Filter models and teams"
            aria-label="Filter models and teams"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {visibleTeams.length > 0 ? (
            <>
              <p className="popover__title" style={{ marginTop: 12 }}>Teams</p>
              {visibleTeams.map((team) => {
                const runs = teamRuns[team.id] ?? [];
                const active = runs.filter((run) => run.status === "running" || run.status === "paused").length;
                return (
                  <button
                    key={team.id}
                    type="button"
                    className="quiet-button"
                    role="option"
                    aria-selected={false}
                    style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 8 }}
                    onClick={() => openTeam(team.id)}
                    title={
                      active > 0
                        ? `${active} run(s) active — show it in this session`
                        : "Show this team in this session"
                    }
                  >
                    <span>{team.name}</span>
                    <span className="row__meta">
                      {team.agents.length} agents{active > 0 ? ` · ${active} active` : ""}
                    </span>
                  </button>
                );
              })}
            </>
          ) : null}
          {sessionTeam ? (
            <button
              type="button"
              className="quiet-button"
              style={{ display: "block", width: "100%", textAlign: "left" }}
              onClick={() => {
                setOpen(false);
                void clearSessionTeam(session.id);
              }}
              title="Back to a normal single-provider session"
            >
              Leave {sessionTeam.name} · solo session
            </button>
          ) : null}
          <p className="popover__title" style={{ marginTop: 12 }}>Models</p>
          {visibleProviders.length === 0 ? (
            <p className="popover__detail">No installed tool offers model choice yet.</p>
          ) : (
            visibleProviders.map(({ entry }) => {
              const filteredModels = entry.models.filter(
                (candidate) =>
                  !needle ||
                  entry.metadata.displayName.toLowerCase().includes(needle) ||
                  `${candidate.displayName} ${candidate.id}`.toLowerCase().includes(needle),
              );
              const hasToolModels = entry.models.some((candidate) => candidate.source === "provider");
              return (
              <div key={entry.metadata.id} style={{ marginBottom: 4 }}>
                <p className="row__meta" style={{ margin: "8px 0 2px" }}>
                  {entry.metadata.displayName}
                </p>
                <button
                  type="button"
                  className="quiet-button"
                  role="option"
                  aria-selected={session.providerId === entry.metadata.id && !session.modelId}
                  style={{ display: "block", width: "100%", textAlign: "left" }}
                  onClick={() => pickModel(entry.metadata.id, null)}
                >
                  Default model — the tool chooses
                </button>
                {entry.models.length === 0 ? (
                  <>
                    <p className="popover__detail">No models reported yet.</p>
                    <p className="popover__detail">
                      {entry.metadata.displayName} lists no models itself — add yours under Providers.
                    </p>
                  </>
                ) : (
                  <>
                    {filteredModels.map((candidate) => {
                      const origin = modelOrigin(candidate);
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          className="quiet-button"
                          role="option"
                          aria-selected={
                            session.providerId === entry.metadata.id && session.modelId === candidate.id
                          }
                          style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 8, textAlign: "left" }}
                          onClick={() => pickModel(entry.metadata.id, candidate.id)}
                          title={candidate.id}
                        >
                          <span>{candidate.displayName}</span>
                          {origin ? <span className="row__meta">{origin}</span> : null}
                        </button>
                      );
                    })}
                    {hasToolModels ? null : (
                      <p className="popover__detail">
                        {entry.metadata.displayName} lists no models itself — add yours under Providers.
                      </p>
                    )}
                  </>
                )}
              </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
