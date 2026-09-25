AI Workbench 0.0.8

Teams sessions no longer freeze or crash over time
- The island no longer re-reads every team snapshot on each token or heartbeat: streaming and progress events never trigger a full refresh, event refreshes are throttled. This was blocking the main process in long sessions.
- The team view no longer reloads the full run snapshot on every event and poll: reloads are guarded and throttled, the poll is slower and pauses while the tab is hidden, and the timeline renders the newest 100 entries with older ones loading on demand.
- Agent prompts stay bounded no matter how long a run lives: only the newest entries travel, each truncated, under a total cap. Before, the prompt grew without bound and could take the provider call down.
- A turn whose provider, MCP or skills lookup hangs no longer hangs forever: each setup step has a timeout and the turn continues degraded.
- Cancelling a session always frees it again, even when the provider ignores the cancellation. Closing a terminal reports its exit, so agent tiles no longer stay "working" forever and no zombie terminals survive.
- Deleting a workspace also stops its team runs, and the team undo channel works again.

The window
- A titlebar of its own in the theme's colours; chat and composer grow with the window; the window, taskbar and tray icon follow the theme.
- Pick the reasoning effort beneath the selected model in the chat picker. The list follows the levels that model or tool reports; Max and Ultra ask for confirmation and have different motion. The command palette uses the same choices.

Memory and usage
- Connect a local Obsidian Markdown vault under Connectors → Discover. Agents with tool access can search short excerpts, read a selected note and add a new note to the same vault. A team that finishes a goal writes it to the vault.
- The island stacks every reported usage window, including 5-hour and weekly limits when available.

Fixed
- Hovering a session you had not opened yet could take the window down. The details it shows no longer send React into an endless re-render.
- The model picker opens upward at the foot of the window, scrolls inside it, and is compact: your session's tool is open, the others fold to one line each.
- Windows terminal shutdown no longer falls back to killing a process by a stale ConPTY process ID.

Known limits
- The real Antigravity, and the real Codex, OpenCode and Gemini CLI accounts, were not run here.
- Mac and Windows builds are not code signed yet.
