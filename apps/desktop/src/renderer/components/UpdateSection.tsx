import { useEffect, useState, type JSX } from "react";
import type { UpdateState } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import { useWorkbench } from "../store/workbench.js";
import { SettingRow, Switch } from "./Controls.js";

interface UpdateSectionProps {
  readonly currentVersion: string | null;
}

/** What is on offer: a new version, or a new build of this one. */
function offered(state: UpdateState): string {
  if (state.availableVersion && state.availableVersion === state.currentVersion) {
    return `A new build of ${state.availableVersion}${state.availableBuild ? ` (${state.availableBuild})` : ""}`;
  }
  return state.availableVersion ? `Version ${state.availableVersion}` : "An update";
}

function statusText(state: UpdateState): string {
  switch (state.status) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `${offered(state)} is available.`;
    case "downloading":
      return state.progress === null
        ? `Downloading ${offered(state).toLowerCase()}…`
        : `Downloading ${offered(state).toLowerCase()}… ${Math.round(state.progress)}%`;
    case "downloaded":
      return state.automatic
        ? `${offered(state)} is ready. It installs when AI Workbench quits, or restart now.`
        : `${offered(state)} is downloaded and ready to install.`;
    case "not-available":
      return "You are up to date.";
    case "error":
      return state.error ?? "The update check failed.";
  }
}

/** Shown before the first status arrives. */
const DEFAULT_STATUS: UpdateState = {
  status: "idle",
  currentVersion: "",
  availableVersion: null,
  releaseNotes: null,
  error: null,
  progress: null,
  installsItself: true,
  manualReason: null,
  releaseUrl: null,
  currentBuild: null,
  availableBuild: null,
  automatic: true,
};

/**
 * Updates over GitHub Releases, as rows of the About group. The app checks
 * on its own, at start and every hour. A release is new by its version or,
 * for the same version, by the commit it was built from. With automatic
 * updates on it downloads in the background and installs when the app
 * quits; off, the download and the install each wait for the person. A
 * build that cannot replace itself says why and opens the release page.
 */
export function UpdateSection({ currentVersion }: UpdateSectionProps): JSX.Element {
  const status = useWorkbench((state) => state.update) ?? DEFAULT_STATUS;
  const refreshUpdate = useWorkbench((state) => state.refreshUpdate);
  const automatic = useWorkbench((state) => state.settings.autoUpdate);
  const updateSettings = useWorkbench((state) => state.updateSettings);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void refreshUpdate();
  }, [refreshUpdate]);

  const busy = status.status === "checking" || status.status === "downloading";

  const handleCheck = (): void => {
    setActionError(null);
    void invoke("update.check", undefined).catch((error: unknown) => {
      setActionError(describeError(error));
    });
  };

  const handleDownload = (): void => {
    if (status.availableVersion === null) {
      return;
    }
    if (!status.installsItself) {
      setActionError(null);
      void invoke("update.openReleasePage", undefined).catch((error: unknown) => {
        setActionError(describeError(error));
      });
      return;
    }
    const confirmed = window.confirm(
      `Download AI Workbench ${status.availableVersion} now?`,
    );
    if (!confirmed) {
      return;
    }
    setActionError(null);
    void invoke("update.download", undefined).catch((error: unknown) => {
      setActionError(describeError(error));
    });
  };

  const handleInstall = (): void => {
    const confirmed = window.confirm(
      "Install the downloaded update and restart AI Workbench now?",
    );
    if (!confirmed) {
      return;
    }
    setActionError(null);
    void invoke("update.install", undefined).catch((error: unknown) => {
      setActionError(describeError(error));
    });
  };

  return (
    <>
      <SettingRow
        label={`AI Workbench ${currentVersion ?? (status.currentVersion || "")}${
          status.currentBuild ? ` · build ${status.currentBuild}` : ""
        }`.trim()}
        description={statusText(status)}
      >
        <button
          type="button"
          className="ghost-button"
          disabled={busy}
          onClick={handleCheck}
        >
          {status.status === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </SettingRow>

      <SettingRow
        label="Update automatically"
        description={
          status.installsItself
            ? "New versions download in the background and install when AI Workbench quits."
            : "This build can't replace itself; it checks in the background and says when there is a new version."
        }
      >
        <Switch
          label="Update automatically"
          checked={automatic}
          onChange={(autoUpdate) => void updateSettings({ autoUpdate })}
        />
      </SettingRow>

      {status.status === "available" && status.availableVersion ? (
        <SettingRow
          label={`${offered(status)} is available`}
          description={
            <>
              {status.installsItself ? null : (
                <>
                  {status.manualReason}
                  <br />
                </>
              )}
              <span className="update-notes">
                {status.releaseNotes ?? "Nothing is downloaded until you say so."}
              </span>
            </>
          }
        >
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={handleDownload}
          >
            {status.installsItself ? "Download" : "Open download page"}
          </button>
        </SettingRow>
      ) : null}

      {status.status === "downloaded" ? (
        <SettingRow
          label="Ready to install"
          description={
            status.automatic
              ? "It installs by itself when AI Workbench quits. Restart now to have it at once."
              : "Installing restarts the app."
          }
        >
          <button type="button" className="primary-button" onClick={handleInstall}>
            Install &amp; restart
          </button>
        </SettingRow>
      ) : null}

      {actionError ? (
        <p className="setting__error" role="alert">
          {actionError}
        </p>
      ) : null}
    </>
  );
}
