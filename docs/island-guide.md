# Island Implementation Guide

> Status: build specification for the Status Island + Edge Dock.
> Audience: whoever implements this in the app (human or coding agent).
> Sources of truth: `AI_WORKBENCH.md` §95–§104, `packages/shared/src/domain/status-island.ts`,
> the verified behavior in `PROGRESS.md` (G6), and the interactive mocks in
> `docs/design-proposals/views.html` (Island tab) and `index.html` (concept A).
> Nothing here invents provider data: §56 and §103 apply to every pixel.

## 1. What the two surfaces are

| Surface | Window | Default look | Reference |
|---|---|---|---|
| Island (minimal) | Existing `StatusIslandWindow` (frameless, transparent, always-on-top) | 42px circle, provider mark, ring carries state | `views.html` → Island tab |
| Island Apple (edge dock) | Same window, new docked mode | Notch-style pill on any screen edge | `views.html` → Island Apple tab |

Both render **one model**: `IslandState` from `packages/shared/src/domain/status-island.ts`,
produced by `StatusAttentionService` (`packages/status`). The renderer stays dumb
(it renders what the service decided, per the comment atop
`apps/desktop/src/renderer/island/main.tsx`). All new behavior below is either
renderer-local presentation state or a specified extension of that model —
never provider-specific branching in generic code.

## 2. State vocabulary (shared by both surfaces)

### 2.1 Minimal circle (default, 42px, zero text)

| State | Circle | Meaning |
|---|---|---|
| working | provider mark + accent progress ring | an agent is running |
| approval | provider mark + amber ring + count badge | ≥1 approval pending |
| question | provider mark + blue ring + count badge | ≥1 agent question pending |
| idle | dimmed provider mark, hairline ring | agents exist, none running |
| no-agent | neutral app `W` mark, hairline ring | nothing running |

Rings are flat color + a soft outer halo at low alpha. No glow pulses, no
animation at rest. The badge is a count only (`1`, `2`); never text.

### 2.2 Compact pill (hover the circle)

Single-line: provider mark + title + tabular elapsed (`04:12`).
No dot — the mark carries identity (decision from the proposal review).

### 2.3 Multi-agent list (hover, ≥2 agents)

Compact rows stacked downward, one per agent: mark, name + current task,
tabular elapsed. Same rows as the compact pill, no new information per row.

### 2.4 Usage panel

Header (`Usage` + `updated Xm ago`, both honest — the timestamp is the last
real provider report) plus one row per known provider: mark, name, limit
window (`Weekly`, `5-hour`, `Daily`), tabular `% left`, 3px bar (accent;
amber under ~20%). A provider that reports nothing gets a
`Usage unavailable` row with no bar — never a fabricated value (§56).

### 2.5 Approval card

Header (`N approvals` + working `Approve all`), then one block per pending
approval: provider mark + file, detail line (`+18 −4 · waiting 00:58`),
capped pretty diff (≤5–6 lines, file header, `+`/`−` tones only, fade at the
cut), per-item `Dismiss` / `Approve`. Card scrolls internally past ~2 items
with a bottom fade; it never grows unbounded.

### 2.6 Question card

Header (`N questions`), then one block per question: asker + `now`,
16px semibold question title, muted context (`ship-auth · blocked until
answered`), full-width option rows (`Production — ship it — ⌘1`), footer
`Answer later`. Options answer on click; `⌘1`–`⌘3` answer from the keyboard.

### 2.7 Idle docked pill

 agents idle but present: dimmed mark + `Idle · N sessions` + right-aligned
`68%` (real usage remainder or nothing). No agents: app mark + `No agents`.

## 3. Interaction contract

### 3.1 Hover intent (minimal surface)

- Hovering the circle reveals the hover layer (compact / list / usage /
  approval card / question card depending on state + hover mode). No hover
  layer opens while dragging.
- Leaving starts a **240ms grace timer**; stepping onto the open layer
  cancels it. Hiding fades over ~180ms. This is what makes Approve clickable:
  the layer must keep `pointer-events` while visible, and the gap between
  circle and layer must be ≤6px.
- Starting a drag kills the hover layer immediately.

### 3.2 Click matrix

| Where | State | Click does |
|---|---|---|
| minimal circle | working | toggles hover mode agents ⇄ usage (persist the choice per session) |
| minimal circle | idle / no-agent | nothing (usage is the only hover content) |
| minimal circle | approval / question (free blob) | pins the card open at the blob |
| docked pill | any non-approval/question | expands the docked panel (§3.4), click again collapses |
| docked pill | approval / question | opens the diff / question card |
| open card | anywhere non-button | collapses back |
| Dismiss / Approve / option | — | acts, then returns to working / idle (never a dead end) |
| double-click | anywhere non-button | resets position/mode |

