import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { ModelInfo } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { isPickableProvider } from "../lib/provider-label.js";
import { usePanelFit } from "../lib/panel-fit.js";

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
  /** Providers opened in the list; the session's own opens with the list. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // In the composer the pill sits at the foot of the window: the list opens
  // upward there, and scrolls rather than running off the window.
  const fit = usePanelFit(open, triggerRef, 320, 460);

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
      setExpanded(new Set(session?.providerId ? [session.providerId] : []));
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
        ref={triggerRef}
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
        <div
          className="popover__panel popover__panel--scroll picker"
          data-placement={fit.placement}
          data-align={fit.align}
          role="listbox"
          aria-label="Models and teams"
          style={{ width: 320, maxHeight: fit.maxHeight }}
        >
          <div className="picker__search">
            <input
              ref={inputRef}
              className="text-input"
              value={query}
              placeholder="Filter models and teams"
              aria-label="Filter models and teams"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {visibleTeams.length > 0 || sessionTeam ? (
            <div className="picker__group">
              <p className="picker__label">Teams</p>
              {visibleTeams.map((team) => {
                const runs = teamRuns[team.id] ?? [];
                const active = runs.filter((run) => run.status === "running" || run.status === "paused").length;
                return (
                  <button
                    key={team.id}
                    type="button"
                    className="picker__row"
                    role="option"
                    aria-selected={team.id === sessionTeam?.id}
                    onClick={() => openTeam(team.id)}
                    title={
                      active > 0
                        ? `${active} run(s) active — show it in this session`
                        : "Show this team in this session"
                    }
                  >
                    <span className="picker__name">{team.name}</span>
                    <span className="picker__meta">
                      {team.agents.length} agents{active > 0 ? ` · ${active} active` : ""}
                    </span>
                    {team.id === sessionTeam?.id ? <Check size={13} aria-hidden="true" /> : null}
                  </button>
                );
              })}
              {sessionTeam ? (
                <button
                  type="button"
                  className="picker__row picker__row--quiet"
                  onClick={() => {
                    setOpen(false);
                    void clearSessionTeam(session.id);
                  }}
                  title="Back to a normal single-provider session"
                >
                  <span className="picker__name">Leave {sessionTeam.name} — solo session</span>
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="picker__group">
            <p className="picker__label">Models</p>
            {visibleProviders.length === 0 ? (
              <p className="picker__empty">
                {needle ? "Nothing matches." : "No installed tool offers model choice yet."}
              </p>
            ) : (
              visibleProviders.map(({ entry }) => {
                const id = entry.metadata.id;
                const filteredModels = entry.models.filter(
                  (candidate) =>
                    !needle ||
                    entry.metadata.displayName.toLowerCase().includes(needle) ||
                    `${candidate.displayName} ${candidate.id}`.toLowerCase().includes(needle),
                );
                // Filtering opens every tool with a match; otherwise only the
                // ones opened by hand, and the session's own.
                const isOpen = needle !== "" || expanded.has(id);
                const current = session.providerId === id;
                const currentModel = current
                  ? (entry.models.find((candidate) => candidate.id === session.modelId)?.displayName ?? "Tool's default")
                  : null;
                return (
                  <div key={id} className="picker__provider" data-open={isOpen}>
                    <button
                      type="button"
                      className="picker__head"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(id)) {
                            next.delete(id);
                          } else {
                            next.add(id);
                          }
                          return next;
                        })
                      }
                    >
                      <ChevronRight className="picker__chevron" size={13} aria-hidden="true" />
                      <span className="picker__name">{entry.metadata.displayName}</span>
                      <span className="picker__meta">
                        {currentModel ?? `${entry.models.length} model${entry.models.length === 1 ? "" : "s"}`}
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="picker__models">
                        <button
                          type="button"
                          className="picker__row"
                          role="option"
                          aria-selected={current && !session.modelId}
                          onClick={() => pickModel(id, null)}
                          title="Start without a model; the tool uses its own default"
                        >
                          <span className="picker__name">Tool's default</span>
                          {current && !session.modelId ? <Check size={13} aria-hidden="true" /> : null}
                        </button>
                        {filteredModels.map((candidate) => {
                          const origin = modelOrigin(candidate);
                          const selected = current && session.modelId === candidate.id;
                          return (
                            <button
                              key={candidate.id}
                              type="button"
                              className="picker__row"
                              role="option"
                              aria-selected={selected}
                              onClick={() => pickModel(id, candidate.id)}
                              title={origin ? `${candidate.id} — ${origin}` : candidate.id}
                            >
                              <span className="picker__name">{candidate.displayName}</span>
                              {selected ? <Check size={13} aria-hidden="true" /> : null}
                            </button>
                          );
                        })}
                        {entry.models.length === 0 ? (
                          <p className="picker__empty">
                            {entry.metadata.displayName} lists no models — add yours under Providers.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
