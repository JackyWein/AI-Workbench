AI Workbench 0.0.7

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
- The model picker opens upward at the foot of the window, scrolls inside it, and is compact: your session's tool is open, the others fold to one line each.
- The chat box no longer draws a second ring around the text you type; Aurora's chat box has one outline.
- The opened island keeps its square corners in Swiss, and no island glow is cut off at the window's edge (Aurora).

Known limits
- Answering dialogs from the island was tested with real terminals on Linux, macOS and Windows and with stand-ins that draw each tool's dialog; the real Antigravity, and the real Codex, OpenCode and Gemini CLI accounts, were not run here.
- Updating from 0.0.6 arrives by version number; updates by commit apply from this release on.
- Mac and Windows builds are not code signed yet.
