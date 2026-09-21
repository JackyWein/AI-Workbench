import { useEffect, useState, type JSX } from "react";
import { Unplug } from "lucide-react";
import type { PluginManifest, PluginScopes } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { ScopeToggle } from "./SkillsView.js";

/**
 * Plugins give an agent access to an external service (spec §32). An account is
 * connected once and serves every plugin of the same account type (spec §34);
 * the secret is sent to the main process once and never comes back.
 */
export function PluginsView(): JSX.Element {
  const plugins = useWorkbench((state) => state.plugins);
  const scopes = useWorkbench((state) => state.pluginScopes);
  const accounts = useWorkbench((state) => state.pluginAccounts);
  const refreshPlugins = useWorkbench((state) => state.refreshPlugins);
  const disconnectAccount = useWorkbench((state) => state.disconnectAccount);
  const hasSession = useWorkbench((state) => state.activeSessionId !== null);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">Plugins</h1>
        </div>

        {plugins.length === 0 ? (
          <p className="field__description">
            No plugins installed yet.
          </p>
        ) : (
          <section>
            {plugins.map((plugin) => (
              <PluginEntry
                key={plugin.id}
                plugin={plugin}
                scopes={scopes}
                hasSession={hasSession}
                connected={accounts.some(
                  (account) => account.accountType === plugin.authentication.accountType,
                )}
              />
            ))}
          </section>
        )}

        <div className="view__header">
          <h2 className="view__title">Accounts</h2>
        </div>

        {accounts.length === 0 ? (
          <p className="field__description">
            No accounts connected. An account is shared by every plugin that uses
            the same service.
          </p>
        ) : (
          <section>
            {accounts.map((account) => (
              <article className="provider-entry" key={account.id}>
                <div className="provider-entry__head">
                  <span className="provider-entry__name">{account.label}</span>
                  <span className="row__meta">{account.accountType}</span>
                </div>
                <p className="field__description">
                  The secret is stored by the operating system; only a reference
                  is kept here.
                </p>
                <div className="provider-entry__config">
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => void disconnectAccount(account.id)}
                  >
                    <Unplug size={13} strokeWidth={1.75} aria-hidden="true" />
                    Disconnect
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}

        <ConnectAccountForm />
      </div>
    </div>
  );
}

function PluginEntry({
  plugin,
  scopes,
  hasSession,
  connected,
}: {
  readonly plugin: PluginManifest;
  readonly scopes: PluginScopes;
  readonly hasSession: boolean;
  readonly connected: boolean;
}): JSX.Element {
  const setPluginEnabled = useWorkbench((state) => state.setPluginEnabled);
  const needsAccount = plugin.authentication.kind !== "none";

  const decision = (scope: keyof PluginScopes): boolean | undefined =>
    scopes[scope]?.find((entry) => entry.pluginId === plugin.id)?.enabled;

  return (
    <article className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">{plugin.name}</span>
        <span className="row__meta">{plugin.version}</span>
      </div>

      {plugin.description ? (
        <p className="field__description">{plugin.description}</p>
      ) : null}

      {needsAccount && !connected ? (
        <p className="notice" role="note">
          Needs a connected {plugin.authentication.accountType ?? "account"}{" "}
          account before it can be used.
        </p>
      ) : null}

      <div className="scope-toggles">
        <ScopeToggle
          label="Everywhere"
          checked={decision("global") ?? false}
          onChange={(value) => void setPluginEnabled(plugin.id, "global", value)}
        />
        <ScopeToggle
          label="This session"
          checked={decision("session") ?? false}
          disabled={!hasSession}
          onChange={(value) => void setPluginEnabled(plugin.id, "session", value)}
        />
      </div>

      {plugin.tools.length > 0 ? (
        <div className="tag-list">
          {plugin.tools.map((tool) => (
            <span className="tag" key={tool.name}>
              {tool.name}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ConnectAccountForm(): JSX.Element {
  const connectAccount = useWorkbench((state) => state.connectAccount);
  const [accountType, setAccountType] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    if (!accountType.trim() || !label.trim() || !secret) {
      return;
    }
    setSaving(true);
    try {
      await connectAccount({
        accountType: accountType.trim(),
        label: label.trim(),
        secret,
      });
      // The secret leaves the renderer's memory as soon as it is stored.
      setSecret("");
      setLabel("");
      setAccountType("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">Connect an account</span>
      </div>
      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">Account type</span>
          <input
            className="text-input"
            value={accountType}
            placeholder="The service the plugins share, e.g. github"
            onChange={(event) => setAccountType(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Label</span>
          <input
            className="text-input"
            value={label}
            placeholder="How you want to recognize it"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Secret</span>
          <input
            className="text-input"
            type="password"
            value={secret}
            autoComplete="off"
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void submit()}
          disabled={saving || !accountType.trim() || !label.trim() || !secret}
        >
          {saving ? "Connecting" : "Connect"}
        </button>
      </div>
    </section>
  );
}
