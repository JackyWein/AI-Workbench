# Future features

Features the person asked for on 2026-09-25, each written out as how it could
be built into AI Workbench. They follow the rules in `CLAUDE.md`: provider
behaviour lives in adapters, secrets stay in the credential store and never
reach the renderer, provider-native permissions are respected, and nothing is
claimed that was not verified.

Each entry has:
- what was asked;
- where the code stands today (checked against the code on this date);
- how to build it;
- how to verify it;
- what stays open.

Sizes are rough: S is about a day, M a few days, L a week or more.

A suggested order is at the end.

---

## 1. Switch account automatically at a limit, and keep the whole chat (L)

**Asked:** when an account reaches its limit, switch to another account of the
same tool and carry on normally, with the full context.

**Today:**
- Claude Code and Codex can hold several accounts. An account is a
  configuration home that the tool is pointed at:
  - Claude Code: `CLAUDE_CONFIG_DIR`, see `packages/providers/claude/src/profile.ts`.
  - Codex: `CODEX_HOME`, see `packages/providers/codex/src/profile.ts`.
- Each account is its own provider entry with its own usage.
- Adapters report a limit as a normalized error of kind `rateLimit`
  (`packages/shared/src/events/provider-events.ts`).
- Usage snapshots carry per-window limits (`percentUsed`, `resetsAt`).
- A session is bound to one provider entry. Its conversation continues
  through the provider-native session id (`providerSessionId`). That id lives
  in the account's configuration home, so another account cannot resume it.

**How:**
1. **Account groups.** Accounts of one tool form a group with an order, for
   example *Work → Private → Team*. The session keeps its provider family and
   records the entry it currently runs on (`session.providerId` stays the
   entry, and a new `accountGroup` is added). Settings: "When an account
   reaches its limit: switch to the next / ask me / stop".
2. **When to switch.** Two triggers:
   - **Reactive:** a turn ends with a `rateLimit` error.
   - **Proactive:** the tightest usage window is at 95 % or more before a turn
     starts, and the tool reported that window. Nothing is guessed.
3. **Carrying the context, best first:**
   - **Native transfer (adapter capability `transferSession`).** Where the tool
     keeps its conversation as a file in the account home, the adapter copies
     it into the new home and resumes it there. Claude Code keeps
     `projects/<cwd>/<session>.jsonl` under `CLAUDE_CONFIG_DIR`, so resume
     works with the full native history, tool results included. This lives
     only in the tool's own package, never in core.
   - **Handover by the application (fallback for every tool).** The session
     manager starts a new provider session on the new account. The first turn
     carries the conversation from the application's own database: the last
     N messages verbatim, and older ones as a summary written once by the
     same model. The summary is cached per session so it is not paid for
     twice.
4. **What the person sees.**
   - The chat stays one chat.
   - A quiet marker in the timeline: "Continued on *Private* — *Work* reached
     its 5-hour limit (resets 14:30)".
   - The island shows the switch once.
   - The model pill names the account.
5. **Teams.** The orchestrator's per-member provider session gets the same
   treatment. A member whose account is at its limit moves on, and its turn
   is retried once on the new account.
6. **Guards.**
   - Never switch into an account that is also at its limit.
   - Never switch into a different tool without asking. A different tool is a
     different product, with other permissions and other costs.
   - The last account at its limit stops the session and says when the
     earliest window resets.

**Verify:**
- Mock provider with two accounts, where the first returns `rateLimit` after
  one turn. A startup check sends two messages and asserts:
  - the second answer comes from account B;
  - the timeline marker is there;
  - `/context` on B shows the first exchange (handover).
- An adapter test for the Claude file transfer against a recorded session
  folder.

**Open:**
- Whether every tool can resume from a copied transcript has to be verified
  per tool. Until then the application handover is the default.
- Gemini CLI, OpenCode and Antigravity need multi-account support first
  (feature 3).

---

## 2. Connect GitHub directly: commit, push, pull, pull requests (M–L)

**Asked:** connect GitHub so work can be committed, pushed and kept up to date.

**Today:**
- The workspace has git status and per-file diffs (`packages/workspace-git`,
  IPC `git.status`, `git.diff`, the Changes panel).
