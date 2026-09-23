import { useEffect, useState, type JSX } from "react";
import type { UpdateState } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import { useWorkbench } from "../store/workbench.js";
import { SettingRow } from "./Controls.js";

interface UpdateSectionProps {
  readonly currentVersion: string | null;
}

function statusText(state: UpdateState): string {
  switch (state.status) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return state.availableVersion
        ? `Version ${state.availableVersion} is available.`
        : "An update is available.";
    case "downloading":
      return state.progress === null
        ? "Downloading…"
        : `Downloading… ${Math.round(state.progress)}%`;
    case "downloaded":
      return "The update is downloaded and ready to install.";
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
};

/**
 * Updates over GitHub Releases, as rows of the About group. The app checks
 * on its own, at start and every few hours; the download and the install
 * each wait for the person. A build that cannot replace itself says why and
 * opens the release page instead.
 */
export function UpdateSection({ currentVersion }: UpdateSectionProps): JSX.Element {
  const status = useWorkbench((state) => state.update) ?? DEFAULT_STATUS;
  const refreshUpdate = useWorkbench((state) => state.refreshUpdate);
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
        label={`AI Workbench ${currentVersion ?? (status.currentVersion || "")}`.trim()}
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

      {status.status === "available" && status.availableVersion ? (
        <SettingRow
          label={`Version ${status.availableVersion} is available`}
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
          description="Installing restarts the app."
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
