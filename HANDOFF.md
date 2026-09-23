# Handoff

Written at the end of a remote session, for whoever picks this up next.
Everything described here is on the branch `claude/repo-setup-instructions-8tgcbw`.

`PROGRESS.md` is the authoritative record of what is verified. This file only
says where the work stopped and what the next hands need to know.

## Where things stand

G0–G5 are done and verified. **G6 (Status Island and background runtime) is
half built and is the thing that was in progress when the session ended.**

| Goal | State |
|---|---|
| G0 Foundation | done |
| G1 First vertical slice | done (19/20) |
| G2 Provider platform | done (18/20) |
| G3 Workspace tooling | done |
| G4 Skills, plugins, MCP | done (14/15) |
| G5 Autonomous teams | done (27/28) |
| **G6 Status Island** | **in progress — see below** |
| G7 Hardening | partial (13/19) |
| G8 SDK / packaging | barely started (1/10) |

## How to run it

```bash
corepack enable          # pnpm 10, Node 22+
pnpm install             # postinstall fixes node-pty's spawn-helper permission
pnpm dev                 # the app in development
pnpm verify              # lockfile + lint + typecheck + test + build + verify:app
```

`pnpm verify` is the gate. `PROGRESS.md` may only be updated from criteria that
a run of it actually proves. `pnpm verify:app` starts the built application
headlessly twice against one throwaway database and drives the real renderer;
it is where most of the honest claims come from.

## What is finished in G6, and what is not

### Done and passing

- `packages/status` — `StatusAttentionService` with the priority engine, the
  widget registry, the attention queue and the island state. 12 tests, all
  green, including the honest-progress rules: a percentage only where there are
  tasks to count, a named state for a solo session, and no usage number unless
  a provider reported one.
- `packages/shared/src/domain/status-island.ts` — the island's domain model and
  preferences, and the priorities from spec §99 in one place.
- `apps/desktop/src/main/status-island.ts` — the frameless, transparent,
  always-on-top `BrowserWindow`, positioned per preference, clamped into the
  display, remembering where it was dragged.
- `apps/desktop/src/main/tray.ts` — the system tray with open / show-hide
  island / pause runs / stop all work / quit, and a tray icon drawn in code so
  packaging has no asset to lose. A machine with no tray is handled, not fatal.
- `apps/desktop/src/main/island-controller.ts` — collects what the application
  knows, hands it to the service, renders the answer, refreshes on every domain
  event and on a 2s timer.
- `apps/desktop/src/renderer/island/` — the island's own page, built as a
  second entry of the same renderer build.
- Eight validated `statusIsland.*` IPC channels, the island's own small preload
  bridge, close-to-tray behaviour, and the full preferences block in Settings.

### Not done (updated 2026-09-21, still on `claude/repo-setup-instructions-8tgcbw`)

1. **Command palette entries for the island — DONE, committed.** Commit
   `6ff6209` added "Show/Hide Status Island", "Cycle Status Island widget",
   "Status Island: automatic" and "Pin Status Island: …" to
   `apps/desktop/src/renderer/components/CommandPalette.tsx`, with a
   startup-check step driving the cycle entry through the real palette.
2. **Island startup checks — WRITTEN in the working tree, NOT yet proven.**
   `apps/desktop/src/main/startup-check.ts` now drives the island in the
   running app (enable, separate window, hide/show, least-privilege bridge,
   preferences round-trip, custom position with clamping, restart persistence,
   completed/attention/error entries, palette + keyboard + wheel cycling,
   pinning order, deep-link open, return to compact, hide-main-while-running).
   Supporting uncommitted changes: island starts in check mode
   (`index.ts`), `configure`/`apply` split + focusable window + no-move-loop
   (`status-island.ts`), `cycle` persistence + `setMainVisible`
   (`island-controller.ts`), per-page preload bridges (`preload/index.ts`),
   island keyboard/wheel (`renderer/island/main.tsx`), `IpcInput` vs
   `IpcHandlerInput` (`shared/ipc/contract.ts`), `[fail:]`/`[ask:]` mock
   markers (`mock/team-reply.ts` + new `team-reply.test.ts`) and lead marking
   (`team/prompt.ts`). `pnpm typecheck`, `pnpm lint`, `pnpm test`
   (224 passed) and `pnpm build` are green on Windows. `pnpm verify:app`
   cannot run on this Windows box (no bash/Xvfb; `bash scripts/verify-app.sh`
   fails with REGDB_E_CLASSNOTREG), so the island checks have NOT been
   executed end-to-end yet — run them on Linux/macOS before ticking anything.
