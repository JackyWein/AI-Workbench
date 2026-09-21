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

### Not done

1. **Command palette entries for the island.** This is literally where the
   session stopped: `apps/desktop/src/renderer/components/CommandPalette.tsx`
   was open to add "Show/Hide Status Island", "Cycle island widget" and
   "Pin: …" commands. The store actions they need already exist
   (`cycleIslandWidget`, `setIslandPreferences`). Spec §100 asks for click,
   scroll, keyboard and palette; only the palette route is missing.
2. **No startup check for the island yet.** Every other G6 claim will need one
   before `PROGRESS.md` can tick it. The pattern to copy is the team check in
   `apps/desktop/src/main/startup-check.ts`: drive the real thing, assert on
   state the application actually holds, never on a selector alone.
3. **`PROGRESS.md` has no G6 criterion ticked.** That is deliberate. Do not tick
   any of the 22 until `pnpm verify` proves it. The island code compiles and
   the service is tested, but the window, the tray and the deep-link have not
   been exercised in a running application.
4. `packages/status` is not yet listed in `PROGRESS.md`'s verification section.

## What to do first

1. Run `pnpm verify` and confirm it is green on your machine.
2. Open the app with `pnpm dev`, turn the island on in Settings, and see it.
   Nothing in G6 should be ticked before a person has actually looked at it.
3. Finish the palette commands (item 1 above).
4. Write the island startup checks and tick G6 from what they prove.

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
