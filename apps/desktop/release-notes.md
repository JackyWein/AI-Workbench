AI Workbench 0.0.5

Connectors: sign in once, every agent can use it
- The Connectors screen is a catalog of services — mail, issues, docs and more. Pick one, sign in in your browser, and every chat session and terminal agent can use it, or only the workspaces you choose. Your own MCP servers are added the same way.
- Sign-in tokens stay in the system's credential store; the tools reach a service through a local gateway and never see them.
- Claude Code, Codex, Gemini CLI and OpenCode get the connectors you switched on, in chats, terminal tiles and team runs.
- Gmail and other Google services need your own Google OAuth client (Google does not let apps register one on the fly).

Skills: write, draft or bring them
- Write a skill yourself, have one of your tools draft it from a sentence, or import the skills you already made for Claude Code, Codex, Gemini CLI or OpenCode, a Markdown file or a whole folder.

Teams in a session
- Pick a team in the model menu of any session; it works in that session's workspace, can be edited, paused, resumed and stopped.
- The team view is new: the goal with a progress bar, the members with their state (pick one to follow only its work), a timeline that reads like a conversation, and the plan with every task beside it.

Attach files, images and screenshots
- The + in the message box (or drag and drop) sends files and images with a message, to every tool that can take them.

The status island
- Shows from the first start, says what each agent is doing and when it is done, and clicking an entry opens that tile or session.

SSH
- Private keys work: OpenSSH, PEM and PKCS#8 keys, with a passphrase, pasted or picked as a file, and the system's SSH agent. A key that cannot be used says why.

Updates
- The sidebar says when an update is out; a running app checks every six hours. Builds that cannot replace themselves (Windows portable, unsigned Mac, Linux .tar.gz) open the release page instead of hanging on "Checking…".

Fixed
- Providers froze when a tool had a second account.
- Tools started by the app wrote into the folder the app was started from instead of the workspace. OpenCode 2 works.
- Removing a workspace now stops the agents and team runs still working in it and removes their files.
- A connector could name a sign-in address that was not a web page; only web pages are opened now.
- The session shell's "Latest output" button stopped working after switching sessions.

Design
- Every screen shares one layout with its actions beside the title; the conversation is a little larger and says which tool and model answered; team cards and empty screens are clearer.

Known limits
- Real Codex, OpenCode and Gemini CLI account limits are still untested. Antigravity is not verified.
- Mac and Windows builds are not code signed.
