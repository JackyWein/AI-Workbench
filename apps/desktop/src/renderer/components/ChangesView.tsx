import { useCallback, useEffect, useRef, useState, type JSX } from "react";
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
  // Guards async loads against fast switching: only the latest request may
  // write its result. Stale answers are dropped.
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const token = ++requestRef.current;
    setLoading(true);
    try {
      const next = await invoke("git.status", { sessionId });
      if (requestRef.current !== token) {
        return;
      }
      setStatus(next);
    } catch (error) {
      if (requestRef.current !== token) {
        return;
      }
      onError(describeError(error));
    } finally {
      if (requestRef.current === token) {
        setLoading(false);
      }
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
          className="quiet-button push-right"
          onClick={() => void load()}
          disabled={loading}
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
            <ChangeRow key={`${change.path}-${change.kind}`} sessionId={sessionId} change={change} />
          ))}
        </ul>
      )}
    </div>
  );
}

const DIFF_LINE_CAP = 60;

function ChangeRow({
  sessionId,
  change,
}: {
  readonly sessionId: string;
  readonly change: GitFileChange;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && diff === null && !failed && !loading) {
      setLoading(true);
      try {
        const result = await invoke("git.diff", {
          sessionId,
          path: change.path,
          staged: change.staged,
        });
        setDiff(result.diff);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <li className="changes__item changes__item--expandable">
      <button
        type="button"
        className="changes__rowbtn"
        onClick={() => void toggle()}
        aria-expanded={open}
      >
        <span className="changes__badge" data-kind={change.kind}>
          {badgeFor(change)}
        </span>
        <span className="row__text" title={change.path}>
          {change.path}
        </span>
        {change.staged ? <span className="row__meta">staged</span> : null}
      </button>
      {open ? (
        <div className="diff-preview">
          {loading ? (
            <p className="row__meta">Loading diff…</p>
          ) : failed || diff === null ? (
            <p className="row__meta">Diff unavailable</p>
          ) : diff.trim().length === 0 ? (
            <p className="row__meta">No textual diff</p>
          ) : (
            <pre className="diff-preview__pre">
              {diff
                .split("\n")
                .slice(0, DIFF_LINE_CAP)
                .map((line, index) => (
                  <span
                    key={index}
                    className="diff-preview__line"
                    data-kind={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "add"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "del"
                          : "ctx"
                    }
                  >
                    {line || " "}
                  </span>
                ))}
              {diff.split("\n").length > DIFF_LINE_CAP ? (
                <span className="row__meta">… truncated</span>
              ) : null}
            </pre>
          )}
        </div>
      ) : null}
    </li>
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
