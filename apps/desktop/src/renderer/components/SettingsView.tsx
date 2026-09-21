import type { JSX } from "react";
import type {
  AppSettings,
  IslandPosition,
  IslandWidgetId,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { UpdateSection } from "./UpdateSection.js";

interface SettingsViewProps {
  readonly settings: AppSettings;
  readonly appInfo: { version: string; platform: string; userDataPath: string } | null;
}

export function SettingsView({ settings, appInfo }: SettingsViewProps): JSX.Element {
  const updateSettings = useWorkbench((state) => state.updateSettings);

  return (
    <div className="view">
      <div className="view__inner">
        <h1 className="view__title">Settings</h1>

        <section>
          <p className="section__label">Status Island</p>
          <p className="field__description">
            A floating companion that keeps showing what is happening while the
            main window is hidden. Off until you ask for it.
          </p>
          <IslandSettings settings={settings} />
        </section>

        <section>
          <p className="section__label">Appearance</p>
          <div className="field">
            <div>
              <p className="field__label">Theme</p>
              <p className="field__description">Dark is the default surface.</p>
            </div>
            <select
              className="select"
              value={settings.theme}
              aria-label="Theme"
              onChange={(event) =>
                void updateSettings({ theme: event.target.value as AppSettings["theme"] })
              }
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          <div className="field">
            <div>
              <p className="field__label">Density</p>
              <p className="field__description">Compact tightens spacing.</p>
            </div>
            <select
              className="select"
              value={settings.density}
              aria-label="Density"
              onChange={(event) =>
                void updateSettings({
                  density: event.target.value as AppSettings["density"],
                })
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </section>

        <section>
          <p className="section__label">Advanced</p>
          <div className="field">
            <div>
              <p className="field__label">Developer mode</p>
              <p className="field__description">
                Shows raw normalized provider events and internal state.
              </p>
            </div>
            <input
              type="checkbox"
              checked={settings.developerMode}
              aria-label="Developer mode"
              onChange={(event) =>
                void updateSettings({ developerMode: event.target.checked })
              }
            />
          </div>
        </section>

        <UpdateSection currentVersion={appInfo?.version ?? null} />

        {appInfo ? (
          <section>
            <p className="section__label">About</p>
            <dl className="detail-list">
              <div className="detail">
                <dt className="detail__label">Version</dt>
                <dd className="detail__value">{appInfo.version}</dd>
              </div>
              <div className="detail">
                <dt className="detail__label">Platform</dt>
                <dd className="detail__value">{appInfo.platform}</dd>
              </div>
              <div className="detail">
                <dt className="detail__label">Data</dt>
                <dd className="detail__value">{appInfo.userDataPath}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </div>
    </div>
  );
}


const ISLAND_WIDGETS: Array<{ id: IslandWidgetId; label: string }> = [
  { id: "needsAttention", label: "Needs attention" },
  { id: "activeAgents", label: "Active agents" },
  { id: "teamProgress", label: "Team progress" },
  { id: "providerUsage", label: "Provider usage" },
  { id: "completedWork", label: "Completed work" },
  { id: "errors", label: "Errors" },
  { id: "connectionHealth", label: "Connection health" },
];

/** Island preferences (spec §101), all of them persisted with the settings. */
function IslandSettings({ settings }: { readonly settings: AppSettings }): JSX.Element {
  const island = settings.statusIsland;
  const setIslandPreferences = useWorkbench((state) => state.setIslandPreferences);

  const toggle = (
    key: "enabled" | "startWithApp" | "stayVisibleWhenHidden" | "alwaysOnTop" | "autoExpand" | "closeToTray",
    label: string,
    description: string,
  ): JSX.Element => (
    <div className="field">
      <div>
        <p className="field__label">{label}</p>
        <p className="field__description">{description}</p>
      </div>
      <label className="scope-toggle">
        <input
          type="checkbox"
          checked={island[key]}
          onChange={(event) => void setIslandPreferences({ [key]: event.target.checked })}
        />
        <span className="visually-hidden" hidden>
          {label}
        </span>
      </label>
    </div>
  );

  return (
    <>
      {toggle("enabled", "Enabled", "Show the island.")}
      {toggle("startWithApp", "Start with AI Workbench", "Appear as soon as the app opens.")}
      {toggle(
        "stayVisibleWhenHidden",
        "Stay visible when the main window is hidden",
        "The runtime keeps going either way.",
      )}
      {toggle("alwaysOnTop", "Always on top", "Keep it above other windows.")}
      {toggle(
        "autoExpand",
        "Expand for important events",
        "Grow for a moment when something needs you, then settle back.",
      )}
      {toggle(
        "closeToTray",
        "Closing the main window leaves it running",
        "Otherwise closing the window quits the application.",
      )}

      <div className="field">
        <div>
          <p className="field__label">Position</p>
          <p className="field__description">Dragging the island sets a custom one.</p>
        </div>
        <select
          className="select"
          value={island.position}
          aria-label="Island position"
          onChange={(event) =>
            void setIslandPreferences({ position: event.target.value as IslandPosition })
          }
        >
          <option value="topCenter">Top center</option>
          <option value="topLeft">Top left</option>
          <option value="topRight">Top right</option>
          <option value="custom">Where I left it</option>
        </select>
      </div>

      <div className="field">
        <div>
          <p className="field__label">Display</p>
          <p className="field__description">
            {island.displayId === null
              ? "Follows the active monitor."
              : `Pinned to display ${island.displayId} by dragging. Resetting follows the active one again.`}
          </p>
        </div>
        <button
          type="button"
          className="ghost-button"
          disabled={island.displayId === null}
          onClick={() => void setIslandPreferences({ displayId: null })}
        >
          Use active monitor
        </button>
      </div>

      <div className="field">
        <div>
          <p className="field__label">Default widget</p>
          <p className="field__description">Shown when nothing more important is happening.</p>
        </div>
        <select
          className="select"
          value={island.defaultWidget}
          aria-label="Default island widget"
          onChange={(event) =>
            void setIslandPreferences({ defaultWidget: event.target.value as IslandWidgetId })
          }
        >
          {ISLAND_WIDGETS.map((widget) => (
            <option key={widget.id} value={widget.id}>
              {widget.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div>
          <p className="field__label">Pinned widget</p>
          <p className="field__description">
            Automatic lets priority decide what is shown.
          </p>
        </div>
        <select
          className="select"
          value={island.pinnedWidget ?? ""}
          aria-label="Pinned island widget"
          onChange={(event) =>
            void setIslandPreferences({
              pinnedWidget: event.target.value === "" ? null : (event.target.value as IslandWidgetId),
            })
          }
        >
          <option value="">Automatic</option>
          {ISLAND_WIDGETS.map((widget) => (
            <option key={widget.id} value={widget.id}>
              {widget.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div>
          <p className="field__label">Auto rotate</p>
          <p className="field__description">Step through the widgets on a timer.</p>
        </div>
        <select
          className="select"
          value={String(island.autoRotateSeconds)}
          aria-label="Island auto rotate"
          onChange={(event) =>
            void setIslandPreferences({ autoRotateSeconds: Number(event.target.value) })
          }
        >
          <option value="0">Off</option>
          <option value="5">5s</option>
          <option value="10">10s</option>
          <option value="30">30s</option>
        </select>
      </div>

      <div className="field">
        <div>
          <p className="field__label">Enabled widgets</p>
          <p className="field__description">Only these are ever shown.</p>
        </div>
        <div className="scope-toggles">
          {ISLAND_WIDGETS.map((widget) => (
            <label className="scope-toggle" key={widget.id}>
              <input
                type="checkbox"
                checked={island.enabledWidgets.includes(widget.id)}
                onChange={(event) =>
                  void setIslandPreferences({
                    enabledWidgets: event.target.checked
                      ? [...island.enabledWidgets, widget.id]
                      : island.enabledWidgets.filter((entry) => entry !== widget.id),
                  })
                }
              />
              <span>{widget.label}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
