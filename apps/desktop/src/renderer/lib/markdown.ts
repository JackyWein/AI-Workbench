/**
 * The Markdown the tools answer in, read into a small tree the chat renders
 * as React elements. No HTML is ever produced or passed through: anything
 * that is not one of the forms below stays text, so an answer cannot inject
 * markup into the window.
 *
 * Covered: paragraphs (a line break stays a line break, as the tools mean
 * it), headings, bullet and numbered lists (nested by indentation, with task
 * boxes), quotes, rules, tables, fenced code, and inline code, bold, italic,
 * strikethrough and http(s) links. An unclosed marker — common while an
 * answer still streams — is shown as it is.
 */

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong"; readonly children: readonly Inline[] }
  | { readonly type: "em"; readonly children: readonly Inline[] }
  | { readonly type: "del"; readonly children: readonly Inline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly Inline[] }
  | { readonly type: "break" };

export interface ListItem {
  readonly content: readonly Inline[];
  /** True or false for a task box ("- [x]"), null for a plain item. */
  readonly checked: boolean | null;
  readonly children: readonly Block[];
}

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { readonly type: "paragraph"; readonly content: readonly Inline[] }
  | { readonly type: "heading"; readonly level: number; readonly content: readonly Inline[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ListItem[];
    }
  | { readonly type: "quote"; readonly blocks: readonly Block[] }
  | { readonly type: "rule" }
  | {
      readonly type: "table";
      readonly align: readonly Align[];
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly type: "code"; readonly lang: string; readonly code: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", content: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(marker)) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // the closing fence, or past the end while it streams
      blocks.push({ type: "code", lang: fence[2] ?? "", code: code.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length,
        content: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
        quoted.push(QUOTE.exec(lines[index] ?? "")?.[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(quoted) });
      continue;
    }

    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "") && (lines[index + 1] ?? "").includes("-")) {
      flush();
      const header = cells(line);
      const align = cells(lines[index + 1] ?? "").map(alignOf);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
        rows.push(cells(lines[index] ?? "").map(parseInline));
        index += 1;
      }
      blocks.push({ type: "table", align, header: header.map(parseInline), rows });
      continue;
    }

    if (LIST_ITEM.test(line) && (paragraph.length === 0 || startsList(line))) {
      flush();
      const listed: string[] = [];
      const first = LIST_ITEM.exec(line);
      const baseIndent = (first?.[1] ?? "").length;
      const ordered = /\d/.test(first?.[2] ?? "");
      // A bullet list right after a numbered one (or the other way round) is
      // a list of its own.
      const otherKind = (candidate: string): boolean => {
        const match = LIST_ITEM.exec(candidate);
        return Boolean(match && (match[1] ?? "").length <= baseIndent + 1 && /\d/.test(match[2] ?? "") !== ordered);
      };
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const next = lines[index + 1] ?? "";
        if (otherKind(current)) {
          break;
        }
        if (LIST_ITEM.test(current) || (current.trim() !== "" && /^\s+/.test(current) && listed.length > 0)) {
          listed.push(current);
          index += 1;
        } else if (current.trim() === "" && listed.length > 0 && (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next))) {
          index += 1; // a blank line between items keeps the list together
        } else {
          break;
        }
      }
      blocks.push(parseList(listed));
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flush();
  return blocks;
}

/** A list inside a paragraph only starts at a bullet or at "1.". */
function startsList(line: string): boolean {
  const match = LIST_ITEM.exec(line);
  const marker = match?.[2] ?? "";
  return /^[-*+]$/.test(marker) || /^1[.)]$/.test(marker);
}

