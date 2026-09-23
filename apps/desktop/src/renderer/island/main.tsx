import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ISLAND_TIMING,
  type IslandEntry,
  type IslandState,
  type IslandTarget,
} from "@ai-workbench/shared";
import { LOGOS, resolveTheme } from "@ai-workbench/ui";
import "./island.css";

type HoverMode = "agents" | "usage";
type Face = "approval" | "question" | "working" | "idle" | "none";

/** Structural bridge type so cards stay testable without the preload. */
interface IslandBridge {
  onState(listener: (state: IslandState) => void): () => void;
  open(target: IslandTarget): Promise<void>;
  dismiss(): Promise<void>;
  cycle(direction: 1 | -1): Promise<void>;
  resetPosition(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
}

/**
 * The Status Island's own renderer (spec §95–§97, island-guide §§2–4).
 *
 * It renders what the attention service decided and nothing more: no priority
 * logic here, and no number it was not given. All state below is
 * presentation-local (hover intent, pinned card, expanded dock, hover mode).
 */
function Island(): JSX.Element | null {
  const bridge = window.workbenchIsland ?? null;
  const [state, setState] = useState<IslandState | null>(null);
  // The working-face hover choice (agents ⇄ usage) persists per the guide;
  // everything else about hover is momentary.
  const [hoverMode, setHoverMode] = useState<HoverMode>(() => {
    try {
      return window.localStorage.getItem("ai-workbench.island-hover") === "usage"
        ? "usage"
        : "agents";
    } catch {
      return "agents";
    }
  });
  const [hovering, setHovering] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const peekTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const wheelAt = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const reportedSize = useRef<{ width: number; height: number } | null>(null);
  const prevFaceKey = useRef<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      return undefined;
    }
    return bridge.onState(setState);
  }, [bridge]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset["theme"] = resolveTheme("system", media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // Every hook runs on every render, unconditionally: the null-guards below
  // return early, and an early return above a hook is what unmounted this
  // component with "Rendered more hooks than during the previous render".
  // A new picture collapses nothing the user opened: the expanded dock and
  // hover mode survive refreshes. Only a face change, or an emptied queue,
  // settles local state back.
  const derived = useMemo(() => (state ? deriveFace(state) : null), [state]);
  const faceKey = derived
    ? `${derived.face}:${derived.approvals.length}:${derived.questions.length}:${derived.working.length}`
    : null;
  useEffect(() => {
    if (!derived || faceKey === prevFaceKey.current) {
      return;
    }
    prevFaceKey.current = faceKey;
    if (
      derived.face === "idle" ||
      derived.face === "none" ||
      (derived.face === "approval" && derived.approvals.length === 0) ||
      (derived.face === "question" && derived.questions.length === 0)
    ) {
      setPinned(false);
    }
    setExpanded(false);
  }, [derived, faceKey]);

  // The window fits the face: report what the content measures so main can
  // size the window to it. Reports only on real change, never in a loop.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !bridge || !state) {
      return undefined;
    }
    const report = (): void => {
      const rect = root.getBoundingClientRect();
      const width = Math.min(480, Math.max(42, Math.ceil(rect.width)));
      const height = Math.min(640, Math.max(42, Math.ceil(rect.height)));
      const last = reportedSize.current;
      if (last && last.width === width && last.height === height) {
        return;
      }
      reportedSize.current = { width, height };
      void bridge.resize(width, height).catch(() => undefined);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(root);
    return () => observer.disconnect();
  }, [bridge, state, hovering, pinned, expanded, hoverMode]);

  useEffect(
    () => () => {
      if (peekTimer.current !== null) {
        window.clearTimeout(peekTimer.current);
      }
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    },
    [],
  );

  // No bridge or no state yet renders nothing: loading and error faces belong
  // to the main window, never to the transparent companion.
  if (!bridge || !state || !derived) {
    return null;
  }

  const docked = state.preferences.dockedEdge;
  const serviceCard = state.expanded && state.current.action !== null;
  const attentionFace = derived.face === "approval" || derived.face === "question";
  const showHover =
    hovering && !pinned && !expanded && !(serviceCard && !attentionFace);
  const showAttention = pinned || (expanded && attentionFace);
  const showGeneric = !attentionFace && (pinned || serviceCard) && state.current.action !== null;

  const clearHoverTimers = (): void => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const startHover = (): void => {
    clearHoverTimers();
    setHiding(false);
    setHovering(true);
  };
  const endHover = (): void => {
    clearHoverTimers();
    // Grace to reach the layer, then a short fade instead of a hard cut.
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null;
      setHiding(true);
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = null;
        setHovering(false);
        setHiding(false);
      }, ISLAND_TIMING.hideFadeMs);
    }, ISLAND_TIMING.peekGraceMs);
  };
  // Grabbing the unit starts an OS drag; no hover layer may follow it.
  const killHover = (): void => {
    clearHoverTimers();
    setHiding(false);
    setHovering(false);
  };
  const collapseCards = (): void => {
    setPinned(false);
    setExpanded(false);
  };
  /**
   * A drag release never counts as a click: past 5px of pointer travel the
   * press was a drag, not an activation.
   */
  const releasedFromDrag = (event: ReactMouseEvent): boolean => {
    const from = dragFrom.current;
    if (!from) {
      return false;
    }
    return Math.hypot(event.clientX - from.x, event.clientY - from.y) > 5;
  };
  const onCardClick = (event: ReactMouseEvent): void => {
    // An open card collapses back on plain background clicks, never on
    // buttons — and never on a drag release.
    const target = event.target as HTMLElement | null;
    if (target?.closest("button")) {
      return;
    }
    if (releasedFromDrag(event)) {
      return;
    }
    collapseCards();
  };
  const resetAll = (): void => {
    setHoverMode("agents");
    setPinned(false);
    setExpanded(false);
    setHovering(false);
    void bridge.resetPosition().catch(() => undefined);
  };

  const onCircleClick = (event: ReactMouseEvent): void => {
    if (releasedFromDrag(event)) {
      return;
    }
    if (derived.face === "working") {
      setHoverMode((mode) => {
        const next = mode === "agents" ? "usage" : "agents";
        try {
          window.localStorage.setItem("ai-workbench.island-hover", next);
        } catch {
          // A choice that cannot be remembered is not worth an error.
        }
        return next;
      });
      return;
    }
    if (derived.face === "approval" || derived.face === "question") {
      setPinned((value) => !value);
    }
  };

  const onPillToggle = (event: ReactMouseEvent): void => {
    if (releasedFromDrag(event)) {
      return;
    }
    if (derived.face === "approval" || derived.face === "question") {
      setPinned((value) => !value);
    } else {
      setExpanded((value) => !value);
    }
  };

  // Ink morph anchor: remounts face content on change so the crossfade + blur
  // pulse plays without touching root state (hover, timers, focus).
  const morphKey = `${derived.face}:${docked ?? "free"}`;

  return (
    <div
      ref={rootRef}
      className="isl"
      data-face={derived.face}
      data-docked={docked ?? "free"}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      onMouseDown={(event) => {
        dragFrom.current = { x: event.clientX, y: event.clientY };
        killHover();
      }}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button")) {
          return;
        }
        resetAll();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          void bridge.cycle(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          void bridge.cycle(-1);
        } else if (event.key === "Enter") {
          const target = event.target as HTMLElement | null;
          if (target?.closest(".isl__actions")) {
            return;
          }
          event.preventDefault();
          const first = derived.approvals[0] ?? derived.questions[0] ?? derived.working[0];
          if (first?.action) {
            void bridge.open(first.action.target);
          }
        } else if (event.key === "Escape") {
          setPinned(false);
          setExpanded(false);
          void bridge.dismiss();
        } else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
          // Answering a visible question from the keyboard. Until the
          // question backend lands, an option deep-links to its context.
          const option = derived.questions[0]?.options[Number(event.key) - 1];
          const action = derived.questions[0]?.action;
          if (option && action) {
            event.preventDefault();
            void bridge.open(action.target);
          }
        }
      }}
      onWheel={(event) => {
        const now = Date.now();
        if (now - wheelAt.current < ISLAND_TIMING.wheelThrottleMs) {
          return;
        }
        wheelAt.current = now;
        void bridge.cycle(event.deltaY > 0 ? 1 : -1);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void bridge.cycle(-1);
      }}
      role="group"
      tabIndex={0}
      aria-label={`Status Island: ${derived.unitTitle}`}
    >
      {docked ? (
        <EdgePill
          derived={derived}
          edge={docked}
          expanded={expanded}
          morphKey={morphKey}
          onToggle={onPillToggle}
        />
      ) : (
        <button
          type="button"
          className="isl__circle"
          onClick={onCircleClick}
          aria-label={derived.label}
          title={circleHint(derived.face, hoverMode)}
        >
          <span className="isl__morph" key={morphKey}>
            <IslandMark icon={derived.markIcon} label={derived.label} size={22} />
          </span>
          {derived.badge !== null ? (
            <span className="isl__badge">{derived.badge}</span>
          ) : null}
        </button>
      )}

      {showHover ? (
        <div
          className="isl__hover"
          data-hiding={hiding}
          onMouseEnter={startHover}
          onMouseLeave={endHover}
        >
          <HoverLayer derived={derived} hoverMode={hoverMode} bridge={bridge} />
        </div>
      ) : null}

      {showAttention ? (
        <div
          className="isl__card"
          onClick={onCardClick}
          onMouseEnter={startHover}
          onMouseLeave={endHover}
        >
          {derived.face === "approval" ? (
            <ApprovalCard entries={derived.approvals} bridge={bridge} />
          ) : (
            <QuestionCard entries={derived.questions} bridge={bridge} />
          )}
        </div>
      ) : null}

      {showGeneric && state.current.action ? (
        <div
          className="isl__card"
          onClick={onCardClick}
          onMouseEnter={startHover}
          onMouseLeave={endHover}
        >
          <GenericCard entry={state.current} bridge={bridge} />
        </div>
      ) : null}

      {expanded && derived.face !== "approval" && derived.face !== "question" ? (
        <div
          className="isl__card"
          onClick={onCardClick}
          onMouseEnter={startHover}
          onMouseLeave={endHover}
        >
          <ExpandedPanel derived={derived} />
        </div>
      ) : null}
    </div>
  );
}

