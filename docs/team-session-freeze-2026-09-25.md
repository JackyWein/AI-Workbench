# Teams-Session friert ein / crasht — Ursache, Fix, Vorbeugung

Stand: 2026-09-25. Betrifft vor allem lange Teams-Sessions: Die App fror irgendwann
ein oder crashte. Kein einzelner Bug, sondern mehrere sich verstärkende Lastpfade,
die mit der Laufzeit der Session wachsen. Untersucht mit einer Flotte aus vier
Subagenten (Orchestrator/TeamManager, Renderer, Main/IPC/Provider/Terminal,
Crash-Historie).

## Warum es passierte (Hauptursachen, nach Wirkung sortiert)

### 1. Island-Refresh pro Token blockierte den Main-Prozess (HOCH)
`apps/desktop/src/main/island-controller.ts` — `events.subscribe(() => refresh())`
lief auf **jedem** Domain-Event, also auch `message.delta` / `provider.event`
(pro Token) und `AGENT_PROGRESS` (Heartbeat alle 5 s pro Agent,
`packages/team/src/orchestrator.ts`). Jeder Refresh las bis zu 10 volle
Team-Snapshots (`listRuns().slice(0,50)` → bis 10× `getSnapshot()`, je mit allen
Tasks/Messages/Decisions/Artifacts/Turns inkl. bis zu 200-KB-Turn-Outputs) plus
Sessions, Workspaces, Agent-Terminals, Terminals, Settings und Usage. Bei
parallelen Team-Turns mit Tokenstrom bedeutete das: volle DB-Scans im
Sekundentakt auf dem Main-Thread → Freeze.

### 2. Renderer lud den vollen Run-Snapshot im Sturm neu (HOCH)
`apps/desktop/src/renderer/store/workbench.ts` (`refreshTeamRun`) ersetzte bei
jedem Team-Event **und** alle 3 s per Poll (`TeamSessionView.tsx`) den kompletten
Snapshot — ohne In-Flight-Guard, ohne Throttle, ohne Gleichheitsprüfung. Dazu
`App.tsx` (`useWorkbench()` ohne Selektor) + `useLiveReports` + `useNow`-Timer
pro Turn: jeder Heartbeat reconciled die gesamte Timeline neu. Lange Runs →
Megabyte-Snapshots × Event-Sturm × Voll-Re-Render = UI-Freeze.

### 3. Timeline rendert alles ohne Fenster (HOCH)
`TeamSessionView.tsx` (`TeamTimeline`) mappte **alle** Einträge (Messages, Tasks,
Artifacts, Decisions, Turns) ins DOM — keine Paginierung wie `ChatView`
(100er-Fenster) oder `TeamsView` (50er-Seiten). Hunderte Einträge → tausende
DOM-Nodes + Markdown-Parse pro Refresh. Jeder laufende Turn hatte zusätzlich
einen eigenen 1-s-`useNow`-Timer.

### 4. Prompt wuchs unbegrenzt (OOM über die Zeit)
`packages/team/src/prompt.ts` (`buildAgentPrompt`) konkatenierte **alle**
Decisions, Tasks, Artifacts und **alle** ungelesenen Inbox-Nachrichten
(je bis 100 KB) ohne Kürzung. Worst case: 200 × 100 KB = 20 MB Prompt →
Provider-Crash/OOM. `recordDecision` / `publishArtifact` / `updateSharedState`
in `packages/team/src/service.ts` hatten zudem keine Limits (nur Calls/Tasks/
Messages/Delegationen sind limitiert).

### 5. Session-Setup hing vor jedem Timeout-Schutz (Freeze ohne Ausweg)
`packages/team/src/orchestrator.ts` (`#ask`) startet Silence-/HardCap-Timer erst
**nach** `await #sessionFor(agent)`. Capabilities-, MCP- und Skills-Auflösung
(`packages/core/src/team-manager.ts` `#memberSetup`) hatten **kein Timeout**.
Hing ein Provider/MCP/Skills-Aufruf, hing der Turn ewig — alle dokumentierten
Timeouts griffen nicht.

### 6. Abgebrochene Sessions blieben ewig „busy“ (scheinbarer Freeze)
`packages/core/src/session-manager.ts` (`cancel`) wartete 5 s auf `run.finished`,
löschte den Eintrag danach aber **nicht**. Ignorierte ein Adapter das Cancel,
blieb `isBusy() === true` für immer: keine neue Nachricht, kein Löschen —
die Session wirkte eingefroren.

