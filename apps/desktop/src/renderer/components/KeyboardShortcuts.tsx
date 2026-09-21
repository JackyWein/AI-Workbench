import type { JSX } from "react";

/**
 * Every keyboard shortcut the application offers, in one place (spec §81).
 * Each entry here must match an implemented handler — no aspirational keys.
 */
const SECTIONS: ReadonlyArray<{
  readonly title: string;
  readonly rows: ReadonlyArray<readonly [keys: string, action: string]>;
}> = [
  {
    title: "Everywhere",
    rows: [
      ["Ctrl/⌘ K", "Command palette"],
      ["Ctrl/⌘ `", "Workspace panel (terminal, files, changes)"],
      ["Esc", "Close palette, popover or panel"],
    ],
  },
  {
    title: "Conversation",
    rows: [
      ["Enter", "Send message"],
      ["Shift Enter", "New line"],
    ],
  },
  {
    title: "Command palette",
    rows: [
      ["↑ ↓", "Move selection"],
      ["Enter", "Run command"],
      ["Esc", "Close"],
    ],
  },
  {
    title: "Tabs (workspace tools, run detail)",
    rows: [
      ["← →", "Previous / next tab"],
      ["Home / End", "First / last tab"],
    ],
  },
  {
    title: "Status Island",
    rows: [
      ["← →", "Previous / next widget"],
      ["Enter", "Open what the island shows"],
      ["Esc", "Settle back to compact"],
    ],
  },
  {
    title: "Terminal",
    rows: [
      ["Ctrl/⌘ C with selection", "Copy selection"],
      ["Ctrl/⌘ C without selection", "Interrupt (reaches the program)"],
    ],
  },
];

export function KeyboardShortcuts(): JSX.Element {
  return (
    <section aria-label="Keyboard shortcuts">
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="section__label">{section.title}</p>
          <dl className="detail-list">
            {section.rows.map(([keys, action]) => (
              <div className="detail" key={keys}>
                <dt className="detail__label">{keys}</dt>
                <dd className="detail__value">{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}
