import { Monitor, Moon, Sun } from "lucide-react";
import type { JSX } from "react";
import type { ColorMode } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

const NEXT: Record<ColorMode, ColorMode> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ColorMode, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * Light, dark or the system's, one click away for whichever theme is on.
 * Each click moves on: System, Light, Dark. The same choice sits under
 * Settings → Appearance and in the command palette.
 */
export function ModeToggle(): JSX.Element {
  const mode = useWorkbench((state) => state.settings.mode);
  const updateSettings = useWorkbench((state) => state.updateSettings);
  const next = NEXT[mode];
  const Icon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;
  const title = `Mode: ${LABEL[mode]} — click for ${LABEL[next]}`;
  return (
    <button
      type="button"
      className="icon-button mode-toggle-button"
      data-mode={mode}
      onClick={() => void updateSettings({ mode: next })}
      aria-label={title}
      title={title}
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
