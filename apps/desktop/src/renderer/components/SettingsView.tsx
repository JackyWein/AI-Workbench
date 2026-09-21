import type { JSX } from "react";
import type { AppSettings } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

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