3. **`PROGRESS.md` has no G6 criterion ticked.** That is still deliberate. Do
   not tick any of the 22 until `pnpm verify` (including `verify:app`)
   proves it on a machine that can run it.
4. `packages/status` is not yet listed in `PROGRESS.md`'s verification section.

## Stand 2026-09-22 (Style-Wunsch + Kritik-Fixes, alles unverified bis Linux-verify)

- **Agents-Grid 2×2 gebaut:** neu `apps/desktop/src/renderer/components/AgentsView.tsx`
  (LaunchBar capability-gefiltert, Tiles mit Logo/LIVE/ActivityTrace/XtermPane,
  Chat/Agents-Toggle), verdrahtet in `App.tsx`, Styles in `app.css`.
- **Multi-Account + Logos sichtbar:** `ProvidersView.tsx` (Logo + AccountsSection
  mit Connect/Disconnect über existierende `account.*` IPC),
  `SessionHeader.tsx` + `ModelPicker.tsx` + `TeamsView.tsx` zeigen
  `providerLabel` (`lib/provider-label.ts`, z.B. „Claude Code · Arbeit").
- **Architektur-Fixes aus Kritiken:** Orchestrator Hot-Loop + Timeout-Cancel +
  Batch-Budget (`team/orchestrator.ts`), `failTask` Terminal-Guard
  (`team/service.ts`), Session Double-Run + Failed-Answer
  (`core/session-manager.ts`), `#seen`-Cap (`status/attention-service.ts`),
  Island-Refresh-Guard + Event-Unsubscribe (`island-controller.ts`),
  Terminal-Disposables (`terminal/manager.ts`), nur-https `openExternal`
  (`main/window.ts`), tote `visually-hidden hidden`-Spans entfernt.
- `pnpm typecheck/lint/build` grün auf Windows. `pnpm test` für
  team/status/terminal grün (42 passed). Voll-`verify:app` weiter nur auf
  Linux/macOS möglich. `PROGRESS.md` unverändert (kein Tick ohne Beweis).

## Stand 2026-09-22 spät (Remote-MCP + Perf + Polish drin)

- **G4 Remote-MCP fertig implementiert:** `mcp/manager.ts` http/sse mit
  `credentialReference` (Secret nur via CredentialManager, nie geloggt),
  `reconnect`/`health`/`latencyMs`, 18/18 MCP-Tests grün. Wiring in
  `main/services.ts` nachgezogen (`credentials.resolve`). Offen: echte
  `credential_reference`-Spalte + Migration (Referenz liegt derzeit im
  Env-Bag unter reserviertem Key, dokumentiert in `mcp-service.ts`).
- **G7 Perf:** Chat-Fenster + Memo, Team-Paging, Xterm-Caps, Terminal-Chunks,
  Event-Flush — `typecheck/lint` grün.
- **G7 Quiet-Polish:** Skills/Plugins/MCP-Collapse, Popover statt `title`,
  Reduced-Motion, Roving-Tabs, Tokens, Island `expanded`+Fokus.
  Startup-Check Skill-Schritt an Collapse angepasst.
- **Offen:** OpenAI-compat + Custom-UI Builder, Team-MCP-Handover Builder,
  danach Voll-`test`/`build`, Kritik-Runde 2.

## Stand 2026-09-22 Audit-Runde (Spec gegen Code, Erweiterungen unangetastet)- **Team-Audit (§39-53):** §50 `USER_ATTENTION_REQUIRED` nie emittiert →
  jetzt in `requestHelp` + Stall; §52 Lead-null angeglichen (kein Lead →
  jeder darf finishen, wie MCP); §53 Resume resettet `claimed/running` →
  `ready` + persistiert. Tests 50/50 grün.
- **G1-G3-Audit:** Session `enabled*` via CRUD (§22) nachgezogen
  (Schema + Manager); File-Edit `files.write` (§27) + Git-Diff
  `git.diff` (§28) mit IPC/UI-Backend implementiert.
- **Island-Audit (§95-104):** `connectionHealth` in Defaults, Click-Cycle +
  Right-Click-Back + Wheel-Throttle (§100), NaN-Guard, Solo „working"
  (§103), Tray-Zähler aus echten Listen (§104), Display-Reset (§101),
  `SECURITY.md`-Bridge-Drift korrigiert.
- `typecheck/lint/build` grün. Verbleibend aus Audits: ProjectActivity-Widget,
  Permission-Quelle, Provider-Disconnect/Build-Feeds, DB-Namens-Mapping-Doku,
  Event-Namens-Mapping, Settings-Areas-Mapping, Dev-Mode-Panel, fehlende
  §88-Komponenten, Release-Workflow, Upgrade-Doku.

## Release 0.0.1 (2026-09-22)

Commit auf `claude/repo-setup-instructions-8tgcbw`, Tag `v0.0.1`. Enthalten:
G6-Island + Tray + Startup-Checks, Agents-Grid, Multi-Account, Logos,
Remote-MCP, OpenAI-compat + Custom-Provider, Team-MCP-Handover, per-Agent
Teams, Auto-Updater (GitHub), Modell-Discovery (`modelsArgs`), Datei-Edit +
Git-Diff, Session-Auto-Namen, Sidebar-Löschen, Workspace-Dedup, Quiet-Polish,
Perf-Fenster, Bug-Hunt-Fixes (Races, Leaks, Shutdown, Recovery). Bewusst
offen: Linux-`verify:app`, echte Codex/Gemini-Runs, Ordner-Dialog-Klick,
PROGRESS-Ticks erst nach Beweisen. Ungeprüft: Mutex-Lost-Updates (Team-Budget),
Session-Vollzeilen-Races, Plugin→Provider-Bridge, Agent-Scope (siehe Audits).
Nach dem Commit dazu: Teams global (Liste ohne Filter, Home-Anzeige),
Chat/Agents-Shortcut Ctrl+Shift+A + Palette + Titel-Hinweise + Shortcuts-Sektion
in Settings, Sidebar-Löschen + Session-Auto-Namen + Workspace-Dedup, Island
Default-an + Self-Heal + Click-Cycle, Builder-Portable-Name, UpdateSection- und
MCP-Test-Fixes.

## Stand 2026-09-22 (Approved-UI-Rollout auf `design/approved-rollout`, bun)

Alle sechs freigegebenen Slices implementiert (A-Shell, Providers, Files &
Terminal, Palette, Island, Island Apple). Parked views (Teams, Agents, Skills,
Plugins, MCP, Settings) unangetastet. `bun run typecheck` + `bun run build`
grün, `packages/status` + `packages/shared` 23/23 grün. Volle Suite lief an
(~210 Tests, keine Failures vor Timeout), `bun run lint` ist env-weit kaputt
(uri-js unter bun: `Cannot find module .../uri.all.js` — pre-existing, auch
ohne diese Änderungen), `verify:app` weiter nur Linux/macOS.

Renderer (alles mit echten Daten oder ehrlichem "unavailable", nichts erfunden):

- `Sidebar.tsx` (+`App.tsx` appVersion): App-Mark + echte Version, ⌘K-Search,
  Session-Counts aus `messages` (muted), amber `!` nur bei waiting/error,
  Library-Counts aus Store (providers/skills/plugins/teams/mcp).
- `SessionHeader.tsx`: echte Branch-Pille (`git.status`: branch · clean/N
  changed, entfällt wenn kein Repo), Status-Pille statt Text.
- `MessageItem.tsx` + `ChatView.tsx`: Code-Fences mit Zeilennummern + Copy,
  Hover-Actions (Copy immer; Retry sendet User-Text bzw. vorherige User-Turn
  bei failed Assistant), Tool-State (running/✓ done/! failed, keine erfundene
  Dauer), Streaming-Zeile mit Stop-Chip (echtes cancel). Kein Branch-off (kein
  Fork-Backend — dokumentiert, nicht geraten).
- `Composer.tsx`: Placeholder Reply…, Hint mit Esc, Send + ↵-Kbd. Kein
  Attach-Chip (kein Attachment-Backend — dokumentiert).
- `ContextPanel.tsx`: Status-Pille, echte Model-Zeile, Context-Meter nur mit
  bekanntem Fenster, Skill-Chips, MCP-Mini-Switches, Interrupt nur wenn busy
  (kein Resume — kein Backend).
- `ProvidersView.tsx`: Card-Köpfe mit Logo-Well + Install-Meta + Auth-Pille
  (Signed in/Unknown auth/…) + Enable-Switch statt Hide/Show-Button.
- `WorkspacePanel.tsx` + `ChangesView.tsx` + `FilesView.tsx`: Changes-Count im
  Tab (`git.status`, ehrlich), Diff-Preview pro Datei (`git.diff`, 60 Zeilen
  Cap, add/del-Töne, "Diff unavailable"/"No textual diff" statt Raten),
  Datei-Preview mit Zeilennummern.
- `CommandPalette.tsx`: Gruppen-Header mit Counts, Match-`<mark>`, Lucide-Icons
  pro Gruppe, Footer (↑↓/↵/esc). Neues `agentQuestion`-Label für die Palette.

Island + Edge-Dock (`island-guide.md` §§2–6, bis auf dokumentierte Reste gebaut):

- `shared/domain/status-island.ts`: `agentQuestion`-Widget (Prio 95),
  `islandEdgeSchema`, `dockedEdge`/`railT`/`minimalByDefault`-Prefs,
  optionale `diff`/`options`/`icon`-Felder + `usage`-Rows (alle mit Defaults,
  Builder via `quietDefaults()`), `ISLAND_PRIORITY.agentQuestion`,
  `ISLAND_TIMING`-Konstanten an einem Ort.
- `status/widgets.ts`: `providerUsageWidget` hängt echte Usage-Rows an
  (percentLeft aus reported Limits, nichts ohne Zahl).
- IPC: `statusIsland.resetPosition` + `statusIsland.resize` (Contract +
  `ipc.ts` + Controller + Preload + `api.d.ts`). Noch KEIN answer/act —
  dafür fehlt das Permission-/Question-Backend (größte offene Arbeit, §6.2).
- `main/status-island.ts`: Fenstergröße gehört dem Renderer (resize-Channel),
  `#place` mit Edge-Rails, Snap nach Drag-Ende (350ms-Debounce, `snapPx` 54)
  + Detach (`detachPx` 78) via `onSnapEdge`/`onDetach`, `nearestEdge`/
  `dockPoint`/`distanceFromEdge` exportiert und testbar.
- `renderer/island/`: Rewrite auf approved Vokabular — 42px-Circle (accent/
  amber/blau/hairline + Count-Badge), Hover mit 240ms-Grace (Drag per
  mousedown gekillt), Click-Matrix (working toggelt agents⇄usage, approval/
  question pinnt), ⌘1–9/Enter/Escape/Arrows/Wheel wie bisher, Multi-Listen,
  Usage-Bars (amber <20%, "Usage unavailable" ohne Daten), Approval-/Question-
  Cards (scrollend, flach, Diff-Cap 6), Edge-Pill horizontal/vertikal +
  Expand-Panel, dblclick-Reset (lokal + Position), reduced-motion-safe.
- Interim ehrlich markiert: Approve/Dismiss deep-linken per `open`/`dismiss`
  (Kommentar im Code) bis Approve denselben Pfad wie das Terminal nutzt;
  Question-Optionen ebenso. Ghost-Slot + Trailer-Dot + Corner-Rounding
  entfallen bewusst (brauchen Drag-Overlay-Fenster — Follow-up in §4.3 des
  Guides beschrieben).

Nächste Schritte: 1) Linux/macOS `verify` (inkl. `verify:app`) + visuelle
Abnahme im echten Fenster, 2) Permission-/Question-Backend (§6.2) mit echten
answer/act-Channels, 3) Drag-Overlay (Ghost/Trailer), 4) G6-Kriterien in
`PROGRESS.md` NUR aus Verify-Evidenz ticken. `package.json` trägt nebenbei
bun-Scripts/Workspaces (Branch nutzt bun statt pnpm).