interface Derived {
  readonly face: Face;
  readonly label: string;
  /** What the unit itself is about: a single entry's title, else the face. */
  readonly unitTitle: string;
  readonly markIcon: string | null;
  readonly badge: number | null;
  readonly approvals: IslandEntry[];
  readonly questions: IslandEntry[];
  readonly working: IslandEntry[];
  readonly usageRows: Array<{
    readonly providerId: string;
    readonly name: string;
    readonly window: string;
    readonly percentLeft: number | null;
  }>;
  readonly usageAt: Date | null;
}

function deriveFace(state: IslandState): Derived {
  const approvals = state.entries.filter((entry) => entry.widget === "needsAttention");
  const questions = state.entries.filter((entry) => entry.widget === "agentQuestion");
  const working = state.entries.filter(
    (entry) => entry.widget === "activeAgents" || entry.widget === "teamProgress",
  );
  const usageEntries = state.entries.filter((entry) => entry.usage.length > 0);
  const usageRows = usageEntries.flatMap((entry) => entry.usage);
  const usageAt = usageEntries.reduce<Date | null>(
    (latest, entry) => (!latest || entry.at > latest ? entry.at : latest),
    null,
  );

  if (approvals.length > 0) {
    const first = approvals[0];
    return {
      face: "approval",
      label: `${approvals.length} approval${approvals.length === 1 ? "" : "s"} pending`,
      unitTitle: approvals.length === 1 ? (first?.title ?? "Approval pending") : `${approvals.length} approvals pending`,
      markIcon: first?.icon ?? null,
      badge: approvals.length,
      approvals,
      questions,
      working,
      usageRows,
      usageAt,
    };
  }
  if (questions.length > 0) {
    const first = questions[0];
    return {
      face: "question",
      label: `${questions.length} question${questions.length === 1 ? "" : "s"} waiting`,
      unitTitle: questions.length === 1 ? (first?.title ?? "Question waiting") : `${questions.length} questions waiting`,
      markIcon: first?.icon ?? null,
      badge: questions.length,
      approvals,
      questions,
      working,
      usageRows,
      usageAt,
    };
  }
  if (working.length > 0) {
    const first = working[0];
    const label =
      working.length === 1 ? (first?.title ?? "Working") : `${working.length} agents active`;
    return {
      face: "working",
      label,
      unitTitle: working.length === 1 ? (first?.title ?? "Working") : label,
      markIcon: first?.icon ?? null,
      badge: null,
      approvals,
      questions,
      working,
      usageRows,
      usageAt,
    };
  }
  const onlyIdle = state.entries.length === 0 || state.entries.every((entry) => entry.widget === "idle");
  if (onlyIdle) {
    return {
      face: "none",
      label: "No agents",
      unitTitle: "No agents",
      markIcon: null,
      badge: null,
      approvals,
      questions,
      working,
      usageRows,
      usageAt,
    };
  }
  return {
    face: "idle",
    label: state.current.title,
    unitTitle: state.current.title,
    markIcon: state.current.icon,
    badge: null,
    approvals,
    questions,
    working,
    usageRows,
    usageAt,
  };
}