function parseList(lines: readonly string[]): Block {
  const first = LIST_ITEM.exec(lines[0] ?? "");
  const baseIndent = (first?.[1] ?? "").length;
  const ordered = /\d/.test(first?.[2] ?? "");
  const start = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : 1;
  const items: { text: string[]; nested: string[] }[] = [];

  for (const line of lines) {
    const match = LIST_ITEM.exec(line);
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (match && indent <= baseIndent + 1) {
      items.push({ text: [match[3] ?? ""], nested: [] });
    } else if (items.length > 0) {
      const item = items[items.length - 1]!;
      if (match || item.nested.length > 0) {
        item.nested.push(line);
      } else {
        item.text.push(line.trim());
      }
    }
  }

  return {
    type: "list",
    ordered,
    start,
    items: items.map((item) => {
      const box = /^\[( |x|X)\]\s+(.*)$/.exec(item.text[0] ?? "");
      const text = box ? [box[2] ?? "", ...item.text.slice(1)] : item.text;
      return {
        content: parseInline(text.join("\n")),
        checked: box ? box[1] !== " " : null,
        children: item.nested.length > 0 ? parseBlocks(outdent(item.nested)) : [],
      };
    }),
  };
}

function outdent(lines: readonly string[]): string[] {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const least = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(least, /^\s*/.exec(line)?.[0].length ?? 0)));
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

// --- inline -------------------------------------------------------------------

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|~>".split(""));
const URL_START = /https?:\/\//y;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const push = (node: Inline): void => {
    if (buffer) {
      out.push({ type: "text", text: buffer });
      buffer = "";
    }
    out.push(node);
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";

    if (char === "\\" && ESCAPABLE.has(text[index + 1] ?? "")) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "\n") {
      push({ type: "break" });
      index += 1;
      continue;
    }

    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))?.[0] ?? "`";
      const close = text.indexOf(run, index + run.length);
      if (close !== -1) {
        const code = text.slice(index + run.length, close);
        push({ type: "code", text: run.length > 1 ? code.trim() : code });
        index = close + run.length;
        continue;
      }
      buffer += run;
      index += run.length;
      continue;
    }

    if (char === "[") {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(index));
      if (link) {
        push({ type: "link", href: link[2] ?? "", children: parseInline(link[1] ?? "") });
        index += link[0].length;
        continue;
      }
    }

    URL_START.lastIndex = index;
    if ((char === "h" || char === "H") && URL_START.test(text) && !/\w/.test(text[index - 1] ?? "")) {
      const raw = /^https?:\/\/[^\s<>()[\]]+/.exec(text.slice(index))?.[0] ?? "";
      const href = raw.replace(/[.,;:!?'"]+$/, "");
      push({ type: "link", href, children: [{ type: "text", text: href }] });
      index += href.length;
      continue;
    }

    const emphasis = emphasisAt(text, index);
    if (emphasis) {
      push(emphasis.node);
      index = emphasis.end;
      continue;
    }

    buffer += char;
    index += 1;
  }
  if (buffer) {
    out.push({ type: "text", text: buffer });
  }
  return out;
}

/** Bold, italic or struck text starting at `index`, when it closes. */
function emphasisAt(text: string, index: number): { node: Inline; end: number } | null {
  const before = text[index - 1] ?? "";
  for (const [marker, type] of [
    ["**", "strong"],
    ["__", "strong"],
    ["~~", "del"],
    ["*", "em"],
    ["_", "em"],
  ] as const) {
    if (!text.startsWith(marker, index)) {
      continue;
    }
    // Underscores inside words (snake_case) are not emphasis.
    if (marker.startsWith("_") && /\w/.test(before)) {
      continue;
    }
    const open = index + marker.length;
    if (/\s/.test(text[open] ?? " ")) {
      continue;
    }
    let search = open;
    while (search < text.length) {
      const close = text.indexOf(marker, search);
      if (close === -1 || text.slice(open, close).includes("\n\n")) {
        break;
      }
      const inside = text.slice(open, close);
      const after = text[close + marker.length] ?? "";
      const closes =
        inside.length > 0 &&
        !/\s/.test(inside[inside.length - 1] ?? "") &&
        !(marker.startsWith("_") && /\w/.test(after)) &&
        // "**" is not the end of a "*" span.
        !(marker === "*" && text[close + 1] === "*" && text[close - 1] !== "*");
      if (closes) {
        return { node: { type, children: parseInline(inside) }, end: close + marker.length };
      }
      search = close + marker.length;
    }
  }
  return null;
}
