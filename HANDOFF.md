# Handoff

For whoever picks this up next. `PROGRESS.md` is the authoritative record of
what is verified; this file only says where things stand and what will bite
you. The long day-by-day history that used to live here is in git
(`git log -- HANDOFF.md`).

Everything is on `claude/repo-setup-instructions-8tgcbw`. The design rollout
branch `design/approved-rollout` is merged into it and can be deleted.

## Where things stand (2026-09-24, release 0.0.6)

`bun run verify` passes end to end: lockfile, lint, typecheck, 882
tests (20 real-tool tests skipped without their tools), the build and both
startup phases (200 checks, none failing).

0.0.6 was first published from `0420668` with one mode per theme and
replaced the same day, at the person's request, by a build of this state
(same version, same tag moved; an install of the first build is not
offered the second). In it **every theme has a light and a dark mode.**
The setting is split into `theme` (Quiet, Atelier, Mission
Control, Playground, Aurora, Swiss) and `mode` (system, light, dark);
0.0.6's single choice is read through `upgradeStoredSettings`, so nobody's
look changes on update. Settings has a Mode control under the theme picker,
whose swatches show each theme light and dark; the command palette has
"Theme: …" and "Mode: …". The contrast test and the startup check cover
all twelve. How it is put together: `DEVELOPMENT.md` → Themes.
The mode defaults to System for a new install (an existing one keeps what it
had) and has a toggle in the sidebar head. The island follows theme and mode
with a palette per mode and a style per theme (`STATUS_ISLAND.md` → Theme);
light islands are new, so how they sit on a real light desktop is worth a
look on the person's machine.

Also in 0.0.6 over 0.0.5, each verified by tests and the startup check:

- **Themes.** A picker under Settings (Quiet in dark, light and system;
  Atelier, Mission Control, Playground, Aurora, Swiss in one mode each),
  also in the command palette. A theme is token values only; how they are
  laid out and how to add one is in `DEVELOPMENT.md` → Themes. Every raw
  colour and radius in the components became a token for this, the
  sidebar, code blocks and the island rebind the tokens to palettes of
  their own, and terminals follow the theme live (`followTheme` in
  `renderer/lib/xterm.ts`). Typefaces are bundled from `@fontsource`
  (Latin only, ~470 KB). A contrast test resolves every theme from the CSS;
  the startup check picks each one in Settings and checks the window, that
  its face loaded and that the island followed. The screenshots behind
  `docs/images/themes.png` were reviewed view by view in every theme; that
  a theme *looks* right stays the person's call.
- **The logo** (`AppLogo`, the icon's geometry in the theme's logo colours)
  replaces the "W" on the start screen (it draws itself in), in the
  sidebar, on the welcome screens and on the island at rest.
- **Markdown answers** (`renderer/lib/markdown.ts`, an AST rendered as React
  elements, never HTML), a team session opening as its team after a restart,
  the island's text on a light system theme, and a stored skill or plugin
  that no longer parses no longer stopping the start.

Since the re-published 0.0.6 (not released yet):

- **Updates by commit, in the background.** Each build knows the commit it
  was made from (`BUILD_COMMIT`, `apps/desktop/src/main/build-info.ts`, set
  in `electron.vite.config.ts` from `GITHUB_SHA` or the checkout), and the
  release job writes the commit into `latest*.yml` (`commit:`). A release
  is an update when its version is newer or, for the same version, its
  commit differs (`isNewerBuild`; electron-updater's own gate, which only
  compares versions, is wrapped by `acceptNewBuilds`, tested against the
  installed package's class). Builds that go to the release page compare the
  release's `target_commitish`. With the new setting `autoUpdate` (on by
  default) an update downloads in the background and installs when the app
  quits; the app checks hourly. Nothing of this was run against a real
  published release yet: 0.0.6 builds lack it, so the first release carrying
  it arrives by version, and only the one after that can arrive by commit.
- **Signing is ready, certificates are not.** The release job signs and
  notarizes on macOS and signs on Windows (a `.pfx` or Azure Trusted
  Signing) when the secrets in `SIGNING.md` exist, and builds unsigned as
  before when they do not. Not run with real certificates: the project has
  none. A Mac build made with a certificate updates itself (`SIGNED_MAC`).

What changed in 0.0.5 (built from `d318d08`):