## Stand 2026-09-22 später (1:1-Pass auf Mock A, gleiche Branch)

Hauptfenster exakt auf `docs/design-proposals/index.html` Tab A gezogen, weiter
ohne erfundene Daten: Sidebar (App-Mark + echte Version, Search-Box, 28px-Rows,
7px-Dots, User-Card mit OS-Username + echter Provider-Anzahl + echtem
Usage-%/`—`), Crumbs-Header (ws/sess + rechts Branch-/Status-/Model-/Usage-
Pills; `app.getInfo` liefert neu `username` aus `os.userInfo`, Fallback
"local"), Chat als Dokument (620px, Day-Divider Today/Yesterday/Datum, User-
Bubble `4px 12px 12px 12px` inline-block, Tool-Rows als Boxen mit ✓done/!failed,
Codeblöcke near-black mit Header + Copy), schwebender Composer (620px-Card mit
Schatten, Attach disabled + Tooltip, Commands→Palette, Model-Pille→Palette,
Send accent, zentrierter Hint), Context-Panel sunken mit Interrupt + Resume
(Resume = letzte User-Turn erneut senden, nur wenn vorhanden). Header hat keine
Selects/Toggles mehr — Model/Provider/Effort-Wechsel laufen über die Palette
(neue "Reasoning effort:"-Commands, nur echte Optionen des aktiven Tools);
`ModelPicker.tsx` gelöscht. Typecheck + Build grün, status/shared 23/23 grün.
Offen: Workspace-Branch-Meta in Sidebar (kein Workspace-Git-IPC), Syntax-
Highlighting in Codeblöcken (einfarbig), visuelle Abnahme am laufenden Fenster.

