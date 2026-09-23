# Design Proposals — AI Workbench

> Status: A/P/W/C/I/E approved 2026-09-22 and **implemented on
> `design/approved-rollout`** (typecheck + build + status/shared tests green;
> full `verify` not yet run — lint is broken env-wide by a bun/uri-js packaging
> issue, and `verify:app` needs Linux/macOS display). Parked views (Teams,
> Agents, Skills, Plugins, MCP, Settings) untouched.
> Deferred with reason (see HANDOFF): composer attach chip (no backend),
> message branch-off (no fork backend), island Approve→permission-backend,
> question answering backend, dock ghost-slot + trailer + corner rounding
> (need drag-overlay window), `../island-guide.md` §§2–6 otherwise built.

## 0. Approved for implementation (user sign-off 2026-09-22)

Finished — implement as specified, no restyle:

| # | What | Spec |
|---|---|---|
| A | Quiet Console shell: sidebar, crumbs, document chat, composer, context panel | `index.html` tab A |
| P | Providers view | `views.html` → Providers |
| W | Files & Terminal (workspace panel + session header) | `views.html` → Files & Terminal |
| C | Command palette | `views.html` → Palette (+ `index.html` C grammar) |
| I | Status Island: circle vocab, hover layers, approval + question cards, usage, drag | `views.html` → Island |
| E | Island Apple edge dock: rails, ink morph, ghost attach, expand, states | `views.html` → Island Apple, `../island-guide.md` §§2–6 |

Parked — needs rework, no implementation until redesigned:
Teams, Agents, Skills, Plugins, MCP, Settings.

Implementation rules (binding when work starts):

1. New branch off `claude/repo-setup-instructions-8tgcbw` (e.g.
   `design/approved-rollout`); nothing lands on the current branch. Docs-only
   proposal work stays uncommitted until asked.
2. Order: A shell tokens/components → Providers → Files & Terminal →
   Palette → Island → Edge dock. One slice green (`typecheck + lint + test +
   build`) before the next starts.
3. Parked views keep their current code untouched; no half-migration.
4. `PROGRESS.md` ticks only from `pnpm verify` evidence, as always.

> Status: proposal, not implemented. `index.html` is a clickable mock of all
> three directions using the real tokens. v1 was correctly called awful —
> sparse wireframes with no density or content. v2 rebuilds every mock at full
> fidelity: real rows, real chat content, code blocks, property panels.

## 1. What v1 got wrong (honest)

- Empty boxes instead of content. Premium is proven with 287-test runs and
  diffs, not placeholder lines.
- No alignment discipline: icons, labels, counts drifted. Linear's redesign
  post says this explicitly — alignment is felt, not seen.
- Composer was a grey pill. Real composers have attach/model/send/hint rows.
- No right side: the app has a 264px context panel; mocks must show it.
- C had no blurred app behind it — an omnibar without context is a dialog.

## 2. Reference research (online, this round)

| Reference | What it teaches, applied in v2 |
|---|---|
| Linear redesign part II (linear.app/now) | Inverted-L chrome; sidebar/tab/header alignment on both axes; LCH theme from base+accent+contrast; limit chrome color; density via 28px rows. → A's sidebar, crumbs, property panel. |
| Linear app design spec (tastekit.dev) | 13px/510 rows, h32 controls, kbd chips, hairlines rgba(255,255,255,.05–.08), Inter 510/590 never true bold. → row heights, kbd styling, border values. |
| Raycast design DNA (opendesign.cc) | Near-black, hairlines, one accent, 12–14px type, speed = no layout shift. → C's 36px result rows, icon wells, footer hints. |
| Micro-transition stack (Linear/Raycast) | `transition: all .2s` ruins feel; per-property 120–180ms physics. → already our token durations; v2 keeps them. |
| Cursor 3 agent-first, Claude Code desktop | Running-agents rail, tiles over tabs, auto-archive idle. → B's running rail + tile footers. |
| Dark-mode guide (uxdesigninstitute) | No pure white/black, desaturate accents, off-white text. → our graphite + periwinkle already complies. |

## 3. Proposal A — Quiet Console (APPROVED, v3 polish only)

Unchanged layout. v3 adds: code line numbers, faint hover actions
(copy/retry/branch) under assistant turns, `@`-attach chip in the composer,
model-picker chevron, MCP mini-switches, Stop chip on the streaming row, amber
sidebar badges for sessions needing attention. No restyle — the shell is locked.

Full shell: 232px sidebar (app switcher + version, ⌘K search, Workspace /
Sessions with status dots + unread counts, Library, user card with usage),
46px breadcrumb header (workspace / session + branch/model/usage pills),
document chat (user bubble top-right radius cut, assistant prose with
timestamps, code block with header + copy, tool rows with duration + state,
streaming caret), floating composer (attach, model pill, Send + ↵ kbd, hint
line), 248px property panel (status pill, provider/model/branch, context
meter 34%, skill chips, MCP presence, Interrupt/Resume).

Token delta: none new. Narrower sidebar (232 vs 244), that's it.

## 4. Proposal B — Agent Deck (REDESIGNED v3)

What was ugly: four identical dark boxes with no identity, a text-only team
tile, a non-actionable approval tile.

