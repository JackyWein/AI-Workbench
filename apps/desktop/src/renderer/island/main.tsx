import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ISLAND_TIMING,
  type IslandAgentRow,
  type IslandDrag,
  type IslandEdge,
  type IslandEntry,
  type IslandSessionSummary,
  type IslandState,
  type IslandTarget,
  type IslandUsageRow,
} from "@ai-workbench/shared";
import { LOGOS, resolveTheme } from "@ai-workbench/ui";
import "./island.css";

type HoverMode = "agents" | "usage";
type Face = "approval" | "question" | "working" | "idle" | "none";
/** How the unit just arrived in its shape, for its entrance motion. */
type Arrival = "dock" | "free" | null;

/** Pointer travel that turns a press into a drag; below it, it is a click. */
const DRAG_START_PX = 4;
const RESTING_DRAG: IslandDrag = { active: false, edge: null, snap: null };

interface AskResult {
  readonly sent: boolean;
  readonly to: string | null;
  readonly reason: string | null;
}

/** Structural bridge type so cards stay testable without the preload. */
interface IslandBridge {
  onState(listener: (state: IslandState) => void): () => void;
  open(target: IslandTarget): Promise<void>;
  dismiss(): Promise<void>;
  ask(key: string, text: string): Promise<AskResult>;
  cycle(direction: 1 | -1): Promise<void>;
  resetPosition(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  onDrag(listener: (drag: IslandDrag) => void): () => void;
  dragStart(grabX: number, grabY: number): Promise<void>;
  dragEnd(): Promise<void>;
}

/** True when an event started on something that handles its own clicks. */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, input, textarea") !== null;
}

/**
 * The grip is the whole unit: the pill, the circle and any card background.
 * Inner controls (rows, buttons, the prompt line) keep their clicks.
 */