## Stand 2026-09-22 abends (Island-Fokusregel + Check-Reparaturen, gleiche Branch)

Verhalten wie gewünscht: Island ist ab Launch da, versteckt sich aber, solange
das Hauptfenster fokussiert ist, und kehrt zurück, sobald der Fokus weggeht
(`focus`/`blur` → `IslandController.setMainFocused`, inkl. Initialauswertung in
`start()`). Explizite Entscheidungen gewinnen: `hide()` klebt bis `show()` oder
Re-Enable, `show()`/Re-Enable zeigen sofort, danach regiert wieder der Fokus;
deaktiviert bleibt deaktiviert; Tray-Toggle läuft über den Controller.
Minimieren holt die Insel zurück, außer `stayVisibleWhenHidden` ist aus.
Settings-Texte (Enabled, Start with) beschreiben das so.

Dazu die fälligen Reparaturen, weil Renderer-Rewrite + Header-Slimmung die
Headless-Checks gebrochen hätten: stabile Hooks (`.isl`-aria-label mit
Single-Entry-Titel, `.isl__actions`, `.header__actions`-Pills), dynamische
Größen statt 320x44/380x132 (Checks pollen Bounds), generische Action-Card für
Errors & Co. (Service-`expanded` wird wieder gerendert), Fokus-Tanz als neue
Checks (versteckt bei Fokus, zurück bei Blur, Resume nach Blur). `verify:app`
weiter nur Linux/macOS lauffähig — dort muss das alles erst grün werden, bevor
irgendwas in `PROGRESS.md` tickt.

