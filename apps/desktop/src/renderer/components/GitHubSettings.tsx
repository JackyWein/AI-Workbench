import { useCallback, useEffect, useState, type JSX } from "react";
import type { GitHubStatus } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import { SettingGroup, SettingRow } from "./Controls.js";

/**
 * The GitHub connection used to push and open pull requests. The token goes
 * to the credential store in the main process; this screen only ever learns
 * who is connected.
 */
export function GitHubSettings(): JSX.Element {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await invoke("github.status", undefined));
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a sign-in waits for the code to be entered on GitHub, look again
  // every few seconds; it completes in the main process.
  useEffect(() => {
    if (!status?.pending) {
      return undefined;
    }
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [status?.pending, load]);

  const act = async (action: () => Promise<GitHubStatus>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const description = status?.connected
    ? `Connected as ${status.login ?? "your account"}. Pushes to GitHub and pull requests use this account.`
    : "Push to GitHub and open pull requests. The token stays in this computer's secure storage.";

  return (
    <SettingGroup title="GitHub">
      <SettingRow label="Account" description={description}>
        {status?.connected ? (
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void act(() => invoke("github.signOut", undefined))}>
            Disconnect
          </button>
        ) : status?.deviceFlowAvailable ? (
          <button
            type="button"
            className="ghost-button"
            disabled={busy || Boolean(status.pending)}
            onClick={() => void act(() => invoke("github.startDeviceFlow", undefined))}
          >
            Sign in with GitHub
          </button>
        ) : null}
      </SettingRow>
      {status?.pending ? (
        <SettingRow
          label="Enter this code on GitHub"
          description={`GitHub's page opened in your browser: ${status.pending.verificationUri}`}
        >
          <code className="github-code">{status.pending.userCode}</code>
        </SettingRow>
      ) : null}
      {status && !status.connected ? (
        <SettingRow
          label="Or connect with a token"
          description="A fine-grained token with access to the repositories' contents and pull requests."
        >
          <form
            className="github-token"
            onSubmit={(event) => {
              event.preventDefault();
              const value = token;
              setToken("");
              void act(() => invoke("github.signInWithToken", { token: value }));
            }}
          >
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              aria-label="GitHub token"
              placeholder="github_pat_…"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="submit" className="ghost-button" disabled={busy || token.trim() === ""}>
              Connect
            </button>
          </form>
        </SettingRow>
      ) : null}
      {error ?? status?.error ? (
        <p className="setting__error" role="alert">
          {error ?? status?.error}
        </p>
      ) : null}
    </SettingGroup>
  );
}
