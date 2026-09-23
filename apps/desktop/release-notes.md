AI Workbench 0.0.4

Every terminal agent on the status island
- Claude Code, Codex, OpenCode and Gemini CLI tiles tell the island when they wait for you, work or rest. The island shows the tool's own logo with Allow and Deny (and OpenCode's questions with their choices); the answer reaches the tool, and its own prompt in the tile keeps working.
- Gemini CLI needs a one-time setup: Providers → Gemini CLI → Status island → Set up. It installs a small extension with Gemini CLI's own installer, which asks you first.

Models and usage from the tools themselves
- OpenCode lists every model it can reach, with names, context sizes and reasoning efforts. Codex lists its models even before you sign in. Gemini CLI offers its own model names.
- The model picker (Ctrl+K) says which tool and provider a model belongs to and finds models by it. A tool whose list could not be read says why.
- Terminal tiles show tokens and cost for OpenCode and Gemini CLI sessions; OpenCode's usage works with its current release; Gemini CLI chats show tool calls and can be resumed.

New since 0.0.3
- Workspaces on another machine over SSH: browse, open, edit and save its files.
- The approved design for the main window, Settings, Providers, Usage and the island, which can be dragged and docked along any screen edge.
- Usage and live session numbers where the work happens.

Known limits
- Limits of real Codex, OpenCode and Gemini CLI accounts were not tested yet. Antigravity is not verified.
- Codex and Gemini CLI answer shell commands from the island; other approvals are answered in the tile.