- **Connectors** replace the MCP and Plugins screens: a catalog
  (`packages/shared/src/catalog/connectors.ts`), OAuth sign-in in the
  browser (`packages/mcp/src/oauth.ts`: RFC 9728/8414/7591 discovery and
  registration, PKCE, loopback redirect, tokens only in the credential
  store) and a local gateway (`packages/mcp/src/gateway.ts`) that every
  tool reaches: `/mcp/<id>` with a bearer key, and a combined
  `/mcp-all/<capability>` endpoint for tools that scrub credential-like
  environment variables (Gemini CLI's extension bridge). Checked against
  all four real CLIs with a local OAuth test server. Google services need
  the person's own OAuth client (no dynamic registration at Google).
  Only https (or loopback http) sign-in pages are ever opened.
- **Skills**: write, draft with one of the person's tools
  (`packages/core/src/skill-drafter.ts`, a read-only turn in a scratch
  folder), or import from the tools' skill folders, a Markdown file or a
  folder.
- **Teams in a session**: picked in the model menu, work in the session's
  workspace, editable. The team view was redesigned (`TeamSessionView`,
  `TeamPanel`, shared pieces in `TeamParts.tsx`).
- **Attachments** (`packages/core/src/attachments.ts`): copied into
  `userData/attachments/<session>/`, handed to each tool with its own flags
  (profile `attachments`).
- **SSH keys** (`packages/workspace-ssh/src/keys.ts`): OpenSSH, PEM and
  PKCS#8 keys, passphrases, key files, the SSH agent.
- **Updates**: sidebar notice, six-hourly check, release page for builds
  that cannot replace themselves.
- **Removing a workspace** first stops its team runs and deletes its
  sessions the normal way (`removeWorkspace` in `packages/core`).
- **Cleanup** from `npx fallow dead-code` (config in `.fallowrc.json`):
  the remaining findings are calls through `Pick<...>` types and registry
  APIs, not dead code. The Claude and Codex profiles in
  `packages/providers/cli/src/profiles.ts` are stale copies still used by
  the CLI adapter tests; the shipped ones live in the provider packages.
  Moving those tests next to the shipped profiles is open.
- **Design pass** in two commits starting with "Design:" (one page frame,
  conversation size and signature, team cards, empty screens). The state
  before them is the branch `backup/before-design-pass`; reverting the two
  commits undoes it.

## README screenshots

`docs/images/` holds the README's pictures: demo data (a small shop project
in `/home/alex/projects`, a conversation, a running team, skills) written
straight into a fresh database, the app started as that user with a clean
environment, and each view captured over the DevTools protocol at 1440×900
and twice the pixel density, then scaled to 2160 px wide. The island picture
is the real island, with a stand-in for Claude Code asking for a permission,
laid over a blurred agents view. `themes.png` is the conversation in the six
themes, each picked in Settings and cut on a slant between its light and
dark mode. Retake them the same way
when a view changes; the README says they show demo data.

## How to run it

```bash
bun install          # bun 1.3.11 and Node 22; postinstall fixes node-pty's spawn-helper
bun run dev          # the app in development
bun run verify       # lockfile + lint + typecheck + test + build + verify:app
```

`verify:app` needs bash and a display (Xvfb on Linux); it cannot run on plain
Windows. Nothing in `PROGRESS.md` is ticked from a Windows-only run.

Screenshots for a visual review:

```bash
AI_WORKBENCH_STARTUP_CHECK=1 AI_WORKBENCH_CHECK_MODE=create \
AI_WORKBENCH_CHECK_DATA_DIR=/tmp/wb/data AI_WORKBENCH_CHECK_WORKSPACE=/tmp/wb/ws \
AI_WORKBENCH_CHECK_SCREENSHOT=/tmp/wb/shots/shot.png \
xvfb-run -a -s "-screen 0 1440x900x24" node_modules/.bin/electron --no-sandbox apps/desktop/out/main/index.js
```

## What is not built yet

1. **Antigravity (`agy`)** could not be installed or read about here; it has a
   profile, no island channel, and stays marked unverified. A team agent's
   question still appears as a waiting entry whose Approve only opens the run.
   Codex and Gemini CLI answer only shell commands from the island; their
   other approvals show there and are answered in the tile.
2. **Agents in a remote workspace.** Files on another machine can be browsed,
   opened, edited and saved over SSH. Git reports "no repository" there and a
   terminal still opens on this computer, so agents cannot work remotely yet.
   `AI_WORKBENCH.md` has no section for remote workspaces.
3. **The island's real drag** through the OS cursor has only been unit-tested
   and rendered headlessly.
4. **The screens outside the approved design.** Connectors, Skills and
   Teams were rebuilt and share the page frame of Settings and Providers,
   but there is no approved mock for them; their look is the author's call
   until the person signs it off.
