import { useState, type JSX } from "react";
import { ArrowUpCircle } from "lucide-react";
import { describeError, invoke } from "../lib/client.js";
import { useWorkbench } from "../store/workbench.js";

/**
 * A downloaded update asks once whether to restart for it: "Restart now"
 * installs it without the setup wizard and opens the app again by itself;
 * "Later" leaves it — with automatic updates on it installs when the app
 * quits, and "Restart to update" stays in the sidebar and Settings. The
 * island asks the same question, and an answer in either place is the
 * answer in both.
 */
export function UpdatePrompt(): JSX.Element | null {
  const update = useWorkbench((state) => state.update);
  const refreshUpdate = useWorkbench((state) => state.refreshUpdate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (
    !update ||
    update.status !== "downloaded" ||
    !update.installsItself ||
    update.deferred ||
    !update.availableVersion
  ) {
    return null;
  }

  const build =
    update.availableVersion === update.currentVersion && update.availableBuild
      ? ` (build ${update.availableBuild})`
      : "";

  const restart = (): void => {
    setPending(true);
    setError(null);
    void invoke("update.install", undefined).then(
      (result) => {
        if (!result.installing) {
          setPending(false);
          setError("The update could not be installed. Try again from Settings.");
        }
      },
      (reason: unknown) => {
        setPending(false);
        setError(describeError(reason));
      },
    );
  };

  const later = (): void => {
    setError(null);
    void invoke("update.defer", undefined)
      .then(() => refreshUpdate())
      .catch((reason: unknown) => setError(describeError(reason)));
  };

  return (
    <div className="update-prompt" role="alertdialog" aria-labelledby="update-prompt-title">
      <ArrowUpCircle className="update-prompt__icon" size={18} strokeWidth={1.75} aria-hidden="true" />
      <div className="update-prompt__body">
        <p className="update-prompt__title" id="update-prompt-title">
          Update ready
        </p>
        <p className="update-prompt__text">
          AI Workbench {update.availableVersion}
          {build} is downloaded. Restart now to install it — the app opens again by itself.
          {update.automatic ? " Later installs it when you quit." : ""}
        </p>
        {error ? <p className="update-prompt__error">{error}</p> : null}
        <div className="update-prompt__actions">
          <button type="button" className="ghost-button" onClick={later} disabled={pending}>
            Later
          </button>
          <button type="button" className="primary-button" onClick={restart} disabled={pending}>
            {pending ? "Restarting…" : "Restart now"}
          </button>
        </div>
      </div>
    </div>
  );
}
