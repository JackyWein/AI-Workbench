/**
 * Recognises a choice a terminal program is waiting on, from what its screen
 * shows — the same way a person reading it would. Coding tools draw their
 * permission and question dialogs alike: a question, numbered options, one
 * of them marked as the current one, and a hint how to pick:
 *
 *     Run this command?
 *     > 1. Yes, run command
 *       2. Yes, and always allow in this conversation …
 *       4. No, cancel
 *     ↑/↓ Navigate · esc to cancel
 *
 * This works for any tool without a hook, a plugin or a log format, which is
 * what lets the island show — and answer — a tool whose own reports do not
 * reach the application (a tool without hooks, or hooks that do not run on
 * this machine). The tool still asks and still decides: an answer is its own
 * dialog's keys, pressed for the person, and only once the screen shows the
 * chosen option marked.
 */

export interface ScreenOption {
  /** The number the tool shows in front of it. */
  readonly number: number;
  readonly label: string;
}

export interface ScreenPrompt {
  /** The question above the options; empty when the dialog shows none. */
  readonly question: string;
  /** What it is about: the command or file shown with the question. */
  readonly context: string;
  readonly options: readonly ScreenOption[];
  /** Which option is marked as the current one, by index. */
  readonly selected: number;
  /** True when the choices read as allowing or refusing something. */
  readonly permission: boolean;
  /** The same dialog gives the same fingerprint, whichever option is marked. */
  readonly fingerprint: string;
}

/** Markers tools put in front of the current option. */
const SELECTED = "[>❯›→▶▸●◉*]";
/** Markers of the options that are not the current one. */
const UNSELECTED = "[○◯]";
const OPTION = new RegExp(`^(?:(${SELECTED})|${UNSELECTED})?\\s*([1-9])[.)]\\s+(\\S.*)$`);
/** Frames drawn around dialogs; stripped so the text inside is compared. */
const FRAME = /^[\s│┃║|╭╮╰╯┌┐└┘]+|[\s│┃║|╭╮╰╯┌┐└┘]+$/g;
/** A rule between sections: only line-drawing characters. */
const RULE = /^[─━═\-_~]{3,}$/;
/** What the hint under a dialog says about picking. */
const HINT = /\b(esc|enter|confirm|cancel|navigate|select)\b|[↑↓]/i;
const YES = /^(yes|allow|approve|accept|proceed|run|continue|always)\b/i;
const NO = /^(no|deny|reject|decline|cancel|don't|do not|skip)\b/i;

/** How far below the options a dialog's footer may reach. */
const MAX_LINES_AFTER = 8;
/** How far above the options its question may stand. */
const MAX_QUESTION_DISTANCE = 12;

function clean(line: string): string {
  return line.replace(FRAME, "").trim();
}

/** Whether option `expected` comes within the next few lines. */
function nextOptionFollows(lines: readonly string[], from: number, expected: number): boolean {
  for (let index = from; index < Math.min(lines.length, from + 6); index += 1) {
    const match = OPTION.exec(lines[index] ?? "");
    if (match) {
      return Number(match[2]) === expected;
    }
  }
  return false;
}

interface Block {
  readonly start: number;
  end: number;
  readonly options: Array<{ number: number; label: string; marked: boolean }>;
}

/**
 * The dialog at the foot of the screen, or null when the screen shows none.
 * Deliberately strict — a numbered list in an answer is not a dialog: the
 * options must count from 1 without gaps, exactly one must be marked, they
 * must sit at the foot of the screen, and either a question stands above
 * them or a picking hint below.
 */
export function detectPrompt(screen: readonly string[]): ScreenPrompt | null {
  const lines = screen.map(clean);
  let block: Block | null = null;
  let last: Block | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = OPTION.exec(line);
    if (match) {
      const number = Number(match[2]);
      const option = { number, label: (match[3] ?? "").trim(), marked: match[1] !== undefined };
      if (number === 1) {
        block = { start: index, end: index, options: [option] };
        last = block;
        continue;
      }
      const previous = block?.options[block.options.length - 1];
      if (block && previous && number === previous.number + 1) {
        block.options.push(option);
        block.end = index;
        continue;
      }
      block = null;
      continue;
    }
    if (!block) {
      continue;
    }
    // Between two options, a line is the one above running on (the tool
    // wrapped it), and a blank line only spaces them.
    const previous = block.options[block.options.length - 1];
    if (previous && nextOptionFollows(lines, index + 1, previous.number + 1)) {
      if (line !== "") {
        previous.label = previous.label.endsWith("-") ? `${previous.label}${line}` : `${previous.label} ${line}`;
      }
      continue;
    }
    block = null;
  }
  if (!last || last.options.length < 2) {
    return null;
  }
  const marked = last.options.filter((option) => option.marked);
  if (marked.length !== 1) {
    return null;
  }
  const after = lines.slice(last.end + 1).filter((line) => line !== "");
  if (after.length > MAX_LINES_AFTER) {
    return null;
  }

  let questionIndex = -1;
  for (let index = last.start - 1; index >= Math.max(0, last.start - MAX_QUESTION_DISTANCE); index -= 1) {
    const line = lines[index] ?? "";
    if (RULE.test(line)) {
      break;
    }
    if (/\?["'`)\]]*$/.test(line)) {
      questionIndex = index;
      break;
    }
  }
  const hinted = after.some((line) => HINT.test(line));
  if (questionIndex === -1 && !hinted) {
    return null;
  }

  // What it is about: the lines between the question and the options (a
  // command, a reason), else the few just above the question.
  const between =
    questionIndex === -1 ? [] : lines.slice(questionIndex + 1, last.start).filter((line) => line !== "");
  const above: string[] = [];
  for (let index = (questionIndex === -1 ? last.start : questionIndex) - 1; index >= 0 && above.length < 3; index -= 1) {
    const line = lines[index] ?? "";
    if (RULE.test(line)) {
      break;
    }
    if (line !== "") {
      // Some tools mark the dialog's title with a "?" of their own.
      above.unshift(line.replace(/^\?\s+/, ""));
    }
  }
  const context = (between.length > 0 ? between : above)
    // A heading such as "Requesting permission for:" says less than what follows it.
    .filter((line, index, all) => !(line.endsWith(":") && index < all.length - 1))
    .slice(-3)
    .join(" · ")
    .slice(0, 400);

  const options = last.options.map((option) => ({
    number: option.number,
    label: option.label.replace(/\s+/g, " ").slice(0, 200),
  }));
  const question = questionIndex === -1 ? "" : (lines[questionIndex] ?? "").replace(/^\?\s+/, "").slice(0, 300);
  const permission = options.some((option) => YES.test(option.label)) && options.some((option) => NO.test(option.label));
  return {
    question,
    context,
    options,
    selected: last.options.findIndex((option) => option.marked),
    permission,
    fingerprint: JSON.stringify([question, options.map((option) => option.label)]),
  };
}

/** The arrow key a terminal sends, in the mode the program asked for. */
export function arrowKey(direction: "up" | "down", applicationCursorKeys: boolean): string {
  const final = direction === "up" ? "A" : "B";
  return applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
}