5. **Packaging.** A Linux unpacked build under bun was started and passed the
   startup check; a clean install elsewhere was not run. The 0.0.3 release
   run failed on every platform because electron-builder published by itself
   when it saw the tag, without a token; the package step now passes
   `--publish never` and the release job alone publishes. CI now also
   installs, typechecks, tests and packages (unpacked, never published) on
   Windows and macOS on every push, so a platform difference shows up there
   first; its first run found a macOS-only SSH path bug, since fixed.
   A release can be started without pushing a tag: Actions → Release →
   Run workflow tags the built commit with the application version, and
   running it again for the same version replaces that release's files;
   run from a newer commit, it deletes the earlier release and its tag and
   publishes the version again from the commit it built (how 0.0.6 was
   replaced). This session's git proxy refuses tag pushes, so a tag is only
   ever moved this way.
   Release file names carry no space: GitHub stores "AI Workbench-x" as
   "AI.Workbench-x" while latest*.yml names "AI-Workbench-x", so the
   updater of 0.0.4's first upload found nothing to download.
   On GitHub's Windows runners every start of the test application (a
   database and its migrations, nothing else) takes about 14 s against
   milliseconds on Linux, so Windows tests get 120 s instead of 30 s. Why
   was not found from here; worth timing the packaged app's first start on
   a real Windows machine.

## Things that will bite you

- **Claude Code runs with extra hooks.** Every tile's `--settings` file adds
  hooks next to the person's own (Claude Code merges them). Only the
  permission hook waits — for an answer file from the application, for a
  "withdrawn" note, or for Claude Code to end it — and it prints the answer
  as is; the others run with `async: true`. The measured behaviour this relies
  on is written at the top of `attention.ts`; re-measure after a major Claude
  Code update with `real-claude-attention.test.ts`.
- **Running the real Claude tests in a fresh environment.** A first start of
  Claude Code shows a theme picker and, per folder, a trust question; the
  test answers the trust question itself, but onboarding must be done (or
  `CLAUDE_CONFIG_DIR` pointed at a configuration with
  `hasCompletedOnboarding`). Inside a Claude Code session, remove that
  session's own `CLAUDE_*` variables first, or the child talks to it.
- **The test SSH server now ends its connections when closed.** Before, the
  startup check waited five minutes per phase for the application's idle SSH
  connection to let go.
- **The startup check only logs at the end.** A check that hangs leaves a log
  with no PASS/FAIL lines at all. Every check has a time limit; a hidden
  window never answers `capturePage`, which is why the island capture has one.
- **Diagnose, do not guess.** When a check fails with `detail: false`, make it
  return a string describing what it saw (the detail is logged) and rerun one
  phase against a copy of the data directory. That is how every failure above
  was found.
- **The island hides while the main window has focus.** Checks that need it
  blur the main window first.
- **A waiting question outranks news on the island**, and nobody can answer
  one inside the application yet, so a question asked in the first phase is
  still waiting in the second. The failing-team checks are ordered and split
  by phase because of this.
- **The simulated provider** appears on the island only in developer mode.
- **Secrets on a machine without a keyring.** The application refuses to store
  a secret the operating system cannot protect. Only the verification run, on
  such a machine, uses `CheckEncryption` (really encrypted, key beside the
  throwaway check database).
- **bun and the install layout.** `bunfig.toml` keeps `node_modules` flat, as
  `.npmrc` did under pnpm; Electron and the native modules rely on it. If lint
  fails with `Cannot find module …/uri.all.js`, the local install is damaged:
  remove `node_modules` and install again.
- **Electron downloads its binary on first start** if it is missing; run
  `node node_modules/electron/install.js` to fetch it ahead of time.
- `opencode was not found` is logged every few minutes when OpenCode is not
  installed: the usage reader asks a tool that is not there. Noise, not a
  failure.
- **Each tool's channel is different, on purpose.** Claude Code and Codex get
  hooks per run (`--settings`, `-c hooks.*`); Codex asks the person once to
  trust them, so their command must never change between runs (the run's
  folder travels in `AI_WORKBENCH_HOOK_DIR`). OpenCode is read from the server
  its own interface starts (`--port`, `OPENCODE_SERVER_PASSWORD`). Gemini CLI
  only takes hooks from settings root owns or from an extension; the island
  uses an extension the person installs once, versioned in
  `packages/providers/gemini/src/attention.ts` — raise its version when its
  files change, so an update is offered.
- **Answers typed as keys** (Codex `y`/Esc, Gemini `1`/Esc) wait 1.5 s after
  the request so the tool's dialog is up, and re-read that it still waits.
- **OpenCode through a pipe loses the end of its output** when it exits (the
  long `models --verbose` list arrives cut at a different length each time),
  so its plain list says which models exist. **Two OpenCode processes started
  together in a fresh data folder collide** setting up its database; the
  OpenCode package runs its commands one at a time. On a first ever start the
  app may still start a tile or turn alongside, which can fail once.
- **OpenCode 2.0.13** is what the earlier OpenCode code was written against
  (`opencode api`, `stats --json`); npm's release is 1.18.32, which has
  neither. Both paths are kept and tried first.
- **Real-tool tests** (`real-{claude,codex,opencode,gemini}-attention.test.ts`)
  each need their tool installed and a variable set (see `PROGRESS.md`); all
  but Claude's use a local stand-in model and no account.