A drag release never counts as a click (5px movement guard — already the
pattern in the mock and the app's palette).

### 3.3 Keyboard (island focused)

Keep everything in `island/main.tsx` today (arrows cycle, Enter opens,
Escape dismisses, wheel cycles throttled 300ms, right-click steps back) and
add: `⌘1`–`⌘9` answer the visible question's options in order. Digits without
⌘ must not trigger answers (they may be typed elsewhere).

### 3.4 Docked expand

Clicking the docked pill grows it into the anchored panel with a spring
(width/height/position ~300ms `cubic-bezier(.3,1.3,.5,1)`), content rising in
with a ~40ms stagger. Scale originates at the docked edge
(top → `50% 0`, etc.). No background dimming anywhere behind the island —
that was tried in the mock and rejected.

### 3.5 Drag model

- Grip is the whole unit (circle, pill, card body). Buttons and inputs are
  never drag handles (`-webkit-app-region: no-drag` on them, as today).
- Dragging hides all hover layers; double-click resets to the stored position.
- Positions persist across restarts and clamp to the display (already true
  via `island-controller.ts` `onMoved` → `customX/customY/displayId`; keep it).

### 3.6 Focus rule (visibility)

The island is there from launch and never sits on top of the app itself:

- A focused main window hides the island; losing focus brings it back
  (`BrowserWindow` focus/blur → `IslandController.setMainFocused`, evaluated
  once at startup too).
- Explicit choices always win: `hide()` sticks through focus changes until an
  explicit `show()` or re-enable; `show()` and re-enabling show immediately and
  the focus rule governs after them; disabling hides.
- Minimizing (a blur where the main window is gone) brings the island back,
  unless `stayVisibleWhenHidden` is off — then it stays down with the window.

### 3.7 Timing constants (single source of truth)
Put these in one place (suggest `packages/shared/src/domain/status-island.ts`
or alongside it) and reference from main + renderer. Mock values that felt
right and should be the defaults:

| Constant | Default | Meaning |
|---|---|---|
| `peekGraceMs` | 240 | hover-leave grace before hiding |
| `hideFadeMs` | ~180 | fade duration (CSS) |
| `detachPx` | 78 | pull distance off the rail that detaches edge → blob |
| `snapPx` | 54 | edge proximity that shows the dock ghost |
| `cornerPx` | 40 | adjacent-edge distance that rounds corners while docked |
| `flyMs` | 270 | blob → snap-point flight before reforming |
| `edgeMarginPx` | 14 | minimum inset from display edges |
| `wheelThrottleMs` | 300 | already in `main.tsx`, keep |

## 4. Edge dock specifics

### 4.1 Geometry

- Four rails (top offset for the menu bar, 14px elsewhere), pill horizontal on
  top/bottom (236×38), vertical on left/right (46×118, mark over elapsed).
- The pill travels the full perimeter; corners round when both edges are near
  (`cornerPx`); dragging straight off any rail past `detachPx` detaches.
- Releasing a free blob within `snapPx` of an edge shows a dashed ghost slot
  in the correct orientation, flies there (`flyMs`), and reforms as a pill
  docked at that exact point. Releasing elsewhere leaves the blob.

### 4.2 Ink morph (pill ⇄ blob)

Crossfade content (~160ms) while the shell springs size/radius/position
(~300ms, same curve as §3.4) with a short blur pulse mid-morph. An accent
trailer dot lags the shell (renderer-side lerp toward the pointer, shrinking
with speed, hidden when docked and under reduced motion). No SVG goo, no
libraries — the mock proves this reads as ink.

### 4.3 Window mechanics (Electron)

This is the one place the mock cheats and the app cannot: the ghost slot and
the trailer live *outside* a pill-sized window. Implement it as follows:

- At rest the window stays pill/blob-sized (as today).
- On drag start, expand the window to a transparent full-display overlay;
  render ghost + trailer inside it; shrink back on drop or snap.
- Keep the overlay click-through everywhere except the unit itself, so the
  desktop stays usable mid-drag.
- All existing rules still hold: no single-instance-lock tricks, every check
  has a timeout, translucency only on the island surfaces, secrets never cross
  the bridge (`SECURITY.md`).

### 4.4 Reduced motion

`prefers-reduced-motion` (already respected via tokens) must also collapse
all of the above to instant state changes: no morph blur, no spring, no
trailer, no stagger, no fly (jump straight to the dock point).

## 5. Content contracts (non-negotiable)

1. **No invented numbers** (§56, §103, and the `Logo`/usage rules): usage rows
   only from `UsageService` snapshots; progress only from countable tasks
   (`completed/total`); solo sessions get named states + elapsed, never a bar.
2. **Elapsed, not live-updating lies**: `04:12` from real start timestamps,
   tabular numerals, updated on the controller's existing refresh tick — no
   per-second timers in the renderer.
3. **Diffs are capped**: ≤6 lines, file header, fade at the cut, full diff one
   deep-link away (`islandTarget` → main window, spec §98).
4. **Multiplicity is a list, never a dashboard**: N approvals → N blocks +
   `Approve all`; N questions → N blocks; hover shows the same cards as click.
5. **Approval/question badges are counts**, identical on circle, pill, and
   blob. Clearing the last item returns the unit to working/idle — states are
   derived, never stuck.

## 6. Implementation mapping

### 6.1 `packages/shared/src/domain/status-island.ts` (extend, don't break)

- `islandEntrySchema`: add optional `options: { id, label, hint? }[]` (questions),
  optional `diff: { file, stat, lines: { kind: 'add'|'del'|'ctx', text }[] }`
  (approvals; producer caps lines at 6), optional
  `actions: { id: 'approve'|'dismiss'|'answer-later', label }[]`.
  Everything optional with defaults — existing entries keep validating.
- Add `agentQuestion` to `islandWidgetIdSchema` (priority ~95, between
  `userActionRequired` 100 and `permissionRequired` 90 in `ISLAND_PRIORITY`).
- Add edge-dock preferences: `dockedEdge: top|right|bottom|left|null`
  (null = free blob), `railT: number|null`, `minimalByDefault: boolean`
  default true; keep `position/customX/customY/displayId` semantics.
- Add the §3.7 timing constants.

### 6.2 `packages/status` (producers)

- `widgets.ts`: new question builder (options from the orchestrator's
  pending question — see below); approval builder attaches `diff` +
  `actions`; usage builder attaches per-provider rows or explicit
  `unavailable` (never omit silently).
- The missing backend both cards need: permission requests and agent
  questions must *reach* the attention service. Most of this is new plumbing
  from `TeamOrchestrator`/provider adapters (permission prompt events,
  question events with option lists and answer callbacks). Define the event
  shapes first, then the widgets. Approving from the island must call the
  same path as approving in the terminal — one code path, two surfaces.
- Multiplicity falls out of `entries[]` (already sorted, already rendered —
  the renderer currently shows only `current`; see 6.4).

### 6.3 IPC (`packages/shared/src/ipc/contract.ts`, + preload + handlers)

- `statusIsland.answer { entryKey, optionId } → IslandState`
- `statusIsland.act { entryKey, actionId } → IslandState` (approve/dismiss/
  later; generic so future actions need no new channels)
- Keep `getState/setPreferences/show/hide/pinWidget/cycle/open/dismiss`
  exactly as they are.
- Renderer reports measured open-panel height so main can animate window
  bounds to content (see 6.5); name it `statusIsland.resize { height }`.

### 6.4 Renderer (`apps/desktop/src/renderer/island/`)

- Keep the dumb-view architecture: components per §2
  (`MinimalCircle`, `CompactPill`, `AgentList`, `UsagePanel`,
  `ApprovalCard`, `QuestionCard`, `EdgePill`), all from `IslandState`.
- Renderer-local UI state only: hover intent + 240ms timer, hover-mode
  toggle (`agents|usage`, working only), open/closed, nothing else.
- Reuse `Logo` (`@ai-workbench/ui`) for every provider mark; letter fallback
  exactly as the main app does. Tabular numerals everywhere time appears.
- Keyboard: extend the existing `onKeyDown` with `⌘1`–`⌘9` → `answer`.
- No dots for identity (mark + text, per the approved design); dots survive
  only as list status where the main app already uses them.

### 6.5 Main (`apps/desktop/src/main/`)

- `status-island.ts`: add docked-edge geometry (rails, clamp, display
  changes), blob size (42), card/panel sizes from measured content
  (`statusIsland.resize`), spring timing mirrored from §3.7, full-display
  transparent overlay *only* during drag (§4.3).
- `island-controller.ts`: feed new producers, keep refresh-on-event + timer,
  keep position persistence (extend to edge+rail), keep tray counts from real
  lists. Still no priority decisions here.
- Styles: extend `island.css` with the new components; flat attention cards
  (inset top edge only, no drop shadow — decided in review); masks only
  inside capped diffs, never on list bottoms.

## 7. Explicitly out of scope

- Permanent dashboards, monitoring grids, notification toasts from the island.
- Option/approval actions that bypass provider permission systems (§54).
- Badge text, estimated usage, guessed models — the "invent nothing" rule
  covers the island first.
- A second island, per-workspace islands, or island theming beyond the app
  theme.

## 8. Acceptance (add to `verify:app` / startup-check before ticking G6)

1. Circle shows all five states with correct marks, rings, badges; no text.
2. Hover reveals the right layer per state/mode; grace timer keeps Approve
   clickable; drag kills hover; double-click resets.
3. Click matrix (§3.2) passes through the real preload bridge, both surfaces.
4. Approval card lists 2 pending approvals with capped diffs; Approve all
   empties the queue and returns the unit to working.
5. Question card answers via click and via `⌘1`–`⌘3`.
6. Edge: full perimeter travel, detach past the rail, snap ghost on the exact
   edge, reform, vertical pill on sides, dblclick reset, clamping on a
   resolution change.
7. Restart persistence: edge+rail, hover mode, expanded-nothing (panels never
   persist open).
8. Reduced-motion run: everything instant, nothing stuck half-morphed.