- Since 0.0.7 the team timeline shows what each member's turn changed.
- The connector catalog offers GitHub's MCP server
  (`api.githubcopilot.com/mcp`) with a personal access token. That gives
  agents GitHub tools, but gives the application no git write path.

**How:**
1. **Sign-in:** GitHub's OAuth device flow, with a GitHub App or OAuth App
   owned by the project.
   - No token is pasted by hand. The browser opens, the person confirms the
     code, and the token goes into the credential store (`kind:
     "github"`). Only a reference reaches the renderer.
   - A fine-grained PAT stays possible as a fallback, and is stored the same
     way.
2. **Git with the token, without writing it anywhere:**
   - Pushes and pulls run `git` with `GIT_ASKPASS` set to a small helper
     shipped with the app. The helper asks the main process for the token
     over a one-time local channel, the same way the MCP gateway hands out
     sign-ins.
   - The token is never written into `.git/config`, a remote URL or the
     environment of an agent.
3. **Workspace panel "Source control":**
   - stage and unstage per file or hunk (the diff view already exists);
   - commit message, where "Suggest message" asks the session's model from
     the staged diff;
   - commit, pull (fast-forward or rebase, chosen in settings), push, create
     a branch;
   - ahead and behind counts, which come from `git status` already.
4. **Pull requests:**
   - "Open pull request" uses the GitHub REST API with title and body (the
     model can draft the body from the diff);
   - the PR's checks and review state show in the panel;
   - the island says when checks finish.
5. **Agents:**
   - The GitHub MCP connector gets the same stored token, so agents can use
     GitHub tools without a second sign-in.
   - Whether an agent may push stays the tool's own permission. The app adds
     no silent push.
   - A team can end a goal with "open a PR", which is shown as a decision the
     person confirms.

**Verify:**
- Git tests against a local bare repository as the remote: commit, push and
  pull, and no token appears in `.git/config` or process listings.
- A startup check with a local fake GitHub API for the PR call.
- The device flow is tested against a fake authorization server, like the
  existing OAuth MCP test server.

**Open:**
- Registering the GitHub App (client id).
- Enterprise hosts can be added later with the same flow.

---

## 3. Several accounts for every tool, and their limits always visible (M)

**Asked:** multiple accounts for all current providers, and always see each
account's limits reliably.

**Today:**
- Claude Code and Codex have accounts, through `accounts.homeVariable` in
  their profiles.
- Gemini CLI, OpenCode and Antigravity have none.
- Usage per account:
  - Claude: the status line gives 5-hour and weekly windows.
  - Codex: the app server gives rate limits, but only when signed in.
  - OpenCode: `opencode stats`, consumption only.
  - Gemini CLI and Antigravity: nothing verified.

**How:**
1. **Profile data per tool** (no code in core), each verified against the
   real tool before it is ticked:
   - Gemini CLI: its settings and credentials live in `~/.gemini`. Check
     whether the tool honours a home override. If it does not, run each
     account with its own `HOME`/`USERPROFILE` set only for the tool's
     process.
   - OpenCode: credentials are kept under the XDG data directory
     (`auth.json`). An account is an `XDG_DATA_HOME` (and `XDG_CONFIG_HOME`)
     of its own.
   - Antigravity: find where `agy` keeps its sign-in, then the same pattern.
2. **Limits, always and honestly:**
   - The Usage screen shows one row per account. Each row shows:
     - every window the tool reported, with its reset time;
     - where the numbers came from ("status line", "app server", "stats");
     - how old they are.
   - A tool that reports nothing says "not reported by this tool". It never
     shows a zero.
   - Background refresh per account on a slow timer, and on focus. It never
     starts a paid turn just to read limits.
   - The island's usage widget stacks the windows of the active account, and
     shows the others on hover or focus.
3. **Account picker:** one pill in the composer, "Claude · Work ▾", listing
   each account with its tightest window. This is the same data feature 1
   uses to decide where to switch.

**Verify:**
- Profile tests per tool: the environment reaches the process, and the
  account home is detected from its marker files.
- Real-account checks on the person's machine, with a script like the
  existing real-account check.

**Open:**
- Which tools report limits at all is the tools' decision. Gemini CLI and
  Antigravity may only ever show consumption.

