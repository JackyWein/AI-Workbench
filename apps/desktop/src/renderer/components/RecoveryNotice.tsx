import { type JSX, useEffect, useState } from "react";
import { invoke } from "../lib/client.js";

interface Recovery {
  readonly uncleanExit: boolean;
  readonly previousStartedAt: Date | null;
  readonly reportPath: string | null;
  readonly recoveredTurns: number;
  readonly recoveredTeamRuns: number;
  readonly recoveredTeamTurns: number;
}

/**
 * Says once, after a start, that the previous run did not end cleanly and
 * what was put right: team runs paused where they were, answers that were cut
 * off marked as such. Nothing is resumed for the person — resuming spends
 * their quota — so the notice tells them where to do it.
 */
export function RecoveryNotice(): JSX.Element | null {
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let current = true;
    void invoke("app.getRecovery", undefined)
      .then((value) => {
        if (current) {
          setRecovery(value);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  if (dismissed || !recovery) {
    return null;
  }
  const worthSaying =
    recovery.uncleanExit || recovery.recoveredTeamRuns > 0 || recovery.recoveredTurns > 0;
  if (!worthSaying) {
    return null;
  }

  const lines: string[] = [];
  if (recovery.recoveredTeamRuns > 0) {
    lines.push(
      recovery.recoveredTeamRuns === 1
        ? "A team run was paused where it stopped. Open its session and choose Resume to continue."
        : `${recovery.recoveredTeamRuns} team runs were paused where they stopped. Open their sessions and choose Resume to continue.`,
    );
  }
  if (recovery.recoveredTurns > 0) {
    lines.push(
      recovery.recoveredTurns === 1
        ? "An answer that was cut off is marked as interrupted."
        : `${recovery.recoveredTurns} answers that were cut off are marked as interrupted.`,
    );
  }
  if (lines.length === 0) {
    lines.push("Nothing was left half-done.");
  }

  return (
    <div className="recovery-notice" role="status">
      <div className="recovery-notice__body">
        <p className="recovery-notice__title">
          {recovery.uncleanExit
            ? "AI Workbench did not close properly last time"
            : "Unfinished work was recovered"}
        </p>
        {lines.map((line) => (
          <p className="recovery-notice__line" key={line}>
            {line}
          </p>
        ))}
      </div>
      <div className="recovery-notice__actions">
        {recovery.reportPath ? (
          <button
            type="button"
            className="quiet-button"
            onClick={() => void invoke("app.openCrashReports", undefined).catch(() => undefined)}
          >
            Crash report
          </button>
        ) : null}
        <button type="button" className="quiet-button" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
