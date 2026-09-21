import { useCallback, useEffect, useState, type JSX } from "react";
import { RefreshCw } from "lucide-react";
import type { GitFileChange, GitStatus } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";

interface ChangesViewProps {
  readonly sessionId: string;
  readonly onError: (message: string) => void;
}

/** Repository state for the session's working directory (spec §28). */
export function ChangesView({ sessionId, onError }: ChangesViewProps): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStatus(await invoke("git.status", { sessionId }));
    } catch (error) {
      onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [sessionId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status && !status.isRepository) {
    return (
      <div className="changes">
        <p className="files__empty">This working directory is not a git repository</p>
      </div>
    );
  }

  return (
    <div className="changes">
      <div className="changes__head">
        <span className="changes__branch">
          {status?.detached ? "detached head" : (status?.branch ?? "...")}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) ? (
          <span className="row__meta">
            {status.ahead > 0 ? `${status.ahead} ahead` : ""}
            {status.ahead > 0 && status.behind > 0 ? " · " : ""}
            {status.behind > 0 ? `${status.behind} behind` : ""}
          </span>
        ) : null}
        <button
          type="button"
          className="quiet-button"
          onClick={() => void load()}
          disabled={loading}
          style={{ marginLeft: "auto" }}
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {status?.clean ? (
        <p className="files__empty">No changes</p>
      ) : (
        <ul className="changes__list">
          {status?.changes.map((change) => (
            <li className="changes__item" key={`${change.path}-${change.kind}`}>
              <span className="changes__badge" data-kind={change.kind}>
                {badgeFor(change)}
              </span>
              <span className="row__text" title={change.path}>
                {change.path}
              </span>
              {change.staged ? <span className="row__meta">staged</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function badgeFor(change: GitFileChange): string {
  switch (change.kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "M";
  }
}
