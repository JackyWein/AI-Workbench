import { useEffect, useState, type JSX } from "react";
import type { UpdateState } from "@ai-workbench/shared";
import { describeError, invoke, onAppEvent } from "../lib/client.js";

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

/**
 * Shown before the first status arrives, so event handlers and the view
 * never deal with a missing object; early events update it instead of
 * being dropped.
 */
const DEFAULT_STATUS: UpdateState = {
  status: "idle",
  currentVersion: "",
  availableVersion: null,
  releaseNotes: null,
  error: null,
  progress: null,
};

/**
 * Updates over GitHub Releases. The app only ever checks on its own; the
 * download and the install each wait for an explicit confirmation here, so
 * there is no silent fetch and no silent restart.
 */
export function UpdateSection({ currentVersion }: UpdateSectionProps): JSX.Element {
  const [status, setStatus] = useState<UpdateState>(DEFAULT_STATUS);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke("update.getStatus", undefined).then(
      (next) => {
        if (!cancelled) {
          setStatus(next);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setActionError(describeError(error));
        }
      },
    );
    const detach = onAppEvent((event) => {
      switch (event.type) {
        case "update.checking":
          setStatus((previous) => ({ ...previous, status: "checking", error: null }));
          break;
        case "update.available":
          setStatus((previous) => ({
            ...previous,
            status: "available",
            availableVersion: event.version,
            releaseNotes: event.releaseNotes,
            error: null,
            progress: null,
          }));
          break;
        case "update.progress":
          setStatus((previous) => ({
            ...previous,
            status: "downloading",
            progress: event.percent,
          }));
          break;
        case "update.downloaded":
          setStatus((previous) => ({
            ...previous,
            status: "downloaded",
            availableVersion: event.version,
            progress: 100,
            error: null,
          }));
          break;
        case "update.not-available":
          setStatus((previous) => ({
            ...previous,
            status: "not-available",
            availableVersion: null,
            releaseNotes: null,
            error: null,
            progress: null,
          }));
          break;
        case "update.error":
          setStatus((previous) => ({ ...previous, status: "error", error: event.message }));
          break;
        default:
          break;
      }
    });
    return () => {
      cancelled = true;
      detach();
    };
  }, []);

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
    <section>
      <p className="section__label">Updates</p>
      <p className="field__description">
        New versions come from GitHub Releases. The app checks on startup, but
        nothing is downloaded or installed without your confirmation here.
      </p>

      <div className="field">
        <div>
          <p className="field__label">Current version</p>
          <p className="field__description">
            {currentVersion ?? (status.currentVersion || "Unknown")}
          </p>
        </div>
        <button
          type="button"
          className="ghost-button"
          disabled={busy === true}
          onClick={handleCheck}
        >
          {status.status === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <div className="field">
        <div>
          <p className="field__label">Status</p>
          <p className="field__description">{statusText(status)}</p>
        </div>
      </div>

      {status.status === "available" && status.availableVersion ? (
        <div className="field">
          <div>
            <p className="field__label">Version {status.availableVersion} available</p>
            {status.releaseNotes ? (
              <p className="field__description">{status.releaseNotes}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="ghost-button"
            disabled={busy === true}
            onClick={handleDownload}
          >
            Download update
          </button>
        </div>
      ) : null}

      {status.status === "downloaded" ? (
        <div className="field">
          <div>
            <p className="field__label">Ready to install</p>
            <p className="field__description">
              The update is downloaded. Installing restarts the app.
            </p>
          </div>
          <button type="button" className="ghost-button" onClick={handleInstall}>
            Install now &amp; restart
          </button>
        </div>
      ) : null}

      {actionError ? <p className="field__description">{actionError}</p> : null}
    </section>
  );
}