v3: provider avatar chips (initials, distinct hues — provider logos are the
allowed branding) in rail and tiles; ⌘F filter; unread badges, amber when
action is needed. Solo tiles keep fade-masked terminal previews; the team
tile shows a real task checklist with owners and blocked state; the approval
tile carries an amber ring with diffstat and inline Approve/Dismiss.
Segmented progress bars encode done/blocked/rest. Grid/Focus only — chat
opens on enter.

Running rail (4 live with elapsed tabular times, idle workspaces below,
dashed New-session), topbar with Grid/Focus/Chat segmented + Spawn, 2×2
tiles: header (dot + name + LIVE/INPUT pill + elapsed), near-black mono
terminal preview (→/✓/! prefixes), footer (task line + 3px progress).
Approval tile amber, never red.

Token delta: tile grid definition only. `AgentsView.tsx` promotes to Grid
mode; sidebar gains the running group.

## 5. Proposal C — Command-First (REDESIGNED v3)

What was ugly: the blurred backdrop was fake grey skeleton bars, so the
palette read as a dialog from nowhere.

v3: the backdrop is design A itself — real sidebar rows, chat rhythm, code
block, composer, property bars — dimmed + blurred + desaturated. Palette:
live caret, query "code" with accent match-highlighting, group counts,
per-row hints, inset top highlight on the surface. Ranking (session >
provider > command) is the real work; the mock only shows the grammar.

Blurred real shell behind a scrim, 580px omnibar: 15px query row, grouped
36px results (icon well + bold match + right meta), one accent-quiet
selection, footer (↑↓/↵/esc + app mark). Ranking: session > action >
provider; live dots carry into results.

Token delta: `--omni-surface` + blur on this overlay only (§71-legal).

## 6. Recommendation (unchanged, now cheaper)

A now (CSS + existing components), B next (half-built), C behind a toggle.
All inside spec §61–§76.

## 8. All views in A's language (`views.html`)

Inventory from `MainView` + workspace surfaces, each mocked with the same
sidebar, cards, pills, switches, chips and buttons as approved A:

| Tab | Source | Key decisions in the mock |
|---|---|---|
| Providers | `ProvidersView.tsx` | Logo well + install meta + state pill + enable switch; provenance on every value; unverified = amber notice; CLI path/args/models inline |
| Teams | `TeamsView.tsx` | Name + home + agent rows + goal input + runs with Stop; detail stays behind the run (§70) |
| Agents | `AgentsView.tsx` | Capability-filtered launch bar; same tile grammar as concept B; Chat ⇄ Agents toggle |
| Files & Terminal | `WorkspacePanel.tsx` + `SessionHeader.tsx` | Crumbs with branch/model pills; chat excerpt; Terminal/Files/Changes tabs; status letters + diff preview |
| Skills | `SkillsView.tsx` | Scope segmented control as the feature; collapsed rows; capability chips |
| Plugins | `PluginsView.tsx` | Same scopes as skills; connect-once accounts with reference-only secrets |
| MCP | `McpView.tsx` | State + latency on collapsed rows; tool chips; reference-based auth; add-server form |
| Settings | `SettingsView.tsx` | Preference rows with right-docked controls; shortcuts with kbd; updates + about |
| Palette | `CommandPalette.tsx` | Real groups (Session/Workspace/Go to/Providers/Appearance/Island); `isl` filter demo |
| Island | `island/main.tsx` + `island.css` | Split 760px stage: statics left (pill, 4-state circles, usage bars, approval), two live demos right (multi-agent list w/ click-to-usage toggle, idle app-mark → usage overlay); draggable, clamped, dblclick resets |
| Island Apple | new surface | Edge dock, fully wired: state toolbar (working/approval×2/question×2/idle/none), blob rings, hover agent-list + usage w/ click-toggle (closes on drag), click-to-expand w/ staggered rise (agents/ask/usage, idle stats, multi-approval w/ capped diffs + amber glow, multi-question w/ clean ⌘-options + blue glow); ink detach, ghost attach, trailer; reduced-motion safe |

Deliberately unchanged: chat itself (approved A), empty states (same type +
one quiet action), toasts (bottom, text + Dismiss).

## 10. Professional pass (v4, both files)

What read as "AI": glowing + pulsing dots, candy-gradient avatar chips,
text-glyph icons, neon terminal transcripts.

- Status is static: flat dots, state words, elapsed times. Nothing pulses
  except text carets.
- Identity is real: vendored brand marks from `packages/ui/src/logos.ts`
  (Claude, Codex, opencode, GitHub) in neutral wells; letter marks only where
  the inventory has nothing (Gemini, teams, user) — same fallback the app's
  own `Logo` component uses.
- Terminals read as terminals: `$` prompts, muted output, one semantic tick,
  block cursor. No arrow prefixes.
- Every glyph icon became a Lucide-outline SVG. Approval amber kept as the
  one place that earns its color.
- Island: 42px circle by default (ring = state, four states incl. app-mark
  for no-agent). Working hover → compact pill; idle hover → usage bars
  (bars compare across providers, unknowns stay honest). Approval carries
  the provider mark. Both live demos draggable, clamped, double-click reset.
- Skills/Plugins/MCP dropped card-box slop for hairline settings-lists:
  38px rows, effective state as quiet text, scopes as labeled switch rows
  in the expansion. One list language across all three.

## 9. Open questions

- A: sidebar 232 vs 244 — keep 244 to avoid churn?
- B: running rail above or instead of workspaces? (Mock: above.)
- C: boot-to-palette default or toggle? (Proposal: toggle.)