---

## 4. Take over MCP servers from connected apps, safely, for every agent (S–M, partly done)

**Asked:** import the MCP servers that already exist in connected apps, so
all agents and workflows can use them.

**Today (0.0.7):**
- **Connectors → Import from your tools** reads:
  - Claude Code: global, project, and the project's `.mcp.json`;
  - Claude Desktop;
  - Codex (`config.toml`);
  - Gemini CLI (`settings.json`).
- Imported servers are on "everywhere". They reach solo sessions, terminal
  agents and team members, and are verified end to end by a startup check.
- Secrets in variables and arguments are **not** copied. They are named, so
  the person can enter them again. Header keys of remote servers go into the
  credential store.

**Still to build:**
1. **Secrets moved, not dropped.**
   - A secret variable of a stdio server is stored in the credential store.
   - The saved config keeps only a reference (`env: { API_KEY: "cred:…" }`).
   - The main process resolves it only when it starts the server, or when it
     hands the server to a tool.
   - The renderer only ever sees "••••, stored securely".
   - Arguments that carry secrets are rewritten to read the variable, where
     the server supports that. Otherwise they are named, as now.
2. **More sources:**
   - OpenCode (`opencode.json` → `mcp`);
   - Antigravity (`mcp_config.json`);
   - Cursor (`~/.cursor/mcp.json`);
   - VS Code (`.vscode/mcp.json`);
   - Windsurf.

   Each source is read in the tool's own package, where a package exists.
3. **Keep in sync:**
   - A quiet notice when a tool gains a server that is not imported yet.
   - "Update" when an imported server changed at its source.
   - A server's origin stays visible on its card.
4. **Scope on import:** everywhere, this workspace, or chosen workspaces. The
   default stays "everywhere", as asked.

**Verify:**
- Unit tests per source format.
- A startup check that imports a server with a secret variable and asserts
  all of these:
  - the server connects;
  - the database row holds a reference only;
  - the renderer payload has no value.

---

## 5. Scheduled tasks: agents that run on a schedule, made by hand or by AI (L)

**Asked:**
- create agents, or have them created by AI, including from within a
  session;
- those agents run on a schedule.

**Today:** nothing scheduled exists. Sessions, teams and terminal agents all
run on demand.

**How:**
1. **Domain.** A `schedules` table:
   - `id`, `name`, `enabled`;
   - `workspaceId`;
   - a `target`, which is one of:
     - a solo session (provider, model, effort);
     - a team;
     - an agent terminal;
   - `prompt`;
   - `cron` and `timezone`;
   - `catchUp` (`skip` or `run once`);
   - `budget`: maximum turns and tokens for each run;
   - `permissionMode`;
   - `lastRunAt`, `nextRunAt`.

   A `schedule_runs` table records each run: its session or team run, status,
   usage and error.