### 7. Terminal-Close schluckte den Exit (Zombie-ptys, Tiles ewig „working“)
`packages/terminal/src/manager.ts` (`close`) löschte und disposete **vor**
`pty.kill()`. Damit war der `onExit`-Listener schon disposed → `onExit` feuerte
nie für explizites Schließen → `agentTerminals.handleExit` wurde nie erreicht,
Tiles blieben „running“, Prozesse konnten überleben.

### 8. `team.undoTurn`-IPC rief eine nicht existierende Methode (deterministischer Crash-Pfad)
`apps/desktop/src/main/ipc.ts` rief `services.teams.undoTurn(...)`, das es in
`packages/core/src/team-manager.ts` **nicht** gab (`TypeError` bei jedem Aufruf).
Aktuell ohne Renderer-Aufrufer (F9 baut Solo-Undo), aber ein scharfer Pfad für
die Zukunft.

### 9. Nebenbefunde (Dauerlast, kein akuter Crash)
- `AsyncQueue` (`packages/providers/transports/cli/src/lines.ts`) ohne Limit:
  schneller Produzent → unbegrenztes `#items`-Wachstum → OOM im Main.
- `workspace.deleted` stoppte nur Agent-Terminals, nicht Team-Runs
  (`apps/desktop/src/main/services.ts`): gelöschte Workspaces ließen CLI-Kinder
  weiterlaufen.
- Stalled-Loop (`orchestrator.ts`) spammte Warnung + Attention pro Iteration
  ohne Cooldown; HardCap erlaubte bis zu 10 h pro Turn.

Bereits vorhanden und intakt (nicht die Ursache): `crash-guard.ts`
(uncaughtException/unhandledRejection, Reload-Schutz, `session.json`-Marker,
`crash-reports/` mit Log-Tail), `recoverInterruptedRuns` /
`session-manager.recoverInterrupted`, Renderer-Error-Boundaries,
`RecoveryNotice`. Die früheren „random crashes“ waren laut `HANDOFF.md`
größtenteils electron-vite-Restarts bei Arbeit am eigenen Repo.

## Was gefixt wurde (2026-09-25)

| # | Datei | Fix |
|---|-------|-----|
| 1 | `apps/desktop/src/main/island-controller.ts` | Event-Filter (`message.delta`, `provider.event`, `AGENT_PROGRESS` lösen keinen Voll-Refresh mehr aus; 2-s-Timer malt Fortschritt) + Throttle (max 1/s, trailing Refresh). |
| 2 | `apps/desktop/src/renderer/store/workbench.ts` | `refreshTeamRun`: In-Flight-Guard + 2-s-Throttle mit trailing Reload. |
| 3 | `apps/desktop/src/renderer/components/TeamSessionView.tsx` | Poll 3 s → 5 s, pausiert bei `document.hidden`; Timeline-Fenster (`TIMELINE_PAGE = 100`, „Show earlier“-Button statt Alles-Render). |
| 4 | `packages/team/src/prompt.ts` | Prompt-Bounding: neueste N Einträge pro Sektion, je Eintrag + Total-Cap (24 KB Kontext, Protokoll immer intakt). Verifiziert: MB-Historie → ~25 KB Prompt. |
| 5 | `packages/core/src/team-manager.ts` | Timeouts um Capabilities (15 s), Tool-Access/Skills (je 30 s), `#withAccess` (60 s) — Turns laufen degradiert weiter statt ewig zu hängen. `undoTurn(runId, artifactId)` implementiert (Folder-Snapshot aus Artifact-Metadaten, wie Solo-Undo; verweigert bei laufendem Run). Import-Typ-Lintfehler (`import()`-Annotationen) beseitigt. |
| 6 | `packages/core/src/session-manager.ts` | `cancel` räumt nach der 5-s-Grace den Run-Eintrag zwangsweise ab + meldet `idle`: keine ewig-„busy“-Sessions mehr. |
| 7 | `packages/terminal/src/manager.ts` | `close`: erst `kill`, dann idempotent aufräumen + `onExit` melden; `onExit`-Handler doppelt-sicher (kein Doppel-Report). |
| 8 | `packages/providers/transports/cli/src/lines.ts` | `AsyncQueue` auf 5.000 Einträge begrenzt (älteste zuerst raus). Verifiziert: 6.000 Pushes → 5.000 gepuffert, `first=1000`. |
| 9 | `apps/desktop/src/main/services.ts` | `workspace.deleted` stoppt zusätzlich `teams.cancelRunsIn(workspace)`. |
| — | Vorarbeit-Reparaturen (lagen uncommitted kaputt im Baum) | `services.ts`: fälschlich an `SessionManager` übergebene `worktreeGit`-Optionen entfernt; `schedule-runner.ts`: `teams.snapshot()` → `teams.getSnapshot()`; 4 Team-Test-Fixtures: fehlendes `separateWorktrees: false` ergänzt; `memory-index.ts`: überflüssige Escapes entfernt. |