function isGrip(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(".isl__pill, .isl__circle") !== null || !onControl(target);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A clock that ticks once a second, so elapsed times move on their own. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The Status Island's own renderer (spec §95–§97, island-guide §§2–4).
 *
 * It renders what the attention service decided and nothing more: no priority
 * logic here, and no number it was not given. Docked, the unit is a pill that
 * opens in place into its card; free, it is a circle whose card opens beside
 * it on hover. All state below is presentation-local.
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
  // The open sheet folding back into its pill; it stays mounted until then.
  const [closing, setClosing] = useState(false);
  // Live drag from main: which rail the pill rides, where a blob would dock.
  const [drag, setDrag] = useState<IslandDrag>(RESTING_DRAG);
  // Where a finished drag left the unit, until the stored preference agrees.
  const [settled, setSettled] = useState<{ edge: IslandEdge | null } | null>(null);
  const [arrival, setArrival] = useState<Arrival>(null);
  const now = useNow();
  const press = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const dragging = useRef(false);
  const swallowClick = useRef(false);
  const pillSize = useRef({ width: 240, height: 38 });
  const lastDocked = useRef<IslandEdge | null | undefined>(undefined);
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
    if (!bridge) {
      return undefined;
    }
    return bridge.onDrag((next) => {
      setDrag(next);
      if (!next.active) {
        setSettled({ edge: next.edge });
      }
    });
  }, [bridge]);

  // The drop's outcome holds until the stored preference catches up, so the
  // unit never flickers back to its old shape in between.
  const storedEdge = state?.preferences.dockedEdge ?? null;
  useEffect(() => {
    if (!settled) {
      return undefined;
    }
    if (settled.edge === storedEdge) {
      setSettled(null);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(null), 2000);
    return () => window.clearTimeout(timer);
  }, [settled, storedEdge]);

  const docked: IslandEdge | null = drag.active
    ? drag.edge
    : settled
      ? settled.edge
      : storedEdge;

  // A change of shape plays its entrance once: a blob landing on a rail grows
  // into a pill, a pill pulled free pops into a blob. Laid out before paint so
  // no frame shows the new shape unanimated.
  useLayoutEffect(() => {
    const previous = lastDocked.current;
    lastDocked.current = docked;
    if (previous === undefined || previous === docked) {
      return undefined;
    }
    setArrival(docked ? "dock" : "free");
    const timer = window.setTimeout(() => setArrival(null), 520);
    return () => window.clearTimeout(timer);
  }, [docked]);

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
  // A new picture collapses nothing the user opened: the open card and hover
  // mode survive refreshes. Only a face change settles local state back.
  const derived = useMemo(() => (state ? deriveFace(state) : null), [state]);
  const faceKey = derived
    ? `${derived.face}:${derived.approvals.length}:${derived.questions.length}:${derived.agents.length}`
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
    setClosing(false);
  }, [derived, faceKey]);

  // The window fits the unit: report what the content measures so main can
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
  }, [bridge, state, hovering, pinned, expanded, closing, hoverMode, docked]);

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

  const attentionFace = derived.face === "approval" || derived.face === "question";
  // News the service holds the island for (an error, a finished run) opens
  // its card on its own when the user allowed that.
  const serviceCard = state.expanded && state.current.action !== null && !attentionFace;

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
    if (dragging.current || drag.active) {
      return;
    }
    clearHoverTimers();
    setHiding(false);
    setHovering(true);
  };
  const endHover = (): void => {
    clearHoverTimers();
    // Grace to reach the card, then a short fade instead of a hard cut.
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
  // Grabbing the unit starts an OS drag; no card may follow it.
  const killHover = (): void => {
    clearHoverTimers();
    setHiding(false);
    setHovering(false);
  };
  const collapse = (): void => {
    setPinned(false);
    setExpanded(false);
    setClosing(false);
  };
  // A docked sheet folds back into its pill before it goes; everything else
  // simply closes.
  const fold = (): void => {
    if (docked && (pinned || expanded) && !prefersReducedMotion()) {
      setClosing(true);
      return;
    }
    collapse();
  };
  const onSheetAnimationEnd = (event: ReactAnimationEvent): void => {
    if (event.target === event.currentTarget && event.animationName.startsWith("isl-close")) {
      collapse();
    }
  };
  const onCardClick = (event: ReactMouseEvent): void => {
    // An open card folds on plain background clicks, never on its controls.
    if (onControl(event.target)) {
      return;
    }
    fold();
  };

  // Drag: a press on the grip that travels past a few pixels hands the unit to
  // main, which moves the window with the pointer. Below that it stays a click.
  const onPointerDown = (event: ReactPointerEvent): void => {
    if (event.button !== 0 || !isGrip(event.target)) {
      return;
    }
    press.current = {
      sx: event.screenX,
      sy: event.screenY,
      cx: event.clientX,
      cy: event.clientY,
    };
  };
  const onPointerMove = (event: ReactPointerEvent): void => {
    const from = press.current;
    if (!from || dragging.current) {
      return;
    }
    if (Math.hypot(event.screenX - from.sx, event.screenY - from.sy) < DRAG_START_PX) {
      return;
    }
    dragging.current = true;
    // Captured only now, so a plain click still reaches its button.
    event.currentTarget.setPointerCapture(event.pointerId);
    killHover();
    collapse();
    void bridge.dragStart(from.cx, from.cy).catch(() => undefined);
  };
  const endPress = (): void => {
    press.current = null;
    if (!dragging.current) {
      return;
    }
    dragging.current = false;
    // The release of a drag is never a click on whatever sits under it.
    swallowClick.current = true;
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    void bridge.dragEnd().catch(() => undefined);
  };
  const resetAll = (): void => {
    setHoverMode("agents");
    collapse();
    setHovering(false);
    void bridge.resetPosition().catch(() => undefined);
  };
  const toggleMode = (): void => {
    setHoverMode((mode) => {
      const next = mode === "agents" ? "usage" : "agents";
      try {
        window.localStorage.setItem("ai-workbench.island-hover", next);
      } catch {
        // A choice that cannot be remembered is not worth an error.
      }
      return next;
    });
  };

  const onCircleClick = (): void => {
    if (derived.face === "working") {
      toggleMode();
      return;
    }
    if (attentionFace) {
      setPinned((value) => !value);
    }
  };

  const onPillClick = (event: ReactMouseEvent): void => {
    // The sheet unfolds out of the pill's own outline.
    const rect = event.currentTarget.getBoundingClientRect();
    pillSize.current = { width: Math.round(rect.width), height: Math.round(rect.height) };
    if (attentionFace) {
      setPinned((value) => !value);
    } else {
      setExpanded((value) => !value);
    }
  };

  // Ink morph anchor: remounts face content on change so the crossfade + blur
  // pulse plays without touching root state (hover, timers, focus).
  const morphKey = `${derived.face}:${docked ?? "free"}`;

  const faceCard = (): JSX.Element => {
    if (serviceCard) {
      return <GenericCard entry={state.current} bridge={bridge} now={now} />;
    }
    switch (derived.face) {
      case "approval":
        return <ApprovalCard entries={derived.approvals} bridge={bridge} now={now} />;
      case "question":
        return <QuestionCard entries={derived.questions} bridge={bridge} now={now} />;
      case "working":
        return <WorkingSheet derived={derived} bridge={bridge} now={now} />;
      case "idle":
        return <IdleSheet derived={derived} sessions={state.sessions} now={now} />;
      case "none":
        return <NoneSheet derived={derived} sessions={state.sessions} now={now} />;
    }
  };

  const open = docked ? pinned || expanded || serviceCard || closing : false;
  const snapping = drag.active && !docked ? drag.snap : null;
  const circle = (
    <button
      type="button"
      className="isl__circle"
      onClick={onCircleClick}
      aria-label={derived.label}
      title={circleHint(derived.face, hoverMode)}
    >
      <span className="isl__blobin">
        <span className="isl__morph" key={morphKey}>
          <FaceMark derived={derived} size={17} />
        </span>
      </span>
      {derived.badge !== null ? <span className="isl__badge">{derived.badge}</span> : null}
    </button>
  );
  // The sheet starts as the pill's outline and grows from its edge.
  const sheetRef = (node: HTMLDivElement | null): void => {
    node?.style.setProperty("--pw", `${pillSize.current.width}px`);
    node?.style.setProperty("--ph", `${pillSize.current.height}px`);
  };

  // The free circle's side card: pinned attention, held news, or hover.
  const blobCard = ((): JSX.Element | null => {
    if (docked) {
      return null;
    }
    if (serviceCard) {
      return <GenericCard entry={state.current} bridge={bridge} now={now} />;
    }
    if (pinned && attentionFace) {
      return faceCard();
    }
    if (!hovering) {
      return null;
    }
    switch (derived.face) {
      case "approval": {
        const first = derived.approvals[0];
        return first ? <ApprovalPeek entry={first} bridge={bridge} now={now} /> : null;
      }
      case "question": {
        const first = derived.questions[0];
        return first ? <QuestionCard entries={[first]} bridge={bridge} now={now} /> : null;
      }
      case "working":
        return hoverMode === "agents" ? (
          <AgentsCard agents={derived.agents} bridge={bridge} now={now} />
        ) : (
          <UsageCard derived={derived} now={now} />
        );
      default:
        return <UsageCard derived={derived} now={now} />;
    }
  })();

  return (
    // A blob drawn onto a rail hangs from that rail like the pill it becomes.
    <div className="isl-stage" data-edge={docked ?? snapping ?? "free"}>
      <div
        ref={rootRef}
        className="isl"
        data-face={derived.face}
        data-docked={docked ?? "free"}
        data-open={open}
        data-dragging={drag.active}
        data-snap={drag.active && drag.snap ? drag.snap : undefined}
        data-arrival={arrival ?? undefined}
        onMouseEnter={docked ? undefined : startHover}
        onMouseLeave={docked ? undefined : endHover}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onLostPointerCapture={endPress}
        onClickCapture={(event) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onDoubleClick={(event) => {
          if (onControl(event.target)) {
            return;
          }
          resetAll();
        }}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) {
            return;
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            void bridge.cycle(1);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            void bridge.cycle(-1);
          } else if (event.key === "Enter") {
            if (onControl(event.target)) {
              return;
            }
            event.preventDefault();
            const target =
              derived.approvals[0]?.action?.target ??
              derived.questions[0]?.action?.target ??
              derived.agents[0]?.target ??
              null;
            if (target) {
              void bridge.open(target);
            }
          } else if (event.key === "Escape") {
            fold();
            void bridge.dismiss();
          } else if (event.ctrlKey && /^[1-9]$/.test(event.key)) {
            // Answering a visible question from the keyboard. Until the
            // question backend lands, an option deep-links to its context.
            const question = derived.questions[0];
            const option = question?.options[Number(event.key) - 1];
            const target = question?.action?.target;
            if (option && target) {
              event.preventDefault();
              void bridge.open(target);
            }
          }
        }}
        onWheel={(event) => {
          const stamp = Date.now();
          if (stamp - wheelAt.current < ISLAND_TIMING.wheelThrottleMs) {
            return;
          }
          wheelAt.current = stamp;
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
          open ? (
            <div
              className="isl__sheet"
              key={morphKey}
              ref={sheetRef}
              data-edge={docked}
              data-closing={closing}
              onClick={onCardClick}
              onAnimationEnd={onSheetAnimationEnd}
            >
              {faceCard()}
            </div>
          ) : (
            <Pill derived={derived} edge={docked} now={now} morphKey={morphKey} onClick={onPillClick} />
          )
        ) : (
          <>
            {snapping ? (
              // Drawn onto a rail: the outline of the pill it will become.
              <span
                className="isl__ghost"
                data-vertical={snapping === "left" || snapping === "right"}
              >
                {circle}
              </span>
            ) : (
              circle
            )}
            {blobCard ? (
              <div
                className="isl__side"
                data-hiding={hiding && !pinned && !serviceCard}
                onClick={onCardClick}
                onMouseEnter={startHover}
                onMouseLeave={endHover}
              >
                {blobCard}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

interface Derived {
  readonly face: Face;
  /** What the unit says about itself, for its accessible name. */
  readonly label: string;
  /** What the unit is about: an entry's own title, else the face. */
  readonly unitTitle: string;
  readonly markIcon: string | null;
  /**
   * Whose initial stands in the circle when there is no mark to draw: the
   * agent or tool the face is about. Never the label, which may lead with a
   * count ("1 approval pending") that the badge already shows.
   */
  readonly markName: string;
  readonly badge: number | null;
  readonly approvals: IslandEntry[];
  readonly questions: IslandEntry[];
  /** Every agent at work, one row apiece: sessions, terminals and teams. */
  readonly agents: IslandAgentRow[];
  readonly usageRows: IslandUsageRow[];
  readonly usageAt: Date | null;
  readonly recent: number;
}

function deriveFace(state: IslandState): Derived {
  const approvals = state.entries.filter((entry) => entry.widget === "needsAttention");
  const questions = state.entries.filter((entry) => entry.widget === "agentQuestion");
  const teams = state.entries.filter((entry) => entry.widget === "teamProgress");
  const active = state.entries.filter((entry) => entry.widget === "activeAgents");
  // Tools first, teams after: the lead is the agent a person watches.
  const agents = [...active, ...teams].flatMap((entry) => entry.agents);
  // An entry that came without rows still gets one, so nothing at work is
  // left off the list.
  const rows =
    agents.length > 0
      ? agents
      : [...active, ...teams].map(
          (entry): IslandAgentRow => ({
            key: entry.key,
            title: entry.title,
            detail: entry.detail,
            icon: entry.icon,
            startedAt: null,
            target: entry.action?.target ?? null,
          }),
        );
  const usageEntries = state.entries.filter((entry) => entry.usage.length > 0);
  const usageRows = usageEntries.flatMap((entry) => entry.usage);
  const usageAt = usageEntries.reduce<Date | null>(
    (latest, entry) => (!latest || entry.at > latest ? entry.at : latest),
    null,
  );
  const base = {
    approvals,
    questions,
    agents: rows,
    usageRows,
    usageAt,
    recent: state.sessions.recent,
  };

  if (approvals.length > 0) {
    const first = approvals[0];
    return {
      ...base,
      face: "approval",
      label: `${approvals.length} approval${approvals.length === 1 ? "" : "s"} pending`,
      unitTitle:
        approvals.length === 1
          ? (first?.title ?? "Approval pending")
          : `${approvals.length} approvals pending`,
      markIcon: first?.icon ?? rows[0]?.icon ?? null,
      markName: first?.title ?? rows[0]?.title ?? "",
      badge: approvals.length,
    };
  }
  if (questions.length > 0) {
    const first = questions[0];
    return {
      ...base,
      face: "question",
      label: `${questions.length} question${questions.length === 1 ? "" : "s"} waiting`,
      unitTitle:
        questions.length === 1
          ? (first?.title ?? "Question waiting")
          : `${questions.length} questions waiting`,
      markIcon: first?.icon ?? null,
      markName: first?.title ?? "",
      badge: questions.length,
    };
  }
  if (rows.length > 0) {
    const first = rows[0];
    return {
      ...base,
      face: "working",
      label: rows.length === 1 ? (first?.title ?? "Working") : `${rows.length} agents active`,
      unitTitle: active[0]?.title ?? teams[0]?.title ?? "Working",
      markIcon: first?.icon ?? null,
      markName: first?.title ?? "",
      badge: null,
    };
  }
  if (state.sessions.recent === 0) {
    return {
      ...base,
      face: "none",
      label: "No agents",
      unitTitle: "No agents",
      markIcon: null,
      markName: "",
      badge: null,
    };
  }
  return {
    ...base,
    face: "idle",
    label: `Idle · ${plural(state.sessions.recent, "session")}`,
    unitTitle: state.current.title,
    markIcon: state.sessions.last?.icon ?? null,
    markName: state.sessions.last?.name ?? "",
    badge: null,
  };
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

function circleHint(face: Face, hoverMode: HoverMode): string {
  switch (face) {
    case "approval":
      return "Approval pending — click to keep the card open";
    case "question":
      return "Question waiting — click to keep the card open";
    case "working":
      return hoverMode === "agents" ? "Click for usage" : "Click for agents";
    case "idle":
      return "Idle — hover for usage";
    case "none":
      return "No agents — hover for usage";
  }
}

/** The unit's own mark: the app's "W" when nothing runs, else the tool's. */
function FaceMark({ derived, size }: { readonly derived: Derived; readonly size: number }): JSX.Element {
  // With neither a mark nor a name there is nothing honest to put in the
  // circle but the application's own mark.
  const nameless = !derived.markIcon && derived.markName.trim() === "";
  if (derived.face === "none" || (derived.face === "idle" && !derived.markIcon) || nameless) {
    return (
      <span className="isl__app" style={{ fontSize: Math.round(size * 0.75) }} aria-hidden="true">
        W
      </span>
    );
  }
  return <Mark icon={derived.markIcon} label={derived.markName} size={size} />;
}

function Mark({
  icon,
  label,
  size,
  team = false,
}: {
  readonly icon: string | null;
  readonly label: string;
  readonly size: number;
  /** Teams get a lettered tile rather than any one tool's mark. */
  readonly team?: boolean;
}): JSX.Element {
  const definition = icon ? LOGOS[icon] : undefined;
  if (!definition) {
    return (
      <span
        className="isl__letter"
        data-team={team}
        style={{ width: size, height: size, fontSize: Math.round(size * (team ? 0.42 : 0.6)) }}
        aria-hidden="true"
      >
        {team ? "TM" : label.trim().charAt(0).toUpperCase() || "?"}
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

function rowMark(row: IslandAgentRow, size: number): JSX.Element {
  return <Mark icon={row.icon} label={row.title} size={size} team={row.key.startsWith("run:")} />;
}

/** The docked unit at rest: one line, the face's clock or number, a badge. */
function Pill({
  derived,
  edge,
  now,
  morphKey,
  onClick,
}: {
  readonly derived: Derived;
  readonly edge: string;
  readonly now: number;
  readonly morphKey: string;
  readonly onClick: (event: ReactMouseEvent) => void;
}): JSX.Element {
  const vertical = edge === "left" || edge === "right";
  const lead = derived.agents[0];
  const firstQuestion = derived.questions[0];
  // The idle pill's number is the tightest remainder across all tools.
  const topLeft = derived.usageRows.reduce<number | null>(
    (lowest, row) =>
      row.percentLeft !== null && (lowest === null || row.percentLeft < lowest)
        ? row.percentLeft
        : lowest,
    null,
  );

  const text = ((): string => {
    switch (derived.face) {
      case "working":
      case "approval":
        if (derived.face === "approval" && !lead) {
          return derived.approvals[0]?.title ?? "Approval pending";
        }
        return lead ? [lead.title, lead.detail].filter(Boolean).join(" · ") : "Working";
      case "question":
        return `${askerName(firstQuestion)} asks`;
      case "idle":
        return `Idle · ${plural(derived.recent, "session")}`;
      case "none":
        return "No agents";
    }
  })();

  const meta = ((): { text: string; tone?: "accent" } | null => {
    switch (derived.face) {
      case "working":
      case "approval": {
        const since = lead?.startedAt ?? longestRunning(derived.agents);
        if (since) {
          return { text: clock(since, now) };
        }
        const waiting = derived.approvals[0]?.at;
        return derived.face === "approval" && waiting ? { text: clock(waiting, now) } : null;
      }
      case "question":
        return { text: `${derived.questions.length} new`, tone: "accent" };
      case "idle":
      case "none":
        return topLeft === null ? null : { text: `${Math.round(topLeft)}%` };
    }
  })();

  return (
    <button
      type="button"
      className="isl__pill"
      data-vertical={vertical}
      aria-expanded={false}
      aria-label={derived.label}
      onClick={onClick}
    >
      <span className="isl__morph" key={morphKey}>
        <FaceMark derived={derived} size={17} />
      </span>
      {vertical ? null : <span className="isl__pilltext">{text}</span>}
      {!vertical && (derived.face === "working" || derived.face === "approval") && derived.agents.length > 1 ? (
        <span className="isl__pillmore" title={`${derived.agents.length} agents at work`}>
          +{derived.agents.length - 1}
        </span>
      ) : null}
      {meta ? (
        <span className="isl__pillmeta" data-tone={meta.tone}>
          {meta.text}
        </span>
      ) : null}
      {derived.badge !== null ? <span className="isl__count">{derived.badge}</span> : null}
    </button>
  );
}

/** Docked, open, working: every agent, a prompt line, then usage. */
function WorkingSheet({
  derived,
  bridge,
  now,
}: {
  readonly derived: Derived;
  readonly bridge: IslandBridge;
  readonly now: number;
}): JSX.Element {
  const since = derived.agents[0]?.startedAt ?? longestRunning(derived.agents);
  return (
    <div className="isl__x">
      <div className="isl__xh">
        <span className="isl__live">LIVE</span>
        <span>{plural(derived.agents.length, "agent")}</span>
        {since ? <span className="isl__el">{clock(since, now)}</span> : null}
      </div>
      {derived.agents.map((row) => (
        <AgentRow key={row.key} row={row} bridge={bridge} now={now} className="isl__xrow" />
      ))}
      <AskBox agents={derived.agents} bridge={bridge} />
      <div className="isl__xuse">
        <p className="isl__xl">Usage</p>
        <UsageRows rows={derived.usageRows} />
      </div>
    </div>
  );
}

/** Docked, open, resting: how many sessions rest, the longest, and usage. */
function IdleSheet({
  derived,
  sessions,
  now,
}: {
  readonly derived: Derived;
  readonly sessions: IslandSessionSummary;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="isl__x">
      <div className="isl__xh">
        <span>Idle</span>
        <span className="isl__el">{plural(sessions.recent, "session")}</span>
      </div>
      {sessions.longestIdle ? (
        <div className="isl__xstat">
          <span>Longest idle</span>
          <span className="isl__xstatvalue">
            {sessions.longestIdle.name} · {span(sessions.longestIdle.at, now)}
          </span>
        </div>
      ) : null}
      <UsageRows rows={derived.usageRows} />
    </div>
  );
}

/** Docked, open, nothing at all: the last session and usage. */
function NoneSheet({
  derived,
  sessions,
  now,
}: {
  readonly derived: Derived;
  readonly sessions: IslandSessionSummary;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="isl__x">
      <div className="isl__xh">
        <span>Nothing running</span>
      </div>
      {sessions.last ? (
        <div className="isl__xstat">
          <span>Last session</span>
          <span className="isl__xstatvalue">
            {sessions.last.name} · {span(sessions.last.at, now)} ago
          </span>
        </div>
      ) : null}
      <UsageRows rows={derived.usageRows} />
    </div>
  );
}

function AgentRow({
  row,
  bridge,
  now,
  className,
}: {
  readonly row: IslandAgentRow;
  readonly bridge: IslandBridge;
  readonly now: number;
  readonly className: string;
}): JSX.Element {
  const target = row.target;
  return (
    <button
      type="button"
      className={className}
      title={target ? `Open ${row.title}` : row.title}
      onClick={() => {
        if (target) {
          void bridge.open(target);
        }
      }}
    >
      {rowMark(row, 16)}
      <span className="isl__rowtext">
        <span className="isl__rowname">{row.title}</span>
        {row.detail ? <span className="isl__rowsub">{row.detail}</span> : null}
      </span>
      {row.startedAt ? <span className="isl__el">{clock(row.startedAt, now)}</span> : null}
    </button>
  );
}

/**
 * A prompt for the agents at work. It types into the first running agent
 * terminal; a chat that is mid-answer cannot take one, and the line says so.
 */
function AskBox({
  agents,
  bridge,
}: {
  readonly agents: readonly IslandAgentRow[];
  readonly bridge: IslandBridge;
}): JSX.Element {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const lead = agents.find((row) => row.key.startsWith("tile:")) ?? agents[0];

  const send = async (): Promise<void> => {
    const prompt = text.trim();
    if (!prompt || sending) {
      return;
    }
    setSending(true);
    try {
      const result = await bridge.ask(lead?.key ?? "none", prompt);
      if (result.sent) {
        setText("");
        setNote(result.to ? `Sent to ${result.to}` : "Sent");
      } else {
        setNote(result.reason ?? "Could not send");
      }
    } catch {
      setNote("Could not send");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="isl__askwrap">
      <label className="isl__ask">
        <input
          className="isl__askinput"
          value={text}
          placeholder="Ask anything…"
          aria-label={lead ? `Ask ${lead.title}` : "Ask anything"}
          disabled={sending}
          onChange={(event) => {
            setText(event.target.value);
            setNote(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              setText("");
            }
          }}
        />
        <kbd className="isl__kbd">↵</kbd>
      </label>
      {note ? <p className="isl__asknote">{note}</p> : null}
    </div>
  );
}

/**
 * One row per tool: its tightest window, the one that runs out first. The
 * other windows stay in the Usage view; the island shows what matters now.
 */
function tightestPerProvider(rows: readonly IslandUsageRow[]): IslandUsageRow[] {
  const byProvider = new Map<string, IslandUsageRow>();
  for (const row of rows) {
    const known = byProvider.get(row.providerId);
    if (
      !known ||
      (row.percentLeft !== null &&
        (known.percentLeft === null || row.percentLeft < known.percentLeft))
    ) {
      byProvider.set(row.providerId, row);
    }
  }
  return [...byProvider.values()];
}

/** "5-hour window" reads "5-hour" in the island's short rows. */
function shortWindow(label: string): string {
  return label.replace(/\s+window$/i, "");
}

function UsageRows({ rows: all }: { readonly rows: readonly IslandUsageRow[] }): JSX.Element {
  const rows = tightestPerProvider(all);
  if (rows.length === 0) {
    return <p className="isl__na isl__urow">Usage unavailable</p>;
  }
  return (
    <>
      {rows.map((row, index) => (
        <div className="isl__urow" key={`${row.providerId}-${row.window}-${index}`}>
          <div className="isl__uline">
            <Mark icon={row.icon ?? logoKeyFor(row.providerId)} label={row.name} size={14} />
            <span className="isl__uname">{row.name}</span>
            {row.percentLeft === null ? (
              <span className="isl__na">{row.note || "Usage unavailable"}</span>
            ) : (
              <>
                {row.window ? <span className="isl__uwindow">{shortWindow(row.window)}</span> : null}
                <span className="isl__upct">{Math.round(row.percentLeft)}% left</span>
              </>
            )}
          </div>
          {row.percentLeft === null ? null : (
            <div className="isl__ubar">
              <i
                data-low={row.percentLeft < 20}
                style={{ width: `${Math.round(row.percentLeft)}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** The free circle's agents card: name, what it reported, its clock. */
function AgentsCard({
  agents,
  bridge,
  now,
}: {
  readonly agents: readonly IslandAgentRow[];
  readonly bridge: IslandBridge;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="isl__card isl__card--list">
      {agents.map((row) => (
        <AgentRow key={row.key} row={row} bridge={bridge} now={now} className="isl__arow" />
      ))}
    </div>
  );
}

function UsageCard({ derived, now }: { readonly derived: Derived; readonly now: number }): JSX.Element {
  return (
    <div className="isl__card">
      <div className="isl__uh">
        <span className="isl__uhtitle">Usage</span>
        {derived.usageAt ? (
          <span className="isl__uhtime">updated {relative(derived.usageAt, now)}</span>
        ) : null}
      </div>
      <UsageRows rows={derived.usageRows} />
    </div>
  );
}

/** The provider's own logo key doubles as the island mark when they match. */
function logoKeyFor(providerId: string): string | null {
  return providerId in LOGOS ? providerId : null;
}

/** Who asks, by the mark the question carries; "Agent" when it has none. */
function askerName(entry: IslandEntry | undefined): string {
  const icon = entry?.icon;
  return (icon ? LOGOS[icon]?.title : undefined) ?? "Agent";
}

function ApprovalActions({
  entry,
  bridge,
}: {
  readonly entry: IslandEntry;
  readonly bridge: IslandBridge;
}): JSX.Element | null {
  const target = entry.action?.target;
  if (!target) {
    return null;
  }
  return (
    <div className="isl__actions">
      <button type="button" className="isl__btn isl__btn--quiet" onClick={() => void bridge.dismiss()}>
        Dismiss
      </button>
      <button
        type="button"
        className="isl__btn isl__btn--amber"
        onClick={() => void bridge.open(target)}
      >
        {/* True approve/dismiss lands with the permission backend; until
            then this deep-links to where approval happens. */}
        Approve
      </button>
    </div>
  );
}

function approvalDetail(entry: IslandEntry, now: number): string {
  return [entry.detail, `waiting ${clock(entry.at, now)}`].filter(Boolean).join(" · ");
}

/** Hovering an approval circle: who needs what, and the two answers. */
function ApprovalPeek({
  entry,
  bridge,
  now,
}: {
  readonly entry: IslandEntry;
  readonly bridge: IslandBridge;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="isl__card isl__card--wide">
      <div className="isl__at">
        <Mark icon={entry.icon} label={entry.title} size={15} />
        <span className="isl__attitle">{entry.title}</span>
      </div>
      <p className="isl__ad">{approvalDetail(entry, now)}</p>
      <ApprovalActions entry={entry} bridge={bridge} />
    </div>
  );
}

function ApprovalCard({
  entries,
  bridge,
  now,
}: {
  readonly entries: IslandEntry[];
  readonly bridge: IslandBridge;
  readonly now: number;
}): JSX.Element {
  const firstTarget = entries.find((entry) => entry.action)?.action?.target ?? null;
  return (
    <div className="isl__attn" data-tone="amber">
      <div className="isl__ahead">
        <span>
          {entries.length} approval{entries.length === 1 ? "" : "s"}
        </span>
        {firstTarget && entries.length > 1 ? (
          <button
            type="button"
            className="isl__approveall"
            onClick={() => void bridge.open(firstTarget)}
          >
            {/* Same interim as Approve below: deep-links until the permission
                backend gives this a real call. */}
            Approve all
          </button>
        ) : null}
      </div>
      <div className="isl__items">
        {entries.map((entry, index) => (
          <div className="isl__item" key={entry.key}>
            <div className="isl__at">
              <Mark icon={entry.icon} label={entry.title} size={15} />
              <span className="isl__attitle">{entry.title}</span>
              {index > 0 ? <span className="isl__el">{clock(entry.at, now)}</span> : null}
            </div>
            <p className="isl__ad">{approvalDetail(entry, now)}</p>
            {entry.diff ? (
              <div className="isl__diff">
                <p className="isl__diffhead">
                  {entry.diff.file} · {entry.diff.stat}
                </p>
                {entry.diff.lines.map((line, lineIndex) => (
                  <span key={lineIndex} className="isl__diffline" data-kind={line.kind}>
                    {line.text || " "}
                  </span>
                ))}
              </div>
            ) : null}
            <ApprovalActions entry={entry} bridge={bridge} />
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionCard({
  entries,
  bridge,
  now,
}: {
  readonly entries: IslandEntry[];
  readonly bridge: IslandBridge;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="isl__attn" data-tone="blue">
      {entries.length > 1 ? (
        <div className="isl__ahead">
          <span>{entries.length} questions</span>
        </div>
      ) : null}
      <div className="isl__items">
        {entries.map((entry) => {
          const target = entry.action?.target;
          return (
            <div className="isl__item" key={entry.key}>
              <div className="isl__qh">
                <Mark icon={entry.icon} label={entry.title} size={14} />
                <span>{askerName(entry)} asks</span>
                <span className="isl__el">{askedWhen(entry.at, now)}</span>
              </div>
              <p className="isl__qtitle">{entry.title}</p>
              {entry.detail ? <p className="isl__qsub">{entry.detail}</p> : null}
              {entry.options.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  className="isl__option"
                  onClick={() => {
                    if (target) {
                      void bridge.open(target);
                    }
                  }}
                >
                  <span className="isl__optionlabel">{option.label}</span>
                  {option.hint ? <span className="isl__optionhint">{option.hint}</span> : null}
                  <kbd className="isl__kbd">Ctrl {index + 1}</kbd>
                </button>
              ))}
              {target && entry.options.length === 0 ? (
                <div className="isl__actions">
                  <button
                    type="button"
                    className="isl__btn isl__btn--quiet"
                    onClick={() => void bridge.dismiss()}
                  >
                    Answer later
                  </button>
                  <button type="button" className="isl__btn" onClick={() => void bridge.open(target)}>
                    Answer
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
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
  now,
}: {
  readonly entry: IslandEntry;
  readonly bridge: IslandBridge;
  readonly now: number;
}): JSX.Element {
  const action = entry.action;
  return (
    <div className="isl__card">
      <div className="isl__at">
        <Mark icon={entry.icon} label={entry.title} size={15} />
        <span className="isl__attitle">{entry.title}</span>
        <span className="isl__el">{clock(entry.at, now)}</span>
      </div>
      {entry.detail ? <p className="isl__ad">{entry.detail}</p> : null}
      {action ? (
        <div className="isl__actions">
          <button
            type="button"
            className="isl__btn isl__btn--quiet"
            onClick={() => void bridge.dismiss()}
          >
            Dismiss
          </button>
          <button type="button" className="isl__btn" onClick={() => void bridge.open(action.target)}>
            {action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The start of the longest-running agent, or null when none has a clock. */
function longestRunning(agents: readonly IslandAgentRow[]): Date | null {
  return agents.reduce<Date | null>(
    (earliest, row) =>
      row.startedAt && (!earliest || row.startedAt < earliest) ? row.startedAt : earliest,
    null,
  );
}

/** A fresh question reads "now"; older ones show their age. */
function askedWhen(at: Date, now: number): string {
  return now - at.getTime() < 60_000 ? "now" : clock(at, now);
}

/** Elapsed time as a clock: 04:12, or 1:04:12 past the hour. */
function clock(at: Date, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A resting span in words: 42m, 3h, 2d. */
function span(at: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at.getTime()) / 60_000));
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function relative(at: Date, now: number): string {
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const container = document.getElementById("island");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Island />
    </StrictMode>,
  );
}