## Stand 2026-09-22 nachts (Minimize-Regression + Dev-Island-URL, gleiche Branch)

Zwei echte Bugs, beide gefixt (typecheck/build/28 Tests grün):

1. **Minimieren ging nicht mehr:** `#applyFocusRule` las die Sichtbarkeit über
   `focusMainWindow()` — das aber restored, zeigt und fokussiert als
   Seiteneffekt. Jeder Blur (also auch Minimieren) holte das Fenster sofort
   zurück. Neu: `IslandControllerOptions.getMainWindow()` als rein lesender
   Zugang; Fokus-Regel und Start-Check nutzen nur ihn. `focusMainWindow`
   bleibt nur für explizites Öffnen (Island-Deep-Link).
2. **Keine Insel im Dev:** `loadURL(devServerUrl + 'island/index.html')`
   ergab `http://localhost:5173island/index.html` (ERR_INVALID_URL im Log).
   Basis wird jetzt am Slash normalisiert. Hinweis: bei fokussierter App bleibt
   die Insel per Fokusregel versteckt — zum Sehen woanders hinklicken oder
   minimieren (geht wieder).
## Stand 2026-09-22 ganz spät (Island-Guide-Audit + Loading/Error, gleiche Branch)

Island gegen `docs/island-guide.md` §§2–3 auditiert, echte Abweichungen
gefixt: Approve-all-Kopf (interim Deep-Link wie Approve, kommentiert),
Card-Collapse per Hintergrund-Klick, 5px-Drag-vs-Click-Guard, Hover zeigt
dieselbe Card wie Pin (keine Compact-Divergenz mehr), Footer immer
"Answer later", "now" für frische Fragen, Usage-% auf Idle-Pills, Persistenz
des Hover-Modus (localStorage), 180ms-Fade beim Schließen, Ink-Morph
(Crossfade + Blur-Puls, reduced-motion-safe), Diff-Fade nur innerhalb des
gecappten Diffs. Neu: Loading-Circle bis zum ersten State, Error-Card mit
exaktem Grund + Retry (fehlende Bridge sofort, 15s ohne State als Timeout);
Bridge-Type optionalisiert. Ghost-Slot + Trailer-Dot + Eckenrundung bleiben
bewusst draußen (brauchen Drag-Overlay-Vollbildfenster — blind ein
klickfressendes Overlay zu shippen wäre schlimmer). Typecheck/Build/28 Tests
grün; `verify:app` muss auf Linux/macOS erst beweisen.

