AI Workbench 0.0.7

Teams in every workspace, and every session starts fresh
- A team picked in a session works in that session's workspace, whichever workspace the team was made in.
- A new session starts its team without context: it shows none of another session's runs, and its first goal starts a run of its own — with its own tasks, messages and provider sessions. Before, a new session picked up the team's last run in the workspace and its next goal continued it.
- Within one session a finished run keeps its timeline: the next goal continues it, and the previous outcome stays readable.
- A team given a folder of its own says so next to the path ("team folder") — the one case where it does not work in the session's workspace.

Crashes are caught and recovered
- A failure in the app is logged and reported instead of taking it down; a window whose view crashed reloads, one broken view no longer blanks the whole window, and a crash report is kept.
- Team runs that were going when the app stopped come back paused, with Resume, instead of showing "Working" forever.

Memory and tools
- Agents are told when to use the shared memory — search before non-trivial work, save what the next agent would have to find out again, never secrets — and a team that finishes a goal writes it to the vault.
- Connectors → Import from your tools offers the MCP servers your installed tools are already configured with. Secrets in their variables and arguments are not copied; the app names them so you can set them.
- Sessions get their skills as a short list and load one when a task needs it.
- Team members now get the same servers and skills as a session: also the servers switched on for the run's workspace, signed-in servers with their sign-in, and the skills that are on, plus the ones picked for the member. Before, a member got only servers switched on everywhere, without their sign-in, and skills only if its tool speaks MCP.
- Gemini CLI, OpenCode and Antigravity now receive the skills and what the connected servers are for. They have no flag for instructions, so these were dropped; they now travel in front of the conversation's first message.
- Servers in a project's shared .mcp.json are offered for import even when Claude Code's own settings do not know the project.

The window
- A titlebar of its own in the theme's colours; chat and composer grow with the window; the window, taskbar and tray icon follow the theme.

Reasoning, shared memory and usage follow-up
- Pick the reasoning effort beneath the selected model in the chat picker. The list follows the levels that model or tool reports; Max and Ultra ask for confirmation and have different motion. The command palette uses the same choices.
- Connect a local Obsidian Markdown vault under Connectors → Discover. Agents with tool access can search short excerpts, read a selected note and add a new note to the same vault.
- The island shows every reported usage window, including 5-hour and weekly limits when available, one below another for each provider. This applies to the docked sheet and the free bubble card.
- Windows terminal shutdown no longer falls back to killing a process by a stale ConPTY process ID.

The shared vault works with Markdown files; Obsidian does not need to be running. A provider that cannot use MCP or tool calls cannot use the memory tools. The app does not invent a missing usage window.

Questions from terminals reach the island — every tool
- The island now reads a tool's dialog from its terminal screen, the way you do: the question, what it is about (the command it wants to run) and the tool's own options. That works for every tool, also one without hooks (Antigravity) and on machines where a tool's hooks do not run.
- Pick an option on the island and it is chosen with the tool's own keys: the arrows move its marker to your choice, and Enter is pressed only once the screen shows that option marked. If the dialog changed in the meantime, nothing is pressed.
- The tile says "Waiting for you" with the question. The island no longer shows a window title that is only the program's path (C:\Windows\…).

Teams that finish, and that you can follow
- A member was cut off after ten minutes of work, however busy it was; that is why runs ended with the builder still shown working. A turn now ends only after fifteen minutes in which the tool wrote nothing at all. Runs get four hours by default.
- Every turn of every member is kept: what it worked on, every step its tool reported, and everything it wrote. The team's timeline shows it as it happens; pick a member to read its whole story. It stays after a restart.
- The island says who is working on what right now, with the last step — not the goal the run started with.

A new team editor
- Members are cards: name, role and the tool they run on, picked by its logo, with the model underneath.
- Twelve ready roles — lead, builder, frontend, backend, reviewer, tester, designer, researcher, writer, DevOps, security, debugger — each with its own instructions that only that member gets, and that you can edit.
- New teams can start from a template: build and review, web app, bug fixing, research first.

Updates
- When an update has downloaded in the background, the window and the island ask: Restart now, or Later. Restart now installs it without the setup wizard and opens the app again; Later installs it when you quit.

Fixed
- Hovering a session you had not opened yet could take the window down. The details it shows no longer send React into an endless re-render.
- The model picker opens upward at the foot of the window, scrolls inside it, and is compact: your session's tool is open, the others fold to one line each.
- The chat box no longer draws a second ring around the text you type; Aurora's chat box has one outline.
- The opened island keeps its square corners in Swiss, and no island glow is cut off at the window's edge (Aurora).

Known limits
- Answering dialogs from the island was tested with real terminals on Linux, macOS and Windows and with stand-ins that draw each tool's dialog; the real Antigravity, and the real Codex, OpenCode and Gemini CLI accounts, were not run here.
- Updating from 0.0.6 arrives by version number; updates by commit apply from this release on.
- Mac and Windows builds are not code signed yet.