function circleHint(face: Face, hoverMode: HoverMode): string {
  switch (face) {
    case "approval":
      return "Approval pending — click to pin the card";
    case "question":
      return "Question waiting — click to pin the card";
    case "working":
      return hoverMode === "agents" ? "Click for usage" : "Click for agents";
    case "idle":
      return "Idle — hover for usage";
    case "none":
      return "No agents — hover for usage";
  }
}

function IslandMark({
  icon,
  label,
  size,
}: {
  readonly icon: string | null;
  readonly label: string;
  readonly size: number;
}): JSX.Element {
  const definition = icon ? LOGOS[icon] : undefined;
  if (!definition) {
    const letter = icon === null && label === "No agents" ? "W" : label.trim().charAt(0).toUpperCase() || "?";
    return (
      <span
        className="isl__letter"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
        aria-hidden="true"
      >
        {letter}
      </span>
    );
  }
  return (
    <span
      className="isl__mark"
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: definition.svg }}
    />
  );
}

function EdgePill({
  derived,
  edge,
  expanded,
  morphKey,
  onToggle,
}: {
  readonly derived: Derived;
  readonly edge: string;
  readonly expanded: boolean;
  readonly morphKey: string;
  readonly onToggle: (event: ReactMouseEvent) => void;
}): JSX.Element {
  const vertical = edge === "left" || edge === "right";
  const elapsed = derived.working[0] ? elapsedSince(derived.working[0].at) : null;
  // Idle faces show the top real usage remainder, or nothing at all.
  const idlePct =
    derived.face === "idle" || derived.face === "none"
      ? (derived.usageRows.find((row) => row.percentLeft !== null)?.percentLeft ?? null)
      : null;
  return (
    <button
      type="button"
      className="isl__pill"
      data-vertical={vertical}
      aria-expanded={expanded}
      aria-label={derived.label}
      onClick={onToggle}
    >
      <span className="isl__morph" key={morphKey}>
        <IslandMark icon={derived.markIcon} label={derived.label} size={18} />
      </span>
      {vertical ? (
        elapsed ? (
          <span className="isl__elapsed">{elapsed}</span>
        ) : idlePct !== null ? (
          <span className="isl__elapsed">{Math.round(idlePct)}%</span>
        ) : null
      ) : (
        <span className="isl__pilltext">{pillText(derived)}</span>
      )}
      {elapsed && !vertical ? <span className="isl__elapsed">{elapsed}</span> : null}
      {!elapsed && !vertical && idlePct !== null ? (
        <span className="isl__elapsed">{Math.round(idlePct)}%</span>
      ) : null}
      {derived.badge !== null ? <span className="isl__badge">{derived.badge}</span> : null}
    </button>
  );
}

