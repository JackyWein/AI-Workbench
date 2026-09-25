import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { ArrowDown, ArrowUp, GitBranch, GitPullRequest, RefreshCw, Sparkles } from "lucide-react";
import type { GitFileChange, GitHubStatus, GitStatus, SecretFinding } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";

interface ChangesViewProps {
  readonly sessionId: string;
  readonly onError: (message: string) => void;
}

/**
 * Source control for the session's working directory (spec §28,
 * FutureFeatures 2): what changed, what the next commit holds, the commit
 * itself — checked for likely secrets first — and the way to the remote.
 */
export function ChangesView({ sessionId, onError }: ChangesViewProps): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [github, setGithub] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [findings, setFindings] = useState<readonly SecretFinding[] | null>(null);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Guards async loads against fast switching: only the latest request may
  // write its result. Stale answers are dropped.
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const token = ++requestRef.current;
    setLoading(true);
    try {
      const [next, connection] = await Promise.all([
        invoke("git.status", { sessionId }),
        invoke("github.status", undefined).catch(() => null),
      ]);
      if (requestRef.current !== token) {
        return;
      }
      setStatus(next);
      setGithub(connection);
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

  /** Runs one operation at a time and shows what it left behind. */
  const run = async (label: string, action: () => Promise<GitStatus | void>): Promise<void> => {
    setWorking(label);
    setNotice(null);
    try {
      const next = await action();
      if (next) {
        setStatus(next);
      }
    } catch (error) {
      onError(describeError(error));
    } finally {
      setWorking(null);
    }
  };

  const toggleStaged = (change: GitFileChange): Promise<void> =>
    run("stage", () =>
      invoke(change.staged ? "git.unstage" : "git.stage", { sessionId, paths: [change.path] }),
    );

  const commit = (allowSecrets = false): Promise<void> =>
    run("commit", async () => {
      const result = await invoke("git.commit", {
        sessionId,
        message: message.trim(),
        ...(allowSecrets ? { allowSecrets: true } : {}),
      });
      if (!result.committed) {
        setFindings(result.findings);
        return;
      }
      setFindings(null);
      setMessage("");
      setNotice(`Committed ${result.commit.slice(0, 7)}`);
      return invoke("git.status", { sessionId });
    });

  const suggest = (): Promise<void> =>
    run("suggest", async () => {
      const suggested = await invoke("git.suggestMessage", { sessionId });
      setMessage(suggested.message);
    });

  if (status && !status.isRepository) {
    return (
      <div className="changes">
        <p className="files__empty">This working directory is not a git repository</p>
      </div>
    );
  }

  const staged = status?.changes.filter((change) => change.staged).length ?? 0;
  const busy = working !== null;

  return (
    <div className="changes">
      <div className="changes__head">
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="changes__icon" />
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
        <div className="changes__actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => void run("pull", () => invoke("git.pull", { sessionId }))}
            disabled={busy || !status?.upstream}
            title={status?.upstream ? `Pull from ${status.upstream}` : "This branch has no upstream yet"}
          >
            <ArrowDown size={12} strokeWidth={1.75} aria-hidden="true" />
            {working === "pull" ? "Pulling…" : "Pull"}
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void run("push", () => invoke("git.push", { sessionId }))}
            disabled={busy || !status?.branch || status.detached}
          >
            <ArrowUp size={12} strokeWidth={1.75} aria-hidden="true" />
            {working === "push" ? "Pushing…" : "Push"}
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setBranchName((current) => (current === null ? "" : null))}
            disabled={busy}
            aria-expanded={branchName !== null}
          >
            New branch
          </button>
          <button type="button" className="quiet-button" onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {branchName !== null ? (
        <form
          className="changes__branch-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = branchName.trim();
            if (name) {
              void run("branch", () => invoke("git.createBranch", { sessionId, name })).then(() => setBranchName(null));
            }
          }}
        >
          <input
            className="text-input"
            aria-label="New branch name"
            placeholder="feature/name"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            autoFocus
          />
          <button type="submit" className="ghost-button" disabled={busy || branchName.trim() === ""}>
            Create and switch
          </button>
        </form>
      ) : null}

      {status?.clean ? (
        <p className="files__empty">{notice ?? "No changes"}</p>
      ) : (
        <ul className="changes__list">
          {status?.changes.map((change) => (
            <ChangeRow
              key={`${change.path}-${change.kind}`}
              sessionId={sessionId}
              change={change}
              disabled={busy}
              onToggle={() => void toggleStaged(change)}
            />
          ))}
        </ul>
      )}

      {status && !status.clean ? (
        <div className="changes__commit">
          <textarea
            className="text-input changes__message"
            aria-label="Commit message"
            placeholder={staged > 0 ? `Message for ${staged} staged ${staged === 1 ? "file" : "files"}` : "Tick the files to commit"}
            rows={3}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="changes__commit-actions">
            <button
              type="button"
              className="quiet-button"
              onClick={() => void suggest()}
              disabled={busy || staged === 0}
              title="The session's model writes a message from the staged changes"
            >
              <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
              {working === "suggest" ? "Suggesting…" : "Suggest"}
            </button>
            {notice ? <span className="row__meta">{notice}</span> : null}
            <button
              type="button"
              className="primary-button push-right"
              onClick={() => void commit()}
              disabled={busy || staged === 0 || message.trim() === ""}
            >
              {working === "commit" ? "Committing…" : "Commit"}
            </button>
          </div>
          {findings ? (
            <div className="changes__findings" role="alert">
              <p className="changes__findings-title">
                This commit holds what looks like {findings.length === 1 ? "a secret" : `${findings.length} secrets`}.
                Nothing was committed.
              </p>
              <ul>
                {findings.map((finding, index) => (
                  <li key={`${finding.file ?? ""}:${finding.line}:${index}`}>
                    {finding.kind} in {finding.file ?? "the change"}:{finding.line}{" "}
                    <code>{finding.preview}</code>
                  </li>
                ))}
              </ul>
              <div className="changes__commit-actions">
                <button type="button" className="ghost-button" onClick={() => setFindings(null)}>
                  Go back
                </button>
                <button type="button" className="ghost-button" data-tone="danger" onClick={() => void commit(true)} disabled={busy}>
                  Commit anyway
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {github?.connected && status?.upstream && status.branch ? (
        <PullRequestForm sessionId={sessionId} branch={status.branch} onError={onError} />
      ) : null}
    </div>
  );
}

/** Opens a pull request for the pushed branch on the connected GitHub. */
function PullRequestForm({
  sessionId,
  branch,
  onError,
}: {
  readonly sessionId: string;
  readonly branch: string;
  readonly onError: (message: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<{ number: number; url: string } | null>(null);

  if (!open) {
    return (
      <div className="changes__pr">
        <button type="button" className="quiet-button" onClick={() => setOpen(true)}>
          <GitPullRequest size={12} strokeWidth={1.75} aria-hidden="true" />
          Open pull request for {branch}
        </button>
        {opened ? (
          <a className="row__meta" href={opened.url} target="_blank" rel="noreferrer">
            #{opened.number} opened
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="changes__pr changes__pr--open"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void invoke("git.openPullRequest", { sessionId, title: title.trim(), ...(body.trim() ? { body } : {}) })
          .then((result) => {
            setOpened(result);
            setOpen(false);
            setTitle("");
            setBody("");
          })
          .catch((error: unknown) => onError(describeError(error)))
          .finally(() => setBusy(false));
      }}
    >
      <input
        className="text-input"
        aria-label="Pull request title"
        placeholder="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        autoFocus
      />
      <textarea
        className="text-input changes__message"
        aria-label="Pull request description"
        placeholder="What changed and why"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="changes__commit-actions">
        <button type="button" className="ghost-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="primary-button push-right" disabled={busy || title.trim() === ""}>
          {busy ? "Opening…" : "Open pull request"}
        </button>
      </div>
    </form>
  );
}

const DIFF_LINE_CAP = 60;

function ChangeRow({
  sessionId,
  change,
  disabled,
  onToggle,
}: {
  readonly sessionId: string;
  readonly change: GitFileChange;
  readonly disabled: boolean;
  readonly onToggle: () => void;
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
      <div className="changes__row">
      <input
        type="checkbox"
        className="changes__stage"
        checked={change.staged}
        disabled={disabled || change.kind === "conflicted"}
        onChange={onToggle}
        aria-label={`${change.staged ? "Unstage" : "Stage"} ${change.path}`}
      />
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
      </div>
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
