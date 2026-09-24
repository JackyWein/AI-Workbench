# Status Island

**Status: implemented (goal G6).** The requirements are in `AI_WORKBENCH.md`
§95–§104. What was once a plan now runs: an attention service decides what
matters, a companion window shows it, and a tray icon keeps background work
reachable with no window on screen.

## Architecture

```text
Domain Event Bus / AppServices
      ↓ collect (no decisions)
IslandController
      ↓ decide
StatusAttentionService
      ├── Priority engine
      ├── Widget registry
      ├── Attention queue (seen-keys, timed override)
      └── Island state
      ↓ show
Status Island window + system tray
```

`IslandController` (`apps/desktop/src/main/island-controller.ts`) only
collects what the application currently knows — usage, team run snapshots,
busy sessions, unread agent questions, failed tasks, finished runs, failed MCP
connections — and hands it to `StatusAttentionService`
(`packages/status/src/attention-service.ts`), which owns every priority
decision. No UI component decides on its own. Refresh runs on every domain
event plus a 2 s timer, so entries age out even when nothing happens.

## Priority

```text
100 user action required
 90 permission or security action
 80 agent blocked or critical error
 70 provider or MCP failure affecting work
 60 project or team completed
 50 important task completed
 40 active project or team progress
 30 agent activity
 20 provider usage
 10 idle
```

Automatic mode follows this order; the user can pin a widget instead, and
cycling steps through the entries that currently have something to say.

## Widgets

Built in (`packages/status/src/widgets.ts`), in tie-break order: Needs
Attention, Errors, Connection Health, Completed Work, Team Progress, Active
Agents, Provider Usage — plus Idle, shown when nothing has anything to report.
Each widget builds at most one entry or stays silent, and a finished run stays
news for 5 minutes before the island settles back. Plugins can register more
through `StatusAttentionService.register()`.

## Honesty

The island never fabricates progress. Team progress is derived from the task
graph; a solo session shows a semantic state such as Planning or Implementing,
not a percentage. Usage that is unknown is shown as unavailable.

## Window behaviour

Its own `BrowserWindow` (`StatusIslandWindow`): frameless and compact
(320×44), expands briefly (380×132, 8 s) for important new events, then
settles back. Draggable with the position persisted across restarts including
the display id, so it is multi-monitor aware; it follows the main window
unless told to stay, its lifecycle is independent of it, and it can be
disabled entirely. Its preload bridge (`workbenchIsland`) is deliberately
tiny: state, open, dismiss, cycle — nothing else.

## Theme

The island is drawn in the app's theme and mode and switches with them:
main pushes both on its own channel (`ISLAND_THEME_CHANNEL`) when they
change and whenever the island page loads. Each theme gives it a palette
per mode (`--island-*` tokens: dark in the dark modes, light in the light
ones), and its own hand in `island.css` → themes: Atelier's serif and a
terracotta ring in the bubble, Mission Control's square bubble, monospace
capitals and lit edge, Playground's thick ink, hard shadow and yellow
bubble, Aurora's violet-to-cyan ring and glow, Swiss's square, flat,
full-ink outline. It never takes the page's ink, which once put dark titles
on its dark card; a light island carries a longer shadow so it holds off a
light desktop. The contrast test measures every island palette, and the
startup check that the island follows theme and mode and its text reads.
With nothing running it shows the app's logo.

## Tray

`StatusTray` keeps background work reachable and controllable: generated glyph
(needs no packaged asset), click opens the app, menu shows the island, pauses
the autonomous runs, stops all work, or quits. Activity counts come from the
real session and run lists, not from island entries.

## Preferences

Persisted in settings (`statusIsland`): enabled, start-with-app, pinned and
default widget, enabled widgets, auto-expand, auto-rotate, position. Pinning
and cycling write back through the settings service.

## Not yet

- **Project activity** — no widget or source feeds project-level activity yet.
- **Display list** — the monitor follows a drag plus the persisted display id
  only; there is no display picker.
- **Provider-disconnect feed** — Connection Health currently reports failed
  MCP connections; provider disconnects are not fed in.