function pillText(derived: Derived): string {
  switch (derived.face) {
    case "approval":
      return `${derived.approvals.length} approval${derived.approvals.length === 1 ? "" : "s"}`;
    case "question":
      return `${derived.questions.length} question${derived.questions.length === 1 ? "" : "s"}`;
    case "working":
      return derived.working.length === 1
        ? (derived.working[0]?.title ?? "Working")
        : `${derived.working.length} agents active`;
    case "idle":
      return "Idle";
    case "none":
      return "No agents";
  }
}

function HoverLayer({
  derived,
  hoverMode,
  bridge,
}: {
  readonly derived: Derived;
  readonly hoverMode: HoverMode;
  readonly bridge: IslandBridge;
}): JSX.Element {
  if (derived.face === "approval") {
    return <ApprovalCard entries={derived.approvals} bridge={bridge} />;
  }
  if (derived.face === "question") {
    return <QuestionCard entries={derived.questions} bridge={bridge} />;
  }
  if (derived.face === "working" && hoverMode === "agents") {
    if (derived.working.length === 1) {
      const entry = derived.working[0];
      return (
        <div className="isl__compact">
          <IslandMark icon={entry?.icon ?? null} label={entry?.title ?? ""} size={16} />
          <span className="isl__compacttitle">{entry?.title}</span>
          {entry ? <span className="isl__elapsed">{elapsedSince(entry.at)}</span> : null}
        </div>
      );
    }
    return <AgentList entries={derived.working} />;
  }
  return <UsagePanel derived={derived} />;
}