2. **SchedulerService (main process).**
   - It computes `nextRunAt` from the cron expression, with a small, tested
     parser or a vetted dependency.
   - One timer covers the earliest due run. It is re-armed after sleep and
     resume (`powerMonitor`).
   - A run creates or reuses its session ("Every morning: dependency check —
     25 Sep") and sends the prompt.
   - Runs happen while AI Workbench is running, which the tray keeps alive.
     The UI says so honestly. OS-level scheduling (Task Scheduler, launchd,
     systemd timers) can come later as an option.
3. **Permissions.**
   - A scheduled run cannot ask anyone mid-way. The schedule carries an
     explicit permission mode that the person chose.
   - Approvals the tool still asks for go to the island and wait. They are
     never auto-approved.
   - The budget stops the run.
4. **Created by AI.**
   - An application MCP server (next to the skills and memory servers)
     offers `schedule_propose`.
   - An agent in any session can propose a schedule (name, target, prompt,
     cron) from a conversation like "check the dependencies every Monday at
     9".
   - The proposal appears as a card in the chat: **Create** / **Edit** /
     **Dismiss**. Nothing is created without the person's click.
   - The Schedules screen also has "Draft with AI", with provider and model
     choice (see feature 8).
5. **UI:**
   - a Schedules screen with each schedule's next run, last result, and
     "Run now";
   - the island widget "Scheduled" shows what runs next and what just
     finished;
   - results open the session they ran in.

**Verify:**
- Unit tests for cron and time zones, including daylight-saving switches and
  missed runs after sleep.
- A startup check with a schedule due in 5 seconds on the mock provider. It
  asserts:
  - the run starts on time;
  - the session holds the answer;
  - `schedule_runs` records it;
  - a proposal from `schedule_propose` creates nothing until confirmed.

---

## 6. Voice input (M)

**Asked:** speak instead of typing.

**Today:** there is no voice input. The renderer's content security policy
allows only `'self'` connections.

**How:**
1. **Local speech recognition by default.**
   - Whisper (multilingual, German included) runs on-device through
     `transformers.js` / ONNX Runtime Web (WebGPU, falling back to WASM), in
     a worker.
   - No audio leaves the machine.
   - The model (whisper-base, about 80 MB, or small, about 250 MB, chosen in
     settings) downloads once on first use with visible progress, is checked
     against a pinned hash, and is kept in user data.
   - Chromium's built-in `SpeechRecognition` is not an option: in Electron it
     needs Google API keys and sends audio away.
2. **Microphone:**
   - Electron's `setPermissionRequestHandler` allows `media` (audio only) for
     the main window, and nothing else.
   - A clear recording state in the composer, which stops on Esc or when
     focus is lost.
3. **Interaction:**
   - Push-to-talk (hold a key, default `Ctrl+Space`) or a toggle button in
     the composer.
   - The transcript lands in the composer for review and is never sent
     automatically.
   - Works for notes to a team and goals, too.
4. **Optional cloud transcription** for people who prefer it: a provider's
   transcription API with the key in the credential store, opt-in and
   labelled.

**Verify:**
- A unit test feeding a recorded WAV file to the worker and checking the
  transcript.
- A startup check using a fake microphone stream (Chromium's
  `--use-file-for-fake-audio-capture`) that asserts text reaches the
  composer.

**Open:**
- Model size against quality on slower machines.
- A push-to-talk key that works while the window is not focused (a global
  shortcut) is a later choice.

---

## 7. Team templates built by an AI assistant (M)

**Asked:**
- describe the kind of team you want, and an assistant drafts it;
- the draft is the members' templates — who does what — not a running team.

**Today:**
- The team editor has 12 fixed role presets and 4 fixed team templates
  (`apps/desktop/src/renderer/lib/team-roles.ts`).
- Presets and templates are code. There are no templates of the person's
  own.

**How:**
1. **Stored templates.** A `team_templates` table (or settings entry) holds:
   - name, summary;
   - members: each with name, role, instructions, and a suggested tool and
     model with effort;
   - lead index.

   The built-in templates stay, and the person's own appear next to them.
   Templates can be edited, duplicated, exported and imported as JSON.
2. **Assistant.**
   - "Draft a team" in the editor: a text field ("a team that builds and
     tests Unity games, one member only reviews performance"), plus a
     **provider and model** choice (feature 8).
   - The main process asks that model for a JSON template that follows a
     schema (the same mechanism as `skill.draft`), validates it with zod, and
     returns it for review.
   - Nothing is saved until the person clicks **Save template**.
   - Instructions follow the rules of the presets: they say how to work,
     never which tool to use.
3. **Using templates.** "New team → from template" fills the existing editor,
   just as the built-in templates do today.

**Verify:**
- A unit test for the schema and validation (a bad draft is refused with a
  reason).
- A startup check drafting with the mock provider. It asserts the preview
  shows members, and that nothing is stored before Save.

---

## 8. Choose the model — not only the provider — when drafting skills (S)

**Asked:**
- the skill builder offers the provider but not the model, which makes no
  sense;
- the team builder must not repeat that.

**Today:**
- IPC `skill.draft` already accepts `modelId`
  (`packages/shared/src/ipc/contract.ts`).
- The "Draft with AI" panel only offers provider buttons
  (`.provider-choice`), so the tool's default model is used.

**How:**
- Replace the provider buttons with the compact model picker used in the
  composer (`ModelPicker`): tools grouped, models listed, and effort where
  the model has levels.
- Pass `modelId` and `reasoningEffort` through.
- Remember the last choice per drafting purpose (skills, team templates,
  schedules).
- Reuse the same component in features 5 and 7, so every "made by AI" flow
  offers the same choice.

**Verify:** a startup check picking a specific mock model. It asserts that
the draft reports that model, which the mock can echo.

---

## Further ideas

These come from building the features above, where the same parts would be
reused.

### A. Undo a turn (M)

**Idea:** the team diff feature already snapshots the folder before and after
every member's turn. Keep those snapshots, and offer **Undo this turn** on
each diff entry. The same works for solo sessions.

**How:**
- The restore writes only the files that turn changed back from the
  snapshot.
- It refuses when a file changed again since, and shows why.
- The index, HEAD and branches are never touched.

### B. A git worktree per team member (M)

**Idea:** parallel members editing one folder is why a diff can only say
"some of this may be another member's". With an option "Separate worktrees",
each member works in its own `git worktree` on a run branch.

**How:**
- The lead merges when tasks finish, and conflicts become tasks.
- Attribution becomes exact, and members stop overwriting each other.

### C. Diffs for solo sessions too (S)

**Idea:** use the same snapshots around each turn of a solo session, so the
chat shows what the answer changed in the project.

**How:** one collapsible diff under the answer.

### D. Budgets per run and per schedule (S–M)

**Idea:** a token, cost or turn limit for a team run or a schedule. The run
pauses at the limit with a note.

**How:** use only what the tools report. When a tool reports nothing, the
budget counts turns.

### E. Usage forecast on the island (S)

**Idea:** "At this pace the 5-hour window is used up at 14:10".

**How:**
- Computed from the reported windows and the last hour's consumption.
- Only shown when there is enough reported data.
- Feature 1 can use it to switch before a turn fails.

### F. A secret check before anything leaves (S)

**Idea:** scan text for token patterns before it leaves:
- a note written to the shared memory (`memory_add`);
- a commit (feature 2);
- a skill or template export.

**How:** warn with the finding, and never send it silently.

### G. Fork a session to another tool (M)

**Idea:** "Continue this conversation in Codex", using the same handover as
feature 1 (recent messages plus summary).

**How:** the new session starts with the context. The original stays as it
was.

### H. Per-workspace memory next to the shared vault (S–M)

**Idea:** project notes that only agents in that workspace see, next to the
global Obsidian vault.

**How:** a folder `.workbench/memory` or a sub-folder of the vault per
workspace, served by the same memory server with a scope.

### I. Shared memory: from notes to a knowledge graph (M)

**Where it stands (0.0.7):**
- The Obsidian vault is the agents' long-term memory, served by the bundled
  server with `memory_search`, `memory_read` and `memory_add`.
- It reaches sessions, terminal agents and team members.
- The graph view draws `[[links]]`.

**What limits it:**
- Search is a word scan over the files.
- Agents can only add notes. They cannot update, merge or link, so
  duplicates grow and the graph stays sparse.
- Tools used outside the app do not see it, except Antigravity.

**Next steps:**
- `memory_update` and `memory_append`, which refuse when the note changed
  since it was read (mtime check).
- Links suggested on save: the notes a search finds for the new note's topic
  are added as `[[links]]`, so the graph grows meaning.
- A search index kept in SQLite (FTS5), rebuilt from the files. The vault
  stays the source of truth, and the index only makes search fast and
  ranked. Embeddings can come later.
- The secret check (**F**) on `memory_add`.
- **Use in my tools:** registers the memory server in Claude Code, Codex and
  Gemini CLI through each tool's own `mcp add`. It is opt-in, and only the
  application's marked entry is ever changed, as for Antigravity today.

---

## Suggested order

1. **8** — small, and the other AI-built flows reuse it.
2. **4**, remaining part — secrets moved rather than dropped; more sources.
3. **3** — accounts for every tool, with limits.
4. **1** — auto-switch, which builds on 3.
5. **2** — GitHub, with **F** alongside.
6. **7** — team templates by AI.
7. **5** — schedules, with **D** alongside.
8. **6** — voice input.
9. The further ideas, as they become useful: **A** and **C** directly after
   2; **B** after 1; **I** whenever the memory is in daily use.
