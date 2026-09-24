import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../markdown.js";

describe("reading an answer's Markdown", () => {
  it("reads bold, italic, code and links inside a line", () => {
    expect(parseInline("Use **bold**, *italic*, `code` and [docs](https://example.com).")).toEqual([
      { type: "text", text: "Use " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: ", " },
      { type: "em", children: [{ type: "text", text: "italic" }] },
      { type: "text", text: ", " },
      { type: "code", text: "code" },
      { type: "text", text: " and " },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "docs" }] },
      { type: "text", text: "." },
    ]);
  });

  it("leaves snake_case, lone stars and unfinished markers as they are", () => {
    expect(parseInline("cart_total_cents")).toEqual([{ type: "text", text: "cart_total_cents" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
    // What a streaming answer looks like halfway through.
    expect(parseInline("The **fix is")).toEqual([{ type: "text", text: "The **fix is" }]);
    expect(parseInline("run `bun te")).toEqual([{ type: "text", text: "run `bun te" }]);
  });

  it("never turns markup or odd links into anything but text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { type: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { type: "text", text: "[click](javascript:alert(1))" },
    ]);
  });

  it("links a bare address without the sentence's full stop", () => {
    expect(parseInline("See https://example.com/a.")).toEqual([
      { type: "text", text: "See " },
      { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "https://example.com/a" }] },
      { type: "text", text: "." },
    ]);
  });

  it("keeps the line breaks a tool wrote", () => {
    expect(parseMarkdown("one\ntwo")).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "one" }, { type: "break" }, { type: "text", text: "two" }],
      },
    ]);
  });

  it("reads headings, lists with nesting and task boxes, quotes and rules", () => {
    const blocks = parseMarkdown(
      ["## Plan", "", "1. Read", "2. Fix", "   - carefully", "", "- [x] tests", "- [ ] docs", "", "> Note", "", "---"].join(
        "\n",
      ),
    );
    expect(blocks.map((block) => block.type)).toEqual(["heading", "list", "list", "quote", "rule"]);
    const numbered = blocks[1];
    expect(numbered?.type === "list" && numbered.ordered && numbered.items.length).toBe(2);
    expect(numbered?.type === "list" && numbered.items[1]?.children[0]?.type).toBe("list");
    const tasks = blocks[2];
    expect(tasks?.type === "list" && tasks.items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("reads a table with its alignment", () => {
    const [table] = parseMarkdown("| File | Tests |\n|:-----|------:|\n| total.ts | 4 |");
    expect(table).toEqual({
      type: "table",
      align: ["left", "right"],
      header: [[{ type: "text", text: "File" }], [{ type: "text", text: "Tests" }]],
      rows: [[[{ type: "text", text: "total.ts" }], [{ type: "text", text: "4" }]]],
    });
  });

  it("keeps fenced code as it is, even while it is still streaming", () => {
    expect(parseMarkdown("```ts\nconst a = **1**;\n```")).toEqual([
      { type: "code", lang: "ts", code: "const a = **1**;" },
    ]);
    expect(parseMarkdown("Here:\n```\npartial")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Here:" }] },
      { type: "code", lang: "", code: "partial" },
    ]);
  });
});
