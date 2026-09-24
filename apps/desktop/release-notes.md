AI Workbench 0.0.6

Themes: make it look the way you like
- Six themes, each in a light and a dark mode: Quiet (graphite or white, the default), Atelier (warm paper or espresso, serif headings, terracotta), Mission Control (a grid, lime signals, monospace), Playground (indigo and cream, thick ink outlines), Aurora (violet and cyan light) and Swiss (black and white, one red, square).
- Light, dark or the system's for every theme: the toggle at the top of the sidebar steps through them, and Settings → Appearance and the command palette ("theme", "mode") offer the same. A new install follows the system.
- Settings → Appearance shows each theme as a small window drawn in it, light and dark side by side.
- A theme changes the whole app: colours, typefaces, corners, outlines, the terminals' colours and type, and code blocks.
- The status island takes the theme on too and follows light and dark: Atelier's serif and a terracotta ring in the bubble, Mission Control's square bubble and monospace readout, Playground's yellow bubble with thick ink and a hard shadow, Aurora's violet-to-cyan ring, Swiss's square, flat outline.
- The typefaces ship with the app; nothing is downloaded.
- Every theme and mode is tested for readable contrast in the window, the sidebar, code blocks, the terminal and the island.

The logo, everywhere
- The start screen shows the app's own logo drawing itself in instead of a letter in a box, and the logo also appears in the sidebar, on the welcome screen and on the island when nothing runs. It takes on the colours of the theme you picked.

Answers read better
- Answers show the Markdown the tools write: headings, lists, task lists, quotes, tables, links and code.

Fixed
- A team session opened after a restart now opens as its team, not as an empty chat.
- The island's titles were dark on its dark card when the system used a light theme.
- The app no longer fails to start when a stored skill or plugin can no longer be read; that entry is skipped and logged.
- In the light theme, the language label and Copy button of code blocks were hard to read.

Known limits
- Real Codex, OpenCode and Gemini CLI account limits are still untested. Antigravity is not verified.
- Mac and Windows builds are not code signed.