## Wie verifiziert (Windows, 2026-09-25)

- `bun run typecheck` — grün (vorher 6 Fehler aus uncommitted Vorarbeit, jetzt 0).
- `bun run lint` — 0 Errors (3 bekannte `console`-Warnings in Scripts, wie in `HANDOFF.md` dokumentiert).
- `packages/team/src/__tests__` — 37/37 grün.
- `packages/core/src/__tests__/team-flow.test.ts` — 19/19 grün (inkl. Crash-Recovery, continueRun, Diff-Artefakte).
- `packages/core/src/__tests__/resilience.test.ts` — 7/7 grün; `packages/terminal` — grün.
- `bun run build` — grün.
- Prompt-Bound + Queue-Cap per Skript nachgewiesen (s. oben).
- **Nicht** auf dieser Maschine beweisbar (by design, siehe `AGENTS.md`/„Traps“):
  `bun run verify:app` braucht bash + Display/Xvfb und läuft nur auf
  Linux/macOS. `PROGRESS.md` wurde daher nicht angetastet; ein
  Linux/macOS-`bun run verify` (inkl. beider `verify:app`-Phasen) steht noch aus,
  bevor irgendetwas als „bewiesen“ gilt.

## Nachtrag 2026-09-25: 4. Crash (erster auf 0.0.8) beim Fortsetzen

Beim Fortsetzen einer Team-Session starb die App erneut — hart, ohne Logspur,
ohne Renderer-Crash-Report, ohne WER-Eintrag (Prozessliste danach ohne
`ai-workbench`). Aus Live-Diagnose (Crash-Reports, Main-Log, DB, Prozessbaum):

- Der fortgesetzte Run ist **klein** (5 Calls, 3 Tasks, 5 Turns, ~14 KB):
  Snapshot-OOM scheidet für diesen Crash aus.
- Alle 4 Agents liefen auf **OpenCode mit freien Fremdmodellen**; jeder Turn
  scheiterte mit „OpenCode reported an error“. Dazu ein permanent blockierter
  Review-Task (Abhängigkeit formal erfüllt) mit wiederholten
  „still waiting on other work“-Warnungen — der Run kam nie voran.
- Jeder Crash **verwaist Provider-Kinder**: `opencode serve --service`
  (400+ MB, CPU-lastig) und MCP-`node`-Prozesse überleben den Tod des Parents
  und summieren sich pro Zyklus. `terminate()` kennt keinen Process-Group-Kill,
  beim Crash räumt gar nichts auf.
- Gefundene Race im Fortsetzen-Pfad: zwei schnelle Resumes konnten **zwei
  Orchestratoren für denselben Run** starten (`#active` wurde erst nach
  DB-Awaits in `#drive` gesetzt) — zwei Loops, zwei Provider-Sessions pro
  Agent, divergente Speicher, ein DB-Zeilensatz.
- `pause()` wartete unbegrenzt auf den Loop: hängt ein Turn, hängt Shutdown →
  Kill ohne Spur. `resumeRun` ließ `stop_reason: "interrupted"` auf einem
  laufenden Run stehen. Der Stall-Loop warnte pro Iteration (Mailbox- und
  Island-Spam bis zum Nachrichtenbudget).

Gefixt (gleicher Tag, uncommitted):

| Datei | Fix |
|---|---|
| `packages/core/src/team-manager.ts` | `#starting`-Reservierung: `resumeRun`/`continueRun` reservieren synchron; zweiter Versuch wird mit „already starting“ abgewiesen. `#drive`-Setupfehler markiert den Run sichtbar als `failed` statt pending + unbehandelter Rejection. |
| `packages/team/src/service.ts` | `start()` löscht veraltete `stopReason`. |
| `packages/team/src/orchestrator.ts` | `pause()` mit 5-s-Grace (wie `cancel`); Stall-Warnung nur bei neuer Blockade; nach 5 ereignislosen Stall-Passes endet der Run mit `noWorkLeft` statt ewig zu kreisen. |
| Tests | `stall-warning.test.ts` (1 Warnung pro Blockade, Terminierung, `stopReason`-Reset), `team-flow.test.ts` (Doppel-Resume → genau ein Treiber, `TEAM_STARTED` genau 1×). |

Offen (kein Fix behauptet): verwaiste `opencode serve`/`node`-Prozesse aus den
Crash-Zyklen laufen noch auf der Maschine (PIDs s. Diagnose) und müssen einmal
händisch beendet werden; Process-Group-Kill beim Beenden und Aufräumen beim
Crash bleiben Folgearbeit. Die harte Todesursache selbst (nativer Absturz vs.
Kill von außen) ist aus den Spuren nicht beweisbar — neu ist, dass der
Fortsetzen-Pfad keinen doppelten Treiber und keine Endlosschleife mehr
hergeben kann und jeder Stopp protokolliert wird.