## Stand 2026-09-22 nachts 2 (Boot-Screens ins Hauptfenster, gleiche Branch)

Loading/Error gehören ins Hauptfenster, nicht auf die Insel: App gated jetzt
auf `ready` (Boot-Screen "Starting AI Workbench…"), Boot-Fehler zeigen die
exakte Ursache + Retry (`bootError` im Store, nur aus initialize-Catch).
Insel rendert ohne State wieder null (stumme Folie). Shell-Check wartet auf
`.app` (15s). Fokus-Regel loggt Übergänge (STATUS_ISLAND: hidden while
focused / shown while in background) — Terminal verrät exakt, was die Insel
tut. Typecheck/Build/28 Tests grün.
## Stand 2026-09-22 nachts 3 (Insel malt nichts — Diagnoseinstrumente, gleiche Branch)

Symptom: Log sagt "shown", Screen zeigt nichts, kein Ladefehler. Statisch ist
alles sauber (resolveTheme ok, Mount-Point ok, Bridge-Pfad ok), also rät man
nicht weiter: Insel meldet jetzt Ladefehler (`did-fail-load` mit Code/URL)
und Konsolenausgaben inkl. Exceptions (`console-message`) ans Terminal —
stille Folie war der eigentliche Bug zweiter Ordnung. Nach Neustart die neuen
STATUS_ISLAND-Zeilen schicken, dann steht die Ursache fest. Typecheck/Build/
28 Tests grün.
## Stand 2026-09-22 nachts 4 (Hooks-Reihenfolge = blinde Insel, gleiche Branch)

