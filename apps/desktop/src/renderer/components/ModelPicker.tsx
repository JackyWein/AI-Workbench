import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { ModelInfo } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { effortLabel, reasoningEffortsFor } from "../lib/reasoning-effort.js";
import { isPickableProvider, providerLabel } from "../lib/provider-label.js";
import { tightestLimit, useNow } from "../lib/usage.js";
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
  const usage = useWorkbench((state) => state.usage);
  const now = useNow(60_000);
  const teams = useWorkbench((state) => state.teams);
  const teamRuns = useWorkbench((state) => state.teamRuns);
  const updateSession = useWorkbench((state) => state.updateSession);
  const setSessionTeam = useWorkbench((state) => state.setSessionTeam);
  const clearSessionTeam = useWorkbench((state) => state.clearSessionTeam);
  const setView = useWorkbench((state) => state.setView);
  const refreshTeams = useWorkbench((state) => state.refreshTeams);
  const requestSessionEffort = useWorkbench((state) => state.requestSessionEffort);

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
  const activeEffort = typeof session?.settings["reasoningEffort"] === "string"
    ? session.settings["reasoningEffort"] : null;
  const effortOptions = reasoningEffortsFor(provider, session?.modelId);
  const effortControls = effortOptions.length > 0 ? (
    <div className="picker__effort" aria-label="Reasoning effort">
      <span className="picker__effort-title">Reasoning effort</span>
      <div className="picker__effort-options">
        {[null, ...effortOptions].map((option) => (
          <button
            key={option ?? "default"}
            type="button"
            className="picker__effort-option"
            data-level={option ?? "default"}
            aria-pressed={activeEffort === option}
            aria-label={`Reasoning effort ${option ? effortLabel(option) : "Default"}`}
            title={option ? `Use ${option} for this model` : "Use the tool's default effort"}
            onClick={() => requestSessionEffort(option)}
          >
            {option ? effortLabel(option) : "Default"}
          </button>
        ))}
      </div>
    </div>
  ) : null;
  // A session bound to a team shows the team, not one of its models.
  const teamId = typeof session?.uiState["teamId"] === "string" ? session.uiState["teamId"] : null;
  const sessionTeam = teamId ? teams.find((entry) => entry.id === teamId) : undefined;
  const label = sessionTeam
    ? `${sessionTeam.name} · Team`
    : (model?.displayName ?? session?.modelId ?? provider?.metadata.displayName ?? "No model")
      + (activeEffort ? ` · ${effortLabel(activeEffort)}` : "");

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
    void updateSession({ id: session.id, providerId, modelId });
    setExpanded((previous) => new Set([...previous, providerId]));
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
        data-effort={activeEffort === "max" || activeEffort === "ultra" ? activeEffort : undefined}
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
                      <span className="picker__name">{providerLabel(entry)}</span>
                      <span className="picker__meta">
                        {currentModel ?? `${entry.models.length} model${entry.models.length === 1 ? "" : "s"}`}
                      </span>
                      <AccountUsage providerId={id} usage={usage} now={now} />
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
                        {current && !session.modelId ? effortControls : null}
                        {filteredModels.map((candidate) => {
                          const origin = modelOrigin(candidate);
                          const selected = current && session.modelId === candidate.id;
                          return (
                            <div key={candidate.id}>
                              <button
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
                              {selected ? effortControls : null}
                            </div>
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

/**
 * How much of its tightest window an account has used, as its tool reported
 * it — nothing when the tool reported none, never a guess.
 */
function AccountUsage({
  providerId,
  usage,
  now,
}: {
  readonly providerId: string;
  readonly usage: Parameters<typeof tightestLimit>[0];
  readonly now: number;
}): JSX.Element | null {
  const tightest = tightestLimit(usage, new Set([providerId]), now);
  if (!tightest) {
    return null;
  }
  return (
    <span
      className="picker__usage"
      data-tone={tightest.percentUsed >= 90 ? "danger" : tightest.percentUsed >= 70 ? "warning" : undefined}
      title={`${tightest.limit.label}: ${tightest.percentUsed}% used`}
    >
      {tightest.percentUsed}%
    </span>
  );
}