## Nachtrag 2026-09-25: Wurzel der Millionen-Warnungen gefunden und gefixt

Der User lieferte die entscheidende Spur: `Task could not be started ...
still waiting on other work` im gleichen Millisekunden-Takt, dann Hang, Freeze,
Crash — nur bei Team-Resume. Mechanismus, per Code-Lektüre bewiesen:

- Der Scheduler wählt per **Graph** (`viewOf`: Abhängigkeiten erfüllt →
  runnable) und ignoriert dabei das gespeicherte Status-Label.
- `claimTask` prüfte dagegen das **Label** (`status === "blocked"` → throw).
- Ein Task mit erfüllten Deps aber altem `"blocked"`-Label (Crash/Restart-
  Race) wurde dadurch **jede Runde gewählt und verweigert, ohne je Zustand
  zu ändern** — Hot-Loop im 250-ms-Takt, Millionen Warnungen, Event-/DB-/Log-
  Flut → Freeze → Crash.

Gefixt (uncommitted, verifiziert): `claimTask` heilt das Label per
`settledStatus` vor der Prüfung (`packages/team/src/service.ts`); Batches
ohne jeden Fortschritt (kein Turn, kein Task-Wechsel per `taskFingerprint`)
enden nach 10 Passes mit `noWorkLeft` (`orchestrator.ts`, Backstop für
unbekannte Flip-Flops). Regressionstest mit exakt dem User-Zustand
(`stall-warning.test.ts`: completed-Dep + `blocked`-Task → Claim gelingt).
Team-Paket 40/40, typecheck, lint 0 Errors, Build grün.

## Regeln für die Zukunft (damit das nicht wiederkommt)

1. **Kein Voll-Refresh auf Hochfrequenz-Events.** `message.delta`,
   `provider.event` und `AGENT_PROGRESS` dürfen nie einen vollen Snapshot-Scan
   auslösen — weder auf der Island (`island-controller.ts`) noch im Renderer
   (`refreshTeamRun`). Neue Event-Typen immer zuerst gegen diese Regel prüfen.
2. **Jeder Poll braucht Guard + Throttle + Sichtbarkeitsprüfung.**
   In-Flight-Guard, min. Intervall (2 s Store / 5 s View), `document.hidden`
   überspringen. Kein zweiter Poll-Pfad parallel zum Event-Pfad ohne
   Drossel.
3. **Lange Listen immer fenstern.** Neue Timeline-/Feed-/Log-Ansichten nur mit
   Paginierung/Virtualisierung (`TIMELINE_PAGE`-Muster); Voll-Render ist ein
   Freeze-Bug, kein Stil.
4. **Prompts und Queues immer begrenzen.** Unbegrenzte Konkatenation
   (Prompt-Bau) und unbegrenzte Puffer (`AsyncQueue`, Turn-Outputs, Snapshots)
   sind OOM-Bugs mit Verzögerung. Jede neue Sammlung braucht Cap + Trunkierung
   vom ersten Commit an.
5. **Setup-Pfade immer mit Timeout.** Alles, was vor den Turn-Timern läuft
   (Session-Aufbau, Capabilities, MCP, Skills, Git-Snapshots), bekommt ein
   Timeout mit degradiertem Fallback — nie `await` ohne Uhr.
6. **Cancel muss immer aufräumen.** Nach der Grace-Period wird der Run-Eintrag
   entfernt und `idle` gemeldet, auch wenn der Provider nie settlelt. „Busy für
   immer“ ist ein Freeze.
7. **Kill vor Dispose, Exit idempotent.** `TerminalManager.close` tötet erst und
   meldet den Exit selbst; `onExit` ist gegen Doppel-Report gehärtet. Neue
   Lifecycle-Pfade (Workspaces/Sessions löschen) müssen Team-Runs mitstoppen.
8. **Kein IPC-Handler ohne Methode.** `ipc.ts` darf nur existierende
   Service-Methoden aufrufen; neue Contract-Kanäle nur zusammen mit
   Implementierung + Test (der `team.undoTurn`-Pfad war scharf, aber tot).
9. **`PROGRESS.md` nur per `bun run verify`-Evidenz bewegen.**
   Windows beweist `typecheck + lint + test + build`; E2E (`verify:app`,
   beide Phasen) nur auf Linux/macOS. Scheinbar schnelle Pässe ohne
   `PASS`-Zeilen = stray-`electron`-Prozess → killen, rerun (`AGENTS.md`).
