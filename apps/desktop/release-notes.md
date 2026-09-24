AI Workbench 0.0.6

Themes: make it look the way you like
- Settings → Appearance has a theme picker that shows each theme as a small window drawn in it. Eight to choose from: Quiet (dark, light, or following your system), Atelier (warm paper, serif headings, terracotta), Mission Control (near-black on a grid, lime, monospace), Playground (cream and indigo, thick ink outlines), Aurora (night blue with violet and cyan light) and Swiss (black on white, one red, square).
- A theme changes the whole app: colours, typefaces, corners, outlines, the terminals' colours and type, code blocks and the status island. The island keeps a dark body in every theme so it stays readable over any desktop.
- The typefaces ship with the app; nothing is downloaded.
- Every theme is also in the command palette: type "theme".
- Every theme is tested for readable contrast in the window, the sidebar, code blocks, the terminal and the island.

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
