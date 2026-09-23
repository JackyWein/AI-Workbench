import type { JSX } from "react";
import type {
  AppSettings,
  IslandPosition,
  IslandWidgetId,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import {
  Choice,
  Segmented,
  SettingDisclosure,
  SettingGroup,
  SettingRow,
  Switch,
  type SegmentOption,
} from "./Controls.js";
import { ConnectionSettings } from "./ConnectionsView.js";
import { KeyboardShortcuts } from "./KeyboardShortcuts.js";
import { UpdateSection } from "./UpdateSection.js";

interface SettingsViewProps {
  readonly settings: AppSettings;
  readonly appInfo: { version: string; platform: string; userDataPath: string } | null;
}

const THEMES: ReadonlyArray<SegmentOption<AppSettings["theme"]>> = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const DENSITIES: ReadonlyArray<SegmentOption<AppSettings["density"]>> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const CLOSE_BEHAVIOUR: ReadonlyArray<SegmentOption<"quit" | "keep">> = [
  { value: "quit", label: "Quit" },
  { value: "keep", label: "Keep running" },
];

/** App preferences only: anything provider-shaped lives in Providers. */
export function SettingsView({ settings, appInfo }: SettingsViewProps): JSX.Element {
  const updateSettings = useWorkbench((state) => state.updateSettings);
  const setIslandPreferences = useWorkbench((state) => state.setIslandPreferences);

  return (
    <div className="view">
      <div className="view__inner view__inner--narrow">
        <h1 className="view__title">Settings</h1>

        <IslandSettings settings={settings} />

        <SettingGroup title="Appearance">
          <SettingRow label="Theme" description="Dark is the default surface.">
            <Segmented
              label="Theme"
              value={settings.theme}
              options={THEMES}
              onChange={(theme) => void updateSettings({ theme })}
            />
          </SettingRow>
          <SettingRow label="Density" description="Compact tightens spacing.">
            <Segmented
              label="Density"
              value={settings.density}
              options={DENSITIES}
              onChange={(density) => void updateSettings({ density })}
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Window">
          <SettingRow
            label="Closing the main window"
            description={
              settings.statusIsland.closeToTray
                ? "Agents keep running; the island and the tray bring it back."
                : "Quits AI Workbench and stops what is running."
            }
          >
            <Segmented
              label="Closing the main window"
              value={settings.statusIsland.closeToTray ? "keep" : "quit"}
              options={CLOSE_BEHAVIOUR}
              onChange={(choice) => void setIslandPreferences({ closeToTray: choice === "keep" })}
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Shortcuts">
          <KeyboardShortcuts />
        </SettingGroup>

        <ConnectionSettings />

        <SettingGroup title="About">
          <UpdateSection currentVersion={appInfo?.version ?? null} />
          <SettingDisclosure label="Advanced">
            <SettingRow
              label="Developer mode"
              description="Shows raw provider events, internal state and in-process test tools."
            >
              <Switch
                label="Developer mode"
                checked={settings.developerMode}
                onChange={(developerMode) => void updateSettings({ developerMode })}
              />
            </SettingRow>
            {appInfo ? (
              <SettingRow
                label="Data folder"
                description={<span className="setting__path">{appInfo.userDataPath}</span>}
              />
            ) : null}
          </SettingDisclosure>
        </SettingGroup>
      </div>
    </div>
  );
}

const ISLAND_WIDGETS: ReadonlyArray<SegmentOption<IslandWidgetId>> = [
  { value: "needsAttention", label: "Needs attention" },
  { value: "activeAgents", label: "Active agents" },
  { value: "teamProgress", label: "Team progress" },
  { value: "providerUsage", label: "Provider usage" },
  { value: "completedWork", label: "Completed work" },
  { value: "errors", label: "Errors" },
  { value: "connectionHealth", label: "Connection health" },
];

const PINNED: ReadonlyArray<SegmentOption<IslandWidgetId | "automatic">> = [
  { value: "automatic", label: "Automatic" },
  ...ISLAND_WIDGETS,
];

const ROTATE: ReadonlyArray<SegmentOption<"0" | "5" | "10" | "30">> = [
  { value: "0", label: "Off" },
  { value: "5", label: "5s" },
  { value: "10", label: "10s" },
  { value: "30", label: "30s" },
];

type Placement = IslandPosition | "docked";

function rotateValue(seconds: number): "0" | "5" | "10" | "30" {
  return seconds >= 30 ? "30" : seconds >= 10 ? "10" : seconds >= 5 ? "5" : "0";
}

/**
 * Island preferences (spec §101), all persisted with the settings. The few
 * that shape everyday use are rows; the rest wait behind a disclosure.
 */
function IslandSettings({ settings }: { readonly settings: AppSettings }): JSX.Element {
  const island = settings.statusIsland;
  const setIslandPreferences = useWorkbench((state) => state.setIslandPreferences);
  const off = !island.enabled;

  const docked: Array<SegmentOption<Placement>> = island.dockedEdge
    ? [{ value: "docked", label: `Docked, ${island.dockedEdge} edge` }]
    : [];
  const placements: ReadonlyArray<SegmentOption<Placement>> = [
    ...docked,
    { value: "topCenter", label: "Top center" },
    { value: "topLeft", label: "Top left" },
    { value: "topRight", label: "Top right" },
    { value: "custom", label: "Where I left it" },
  ];

  return (
    <SettingGroup
      title="Status Island"
      lede="A small companion that keeps showing what is happening while the main window is in the background."
    >
      <SettingRow label="Show the island" description="Only while the main window is not in front.">
        <Switch
          label="Show the island"
          checked={island.enabled}
          onChange={(enabled) => void setIslandPreferences({ enabled })}
        />
      </SettingRow>
      <SettingRow
        label="Expand for important events"
        description="Grows for a moment when something needs you, then settles back."
        muted={off}
      >
        <Switch
          label="Expand for important events"
          checked={island.autoExpand}
          onChange={(autoExpand) => void setIslandPreferences({ autoExpand })}
        />
      </SettingRow>
      <SettingRow
        label="Resting widget"
        description="Shown when nothing more important is happening."
        muted={off}
      >
        <Choice
          label="Resting island widget"
          value={island.defaultWidget}
          options={ISLAND_WIDGETS}
          onChange={(defaultWidget) => void setIslandPreferences({ defaultWidget })}
        />
      </SettingRow>
      <SettingRow
        label="Position"
        description={
          island.dockedEdge
            ? "Drag it off the edge, or pick a spot here, to free it."
            : "Drag it to an edge of the screen to dock it there."
        }
        muted={off}
      >
        <Choice
          label="Island position"
          value={island.dockedEdge ? "docked" : island.position}
          options={placements}
          onChange={(placement) => {
            if (placement !== "docked") {
              void setIslandPreferences({ position: placement, dockedEdge: null, railT: null });
            }
          }}
        />
      </SettingRow>

      <SettingDisclosure label="More island options">
        <SettingRow
          label="Start with AI Workbench"
          description="There from launch and stays visible."
          muted={off}
        >
          <Switch
            label="Start with AI Workbench"
            checked={island.startWithApp}
            onChange={(startWithApp) => void setIslandPreferences({ startWithApp })}
          />
        </SettingRow>
        <SettingRow
          label="Hide when the main window is focused"
          description="Off keeps the island always visible; on hides it over the app."
          muted={off}
        >
          <Switch
            label="Hide when the main window is focused"
            checked={island.hideWhenMainFocused ?? false}
            onChange={(hideWhenMainFocused) => void setIslandPreferences({ hideWhenMainFocused })}
          />
        </SettingRow>
        <SettingRow
          label="Stay visible when the window is hidden"
          description="The agents keep running either way."
          muted={off}
        >
          <Switch
            label="Stay visible when the window is hidden"
            checked={island.stayVisibleWhenHidden}
            onChange={(stayVisibleWhenHidden) => void setIslandPreferences({ stayVisibleWhenHidden })}
          />
        </SettingRow>
        <SettingRow
          label="Always on top"
          description="On Windows the island stays above other apps, including most full-screen apps."
          muted={off}
        >
          <Switch
            label="Always on top"
            checked={island.alwaysOnTop}
            onChange={(alwaysOnTop) => void setIslandPreferences({ alwaysOnTop })}
          />
        </SettingRow>
        <SettingRow
          label="Keep one widget"
          description="Automatic lets priority decide what is shown."
          muted={off}
        >
          <Choice
            label="Pinned island widget"
            value={island.pinnedWidget ?? "automatic"}
            options={PINNED}
            onChange={(pinned) =>
              void setIslandPreferences({ pinnedWidget: pinned === "automatic" ? null : pinned })
            }
          />
        </SettingRow>
        <SettingRow label="Rotate widgets" description="Step through them on a timer." muted={off}>
          <Segmented
            label="Island auto rotate"
            value={rotateValue(island.autoRotateSeconds)}
            options={ROTATE}
            onChange={(seconds) => void setIslandPreferences({ autoRotateSeconds: Number(seconds) })}
          />
        </SettingRow>
        <SettingRow
          label="Display"
          description={
            island.displayId === null
              ? "Follows the active monitor."
              : "Kept on the monitor it was dragged to."
          }
          muted={off}
        >
          <button
            type="button"
            className="ghost-button"
            disabled={island.displayId === null}
            onClick={() => void setIslandPreferences({ displayId: null })}
          >
            Follow active monitor
          </button>
        </SettingRow>
        <div className="setting setting--stacked" data-muted={off || undefined}>
          <div className="setting__text">
            <p className="setting__label">Widgets</p>
            <p className="setting__description">Only these are ever shown.</p>
          </div>
          <div className="chip-toggles" role="group" aria-label="Island widgets">
            {ISLAND_WIDGETS.map((widget) => {
              const on = island.enabledWidgets.includes(widget.value);
              return (
                <button
                  key={widget.value}
                  type="button"
                  className="chip-toggle"
                  aria-pressed={on}
                  onClick={() =>
                    void setIslandPreferences({
                      enabledWidgets: on
                        ? island.enabledWidgets.filter((entry) => entry !== widget.value)
                        : [...island.enabledWidgets, widget.value],
                    })
                  }
                >
                  {widget.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingDisclosure>
    </SettingGroup>
  );
}
