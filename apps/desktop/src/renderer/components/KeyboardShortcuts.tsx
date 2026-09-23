import type { JSX } from "react";
import { Keys, SettingDisclosure } from "./Controls.js";

type Shortcut = readonly [keys: string, action: string];

/**
 * Every keyboard shortcut the application offers, in one place (spec §81).
 * Each entry here must match an implemented handler — no aspirational keys.
 * Keys are space-separated keycaps.
 */
const ESSENTIALS: ReadonlyArray<Shortcut> = [
  ["Ctrl K", "Command palette"],
  ["Ctrl `", "Workspace panel"],
  ["Ctrl Shift A", "Chat ⇄ Agents"],
  ["Esc", "Close palette, popover or panel"],
];

const SECTIONS: ReadonlyArray<{
  readonly title: string;
  readonly rows: ReadonlyArray<Shortcut>;
}> = [
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
    title: "Tabs",
    rows: [
      ["← →", "Previous / next tab"],
      ["Home End", "First / last tab"],
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
      ["Ctrl C", "Copy, when text is selected"],
      ["Ctrl C", "Interrupt the program, when nothing is selected"],
    ],
  },
];

function ShortcutRow({ shortcut }: { readonly shortcut: Shortcut }): JSX.Element {
  const [keys, action] = shortcut;
  return (
    <div className="shortcut">
      <span className="shortcut__action">{action}</span>
      <Keys combo={keys} />
    </div>
  );
}

export function KeyboardShortcuts(): JSX.Element {
  return (
    <>
      <div className="shortcut-list">
        {ESSENTIALS.map((shortcut) => (
          <ShortcutRow key={shortcut[1]} shortcut={shortcut} />
        ))}
      </div>
      <SettingDisclosure label="All shortcuts">
        {SECTIONS.map((section) => (
          <div className="shortcut-list" key={section.title}>
            <p className="shortcut-list__title">{section.title}</p>
            {section.rows.map((shortcut) => (
              <ShortcutRow key={shortcut[1]} shortcut={shortcut} />
            ))}
          </div>
        ))}
      </SettingDisclosure>
    </>
  );
}