Diagnose bestätigt per Terminal: `Rendered more hooks than during the previous
render` — frühes `return null` stand über useMemo/useRef/useEffect, React
mountete die Insel ab → transparente Folie, kein Inhalt. Fix: alle Hooks
laufen unbedingt, Guards erst danach; Hover-Modus-Reset beim Face-Wechsel
entfernt (echte Persistenz). NB: react-hooks/eslint hätte das gefangen, läuft
hier aber nicht (uri-js unter bun kaputt) — CI-Lint beachten. Dazu
console-message auf Event-Objekt-Signatur umgestellt (Deprecation weg).
Typecheck/Build/28 Tests grün.
## What to do first

1. On Linux/macOS: `pnpm verify` and confirm it is green. On Windows only
   `typecheck + lint + test + build` are expected green; `verify:app` needs
   bash/Xvfb/Electron display.
2. Open the app with `pnpm dev`, turn the island on in Settings, and see it.
   Nothing in G6 should be ticked before a person has actually looked at it.
3. Run `verify:app` on Linux, fix any island check failures, then tick G6 in
   `PROGRESS.md` from what the run proves (plus the tray check, which still
   has no headless assertion).

## Things that will bite you if nobody says them

- **The startup check used to pass falsely.** It took Electron's
  single-instance lock, so a run that overlapped another instance quit
  immediately with exit 0, which read as a pass. It now takes no lock, every
  check has a timeout, and a phase that reports no outcomes fails. If you see
  a suspiciously fast pass, check for stray `electron` processes first.
- **node-pty ships `spawn-helper` without the executable bit.** `pnpm install`
  runs `scripts/fix-pty-permissions.mjs` to fix it. Without that, opening a
  terminal fails with `posix_spawnp failed` on macOS and Linux — in the
  packaged app as much as in a checkout. Do not remove the postinstall.
- **Windows CI is roughly 40× slower than Linux** for these tests, which open
  databases and spawn shells. `vitest.config.ts` has 30s test and hook
  timeouts for that reason. The Windows packaging job was still red at the end
  of the session; the last failure was node-pty's console-list agent crashing
  (`AttachConsole failed`) and everything running slowly around it. macOS and
  Linux package successfully.
- **The lockfile must stay in step.** `pnpm verify:lockfile` runs first in
  `pnpm verify` because a stale lockfile fails every packaging job on
  `--frozen-lockfile` before a single test runs. That happened once already.
- **Do not invent provider facts.** Neither Codex nor Antigravity has a command
  that lists the models an account may use, so only Claude Code ships a model
  list; the others are filled in on the Providers screen. Google replaced the
  Gemini CLI with the Antigravity CLI (`agy`); both profiles ship, both marked
  unverified, because neither was run against the real tool here.

## Releases

`.github/workflows/release.yml` builds on native runners for all three
platforms and is triggered manually (`workflow_dispatch`). The `release` job
needs every packaging job green, so no GitHub Release has been produced yet —
Windows is the hold-up. Linux and macOS artifacts can be downloaded from a
finished run's Actions page in the meantime.

## The rules this repository is built on

`CLAUDE.md` is short and worth reading before changing anything. The two that
shape the most code:

- **Provider independence.** No generic service branches on a provider name.
  The UI enables features from capabilities; every provider normalizes into the
  same event stream. If you find yourself writing `if (providerId === …)`
  outside an adapter, it belongs somewhere else.
- **Never invent progress or provider support.** `PROGRESS.md` is computed from
  criteria a run of `pnpm verify` proves, and the application says plainly when
  something is unverified, unsupported or unknown rather than implying more.