function AgentList({ entries }: { readonly entries: IslandEntry[] }): JSX.Element {
  return (
    <div className="isl__agents">
      {entries.map((entry) => (
        <div className="isl__agentrow" key={entry.key}>
          <IslandMark icon={entry.icon} label={entry.title} size={16} />
          <span className="isl__agenttext">
            <span className="isl__agentname">{entry.title}</span>
            {entry.detail ? <span className="isl__agentsub">{entry.detail}</span> : null}
          </span>
          <span className="isl__elapsed">{elapsedSince(entry.at)}</span>
        </div>
      ))}
    </div>
  );
}

function UsagePanel({ derived }: { readonly derived: Derived }): JSX.Element {
  return (
    <div className="isl__usage">
      <div className="isl__usagehead">
        <span>Usage</span>
        {derived.usageAt ? (
          <span className="isl__usagetime">updated {relativeSince(derived.usageAt)}</span>
        ) : null}
      </div>
      {derived.usageRows.length === 0 ? (
        <p className="isl__unavailable">Usage unavailable</p>
      ) : (
        derived.usageRows.map((row, index) => (
          <div className="isl__usagerow" key={`${row.providerId}-${row.window}-${index}`}>
            <div className="isl__usageline">
              <IslandMark icon={logoKeyFor(row.providerId)} label={row.name} size={14} />
              <span className="isl__usagename">{row.name}</span>
              {row.window ? <span className="isl__usagewindow">{row.window}</span> : null}
              <span className="isl__usagepct">
                {row.percentLeft === null ? "—" : `${Math.round(row.percentLeft)}% left`}
              </span>
            </div>
            {row.percentLeft === null ? null : (
              <div className="isl__usagebar">
                <i
                  data-low={row.percentLeft < 20}
                  style={{ width: `${Math.round(row.percentLeft)}%` }}
                />
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** The provider's own logo key doubles as the island mark when they match. */
function logoKeyFor(providerId: string): string | null {
  return providerId in LOGOS ? providerId : null;
}

function ApprovalCard({
  entries,
  bridge,
}: {
  readonly entries: IslandEntry[];
  readonly bridge: IslandBridge;
}): JSX.Element {
  const firstAction = entries.find((entry) => entry.action)?.action ?? null;
  return (
    <div className="isl__attn" data-tone="amber">
      <div className="isl__attnhead">
        <span>
          {entries.length} approval{entries.length === 1 ? "" : "s"}
        </span>
        {firstAction ? (
          <button
            type="button"
            className="isl__approveall"
            onClick={() => void bridge.open(firstAction.target)}
          >
            {/* Same interim as Approve below: deep-links until the permission
                backend gives this a real call. */}
            Approve all
          </button>
        ) : null}
      </div>
      <div className="isl__items">
        {entries.map((entry) => (
          <div className="isl__item" key={entry.key}>
            <div className="isl__itemhead">
              <IslandMark icon={entry.icon} label={entry.title} size={14} />
              <span className="isl__itemtitle">{entry.title}</span>
              <span className="isl__elapsed">{elapsedSince(entry.at)}</span>
            </div>
            {entry.detail ? <p className="isl__itemdetail">{entry.detail}</p> : null}
            {entry.diff ? (
              <div className="isl__diff">
                <p className="isl__diffhead">
                  {entry.diff.file} · {entry.diff.stat}
                </p>
                <pre className="isl__diffpre">
                  {entry.diff.lines.map((line, index) => (
                    <span key={index} className="isl__diffline" data-kind={line.kind}>
                      {line.text || " "}
                    </span>
                  ))}
                </pre>
              </div>
            ) : null}
            {entry.action ? (
              <div className="isl__actions">
                <button
                  type="button"
                  className="isl__btn isl__btn--quiet"
                  onClick={() => void bridge.dismiss()}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="isl__btn isl__btn--amber"
                  onClick={() => void bridge.open(entry.action!.target)}
                >
                  {/* True approve/dismiss lands with the permission backend;
                      until then this deep-links to where approval happens. */}
                  Approve
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionCard({
  entries,
  bridge,
}: {
  readonly entries: IslandEntry[];
  readonly bridge: IslandBridge;
}): JSX.Element {
  return (
    <div className="isl__attn" data-tone="blue">
      <div className="isl__attnhead">
        <span>
          {entries.length} question{entries.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="isl__items">
        {entries.map((entry) => (
          <div className="isl__item" key={entry.key}>
            <div className="isl__itemhead">
              <IslandMark icon={entry.icon} label={entry.title} size={14} />
              <span className="isl__itemtitle">{entry.title}</span>
              <span className="isl__elapsed">{askedWhen(entry.at)}</span>
            </div>
            {entry.detail ? <p className="isl__itemdetail">{entry.detail}</p> : null}
            {entry.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                className="isl__option"
                onClick={() => {
                  if (entry.action) {
                    void bridge.open(entry.action.target);
                  }
                }}
              >
                <span className="isl__optionlabel">{option.label}</span>
                {option.hint ? <span className="isl__optionhint">{option.hint}</span> : null}
                <kbd className="isl__kbd">Ctrl {index + 1}</kbd>
              </button>
            ))}
            {entry.action ? (
              <div className="isl__actions">
                <button
                  type="button"
                  className="isl__btn isl__btn--quiet"
                  onClick={() => void bridge.dismiss()}
                >
                  Answer later
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Any other entry that needs a person (errors, completed work with a target,
 * a pinned widget's current pick): title, detail and the same Open/Dismiss
 * pair, never a number it was not given.
 */
function GenericCard({
  entry,
  bridge,
}: {
  readonly entry: IslandEntry;
  readonly bridge: IslandBridge;
}): JSX.Element {
  return (
    <div className="isl__attn">
      <div className="isl__items">
        <div className="isl__item">
          <div className="isl__itemhead">
            <IslandMark icon={entry.icon} label={entry.title} size={14} />
            <span className="isl__itemtitle">{entry.title}</span>
            <span className="isl__elapsed">{elapsedSince(entry.at)}</span>
          </div>
          {entry.detail ? <p className="isl__itemdetail">{entry.detail}</p> : null}
          {entry.action ? (
            <div className="isl__actions">
              <button
                type="button"
                className="isl__btn isl__btn--quiet"
                onClick={() => void bridge.dismiss()}
              >
                Dismiss
              </button>
              <button
                type="button"
                className="isl__btn"
                onClick={() => void bridge.open(entry.action!.target)}
              >
                {entry.action.label}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ExpandedPanel({ derived }: { readonly derived: Derived }): JSX.Element {  return (
    <div className="isl__panel">
      {derived.working.length > 0 ? <AgentList entries={derived.working} /> : null}
      <UsagePanel derived={derived} />
    </div>
  );
}

/** A fresh question reads "now"; older ones show their age. */
function askedWhen(at: Date): string {
  if (Date.now() - at.getTime() < 60_000) {
    return "now";
  }
  return elapsedSince(at);
}

function elapsedSince(at: Date): string {  const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function relativeSince(at: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - at.getTime()) / 60000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes === 1) {
    return "1m ago";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1h ago" : `${hours}h ago`;
}

const container = document.getElementById("island");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Island />
    </StrictMode>,
  );
}
