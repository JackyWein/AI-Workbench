import { describe, expect, it } from "vitest";
import { arrowKey, detectPrompt } from "../prompt.js";
import { TerminalScreen } from "../screen.js";

/** Draws text on a real (display-less) terminal and reads its screen back. */
async function screenOf(text: string, cols = 120, rows = 30): Promise<string[]> {
  const screen = new TerminalScreen(cols, rows);
  screen.write(text.replace(/\n/g, "\r\n"));
  await screen.settled();
  const lines = [...screen.snapshot().lines];
  screen.dispose();
  return lines;
}

// Antigravity's permission dialog, as it showed on a Windows machine.
const ANTIGRAVITY = `● Edit(D:/CODE/Team Test/real-estate/server.js)
● Bash(node -c real-estate/server.js; node -c real-estate/app.js) (ctrl+o to expand)

Command
────────────────────────────────────────────────────────────

Requesting permission for:
   node -c real-estate/server.js; node -c real-estate/app.js

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'node -c real-estate/server.js; node -c real-
estate/app.js'
  3. Yes, and always allow for commands that start with 'node -c real-estate/server.js; node -c real-estate/app.js' (Persist to
settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
esc to cancel                                              accept-edits · Gemini 3.8 Flash · high`;

// Claude Code's permission dialog in its frame.
const CLAUDE = `╭──────────────────────────────────────────────────────────╮
│ Bash command                                             │
│                                                          │
│   touch probe-created.txt                                │
│   Create an empty file                                   │
│                                                          │
│ Do you want to proceed?                                  │
│ ❯ 1. Yes                                                 │
│   2. Yes, and don't ask again for touch commands in /tmp │
│   3. No, and tell Claude what to do differently (esc)    │
╰──────────────────────────────────────────────────────────╯`;

// Codex's approval, with its command between the question and the options.
const CODEX = `  Would you like to run the following command?

  $ touch probe-created.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

// Gemini CLI's radio buttons.
const GEMINI = `╭─────────────────────────────────────╮
│ ?  Shell touch probe-created.txt    │
│                                     │
│ touch probe-created.txt             │
│                                     │
│ Allow execution of: 'touch'?        │
│                                     │
│ ● 1. Allow once                     │
│   2. Allow for this session         │
│   3. No, suggest changes (esc)      │
╰─────────────────────────────────────╯`;

describe("recognising a dialog on a terminal's screen", () => {
  it("reads Antigravity's permission dialog, wrapped options and all", async () => {
    const prompt = detectPrompt(await screenOf(ANTIGRAVITY));
    expect(prompt).toMatchObject({
      question: "Run this command?",
      context: "node -c real-estate/server.js; node -c real-estate/app.js",
      selected: 0,
      permission: true,
    });
    expect(prompt?.options.map((option) => option.number)).toEqual([1, 2, 3, 4]);
    expect(prompt?.options[1]?.label).toBe(
      "Yes, and always allow in this conversation for commands that start with 'node -c real-estate/server.js; node -c real-estate/app.js'",
    );
    expect(prompt?.options[3]?.label).toBe("No, cancel");
  });

  it("reads Claude Code's dialog inside its frame", async () => {
    const prompt = detectPrompt(await screenOf(CLAUDE));
    expect(prompt).toMatchObject({
      question: "Do you want to proceed?",
      context: "Bash command · touch probe-created.txt · Create an empty file",
      selected: 0,
      permission: true,
    });
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for touch commands in /tmp",
      "No, and tell Claude what to do differently (esc)",
    ]);
  });

  it("reads Codex's approval with the command between question and options", async () => {
    const prompt = detectPrompt(await screenOf(CODEX));
    expect(prompt).toMatchObject({
      question: "Would you like to run the following command?",
      context: "$ touch probe-created.txt",
      selected: 0,
      permission: true,
    });
    expect(prompt?.options).toHaveLength(3);
  });

  it("reads Gemini CLI's radio buttons", async () => {
    const prompt = detectPrompt(await screenOf(GEMINI));
    expect(prompt).toMatchObject({
      question: "Allow execution of: 'touch'?",
      context: "Shell touch probe-created.txt · touch probe-created.txt",
      selected: 0,
      permission: true,
    });
  });

  it("follows the marker when another option is the current one", async () => {
    const moved = CODEX.replace("› 1.", "  1.").replace("  2. Yes, and", "› 2. Yes, and");
    const prompt = detectPrompt(await screenOf(moved));
    expect(prompt?.selected).toBe(1);
    // The same dialog, whichever option is marked.
    expect(prompt?.fingerprint).toBe(detectPrompt(await screenOf(CODEX))?.fingerprint);
  });

  it("finds a question that is not about permission", async () => {
    const prompt = detectPrompt(
      await screenOf(`Which database should the service use?
❯ 1. PostgreSQL
  2. SQLite
  3. Type something else
Enter to select · ↑/↓ to navigate · Esc to cancel`),
    );
    expect(prompt).toMatchObject({ question: "Which database should the service use?", permission: false });
  });

  it("does not take a numbered list in an answer for a dialog", async () => {
    // No marker: an answer's list.
    expect(
      detectPrompt(
        await screenOf(`Which approach do you prefer?
1. Rewrite the parser
2. Patch the tokenizer
3. Leave it

> `),
      ),
    ).toBeNull();
    // Counting that does not start at one, or skips.
    expect(detectPrompt(await screenOf(`Pick one?\n> 2. B\n  3. C`))).toBeNull();
    expect(detectPrompt(await screenOf(`Pick one?\n> 1. A\n  3. C`))).toBeNull();
    // A dialog long gone, with the conversation carried on below it.
    const scrolled = `${CODEX}\n${Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n")}`;
    expect(detectPrompt(await screenOf(scrolled, 120, 40))).toBeNull();
    // Nothing on screen at all.
    expect(detectPrompt(await screenOf(""))).toBeNull();
  });

  it("presses the arrow keys the way the program asked for them", () => {
    expect(arrowKey("down", false)).toBe("\x1b[B");
    expect(arrowKey("up", false)).toBe("\x1b[A");
    expect(arrowKey("down", true)).toBe("\x1bOB");
  });

  it("keeps up with a program that redraws its dialog in place", async () => {
    const screen = new TerminalScreen(100, 20);
    screen.write(CODEX.replace(/\n/g, "\r\n"));
    // Moves back to the options and redraws them with the second one marked,
    // the way full-screen interfaces update a dialog.
    screen.write("\x1b[4A\r\x1b[2K  1. Yes, proceed (y)\r\n\x1b[2K› 2. Yes, and don't ask again for this command (a)\x1b[3B");
    await screen.settled();
    expect(detectPrompt(screen.snapshot().lines)?.selected).toBe(1);
    screen.write("\x1b[?1h");
    await screen.settled();
    expect(screen.snapshot().applicationCursorKeys).toBe(true);
    screen.dispose();
  });
});
