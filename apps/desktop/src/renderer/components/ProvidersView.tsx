import { useEffect, useState, type JSX } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type {
  ModelInfo,
  ProviderSummary,
  StoredProviderConfig,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { Logo } from "./Logo.js";
import { familyOf } from "../lib/provider-label.js";
// Relative on purpose: the custom-provider package joins the workspace aliases
// when it is promoted to a first-class dependency, and until then this slice
// needs no config, lockfile or core change to validate a custom provider.
import {
  createCustomProfile,
  parseCustomModels,
  type OpenAiCompatibleProfile,
} from "../../../../../packages/providers/openai-compatible/src/profile.js";

interface ProvidersViewProps {
  readonly providers: ProviderSummary[];
  readonly configs: Record<string, StoredProviderConfig>;
}

/**
 * Central provider screen (spec §19). Everything shown comes from the adapter
 * itself — installation, authentication, models, capabilities — and what a
 * user needs to make a command line provider work is editable here: where its
 * executable lives, extra arguments, and the models it may use.
 */
export function ProvidersView({ providers, configs }: ProvidersViewProps): JSX.Element {
  const refreshProviders = useWorkbench((state) => state.refreshProviders);
  const refreshAccounts = useWorkbench((state) => state.refreshAccounts);
  const accounts = useWorkbench((state) => state.accounts);
  const detectedAccounts = useWorkbench((state) => state.detectedAccounts);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  // A family supports several accounts once one is connected, detected, or
  // registered as its own entry. The UI learns this from data, never brands.
  const multiAccountFamilies = new Set([
    ...accounts.map((account) => account.family),
    ...detectedAccounts.map((detected) => detected.family),
    ...providers
      .filter((provider) => provider.metadata.account)
      .map((provider) => familyOf(provider)),
  ]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshProviders();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">Providers</h1>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
            {refreshing ? "Checking" : "Check again"}
          </button>
        </div>

        <section>
          {providers.map((provider) => (
            <ProviderEntry
              key={provider.metadata.id}
              provider={provider}
              config={configs[provider.metadata.id]}
              showAccounts={
                !provider.metadata.account &&
                multiAccountFamilies.has(familyOf(provider))
              }
            />
          ))}
        </section>

        <CustomProviderSection configs={configs} />
      </div>
    </div>
  );
}

function ProviderEntry({
  provider,
  config,
  showAccounts,
}: {
  readonly provider: ProviderSummary;
  readonly config: StoredProviderConfig | undefined;
  readonly showAccounts: boolean;
}): JSX.Element {
  const saveProviderConfig = useWorkbench((state) => state.saveProviderConfig);
  const [path, setPath] = useState(config?.executablePath ?? "");
  const [args, setArgs] = useState((config?.arguments ?? []).join(" "));
  const [models, setModels] = useState(formatModels(provider.models));
  const [saving, setSaving] = useState(false);

  const configurable = provider.metadata.transportTypes.includes("cli");
  const configuredModels = Array.isArray(config?.settings["models"])
    ? (config.settings["models"] as ModelInfo[])
    : [];

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await saveProviderConfig({
        providerId: provider.metadata.id,
        executablePath: path.trim().length > 0 ? path.trim() : null,
        arguments: args.trim().length > 0 ? args.trim().split(/\s+/) : [],
        models: parseModels(models),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="provider-entry">
      <div className="provider-entry__head">
        <Logo
          name={provider.metadata.icon}
          label={provider.metadata.displayName}
          size={18}
        />
        <span className="provider-entry__name">{provider.metadata.displayName}</span>
        <span className="row__meta">{installationLabel(provider)}</span>
        <span className="agents-bar__spacer" />
        <button
          type="button"
          className="quiet-button"
          disabled={saving}
          onClick={() =>
            void saveProviderConfig({
              providerId: provider.metadata.id,
              enabled: !provider.enabled,
            })
          }
          title={
            provider.enabled
              ? "Hide this provider from pickers (existing sessions keep working)"
              : "Show this provider in pickers again"
          }
          aria-label={
            provider.enabled
              ? `Hide ${provider.metadata.displayName}`
              : `Show ${provider.metadata.displayName}`
          }
        >
          {provider.enabled ? "Hide" : "Show"}
        </button>
      </div>

      {provider.metadata.description ? (
        <p className="field__description">{provider.metadata.description}</p>
      ) : null}

      {provider.metadata.notice ? (
        <p className="notice" role="note">
          {provider.metadata.notice}
        </p>
      ) : null}

      <dl className="detail-list">
        <div className="detail">
          <dt className="detail__label">Authentication</dt>
          <dd className="detail__value">{authLabel(provider)}</dd>
        </div>
        <div className="detail">
          <dt className="detail__label">Transport</dt>
          <dd className="detail__value">{provider.metadata.transportTypes.join(", ")}</dd>
        </div>
        {provider.installation.executablePath ? (
          <div className="detail">
            <dt className="detail__label">Executable</dt>
            <dd className="detail__value">{provider.installation.executablePath}</dd>
          </div>
        ) : null}
        <div className="detail">
          <dt className="detail__label">Models</dt>
          <dd className="detail__value">{modelsLabel(provider, configuredModels)}</dd>
        </div>
        <div className="detail">
          <dt className="detail__label">Usage</dt>
          <dd className="detail__value">
            {provider.usage ? usageStateLabel(provider.usage.state) : "Not reported"}
          </dd>
        </div>
      </dl>

      <div className="tag-list">
        {provider.capabilities.supported.map((capability) => (
          <span className="tag" key={capability}>
            {capability}
          </span>
        ))}
      </div>

      {showAccounts ? <AccountsSection family={familyOf(provider)} /> : null}

      {configurable ? (
        <div className="provider-entry__config">
          <label className="stacked-field">
            <span className="field__description">Executable path</span>
            <input
              className="text-input"
              value={path}
              placeholder="Leave empty to search PATH"
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <label className="stacked-field">
            <span className="field__description">Extra arguments</span>
            <input
              className="text-input"
              value={args}
              placeholder="Optional, separated by spaces"
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          <label className="stacked-field">
            <span className="field__description">
              Models, one per line as <code>id</code> or <code>id = Name</code>.
              These tools have no command that lists them, so what you enter
              here is what the session picker offers.
            </span>
            <textarea
              className="text-input text-input--multiline"
              value={models}
              rows={4}
              spellCheck={false}
              placeholder={"gpt-5.5 = GPT-5.5\ngpt-5.4-mini"}
              onChange={(event) => setModels(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving" : "Save and re-check"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** Further sign-ins of one tool, each kept in its own home (spec §39). */
function AccountsSection({ family }: { readonly family: string }): JSX.Element {
  const accounts = useWorkbench((state) =>
    state.accounts.filter((account) => account.family === family),
  );
  const detected = useWorkbench((state) =>
    state.detectedAccounts.filter((candidate) => candidate.family === family),
  );
  const addAccount = useWorkbench((state) => state.addAccount);
  const removeAccount = useWorkbench((state) => state.removeAccount);
  const [label, setLabel] = useState("");
  const [home, setHome] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (entry: { label: string; home?: string }): Promise<void> => {
    if (entry.label.trim().length === 0 || busy) {
      return;
    }
    setBusy(true);
    try {
      const added = await addAccount({
        family,
        label: entry.label.trim(),
        ...(entry.home ? { home: entry.home } : {}),
      });
      if (added) {
        setLabel("");
        setHome("");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <p className="section__label">Accounts</p>
      {accounts.length === 0 ? (
        <p className="field__description">
          The tool&apos;s own sign-in, plus every account below as its own entry.
        </p>
      ) : null}
      {accounts.map((account) => (
        <div className="row" key={account.id} title={account.home}>
          <span className="row__text">{account.label}</span>
          <span className="row__meta">{account.home}</span>
          <button
            type="button"
            className="quiet-button"
            aria-label={`Disconnect ${account.label}`}
            onClick={() => void removeAccount(account.id)}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            Disconnect
          </button>
        </div>
      ))}
      {detected.map((candidate) => (
        <div className="row" key={candidate.home} title={candidate.home}>
          <span className="row__text">{candidate.suggestedLabel}</span>
          <span className="row__meta">{candidate.home}</span>
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() =>
              void add({ label: candidate.suggestedLabel, home: candidate.home })
            }
          >
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            Connect
          </button>
        </div>
      ))}
      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">
            Label for a further account; signing in happens in the tool itself.
          </span>
          <input
            className="text-input"
            value={label}
            placeholder="Work"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">
            Existing home to use, or empty for a fresh one.
          </span>
          <input
            className="text-input"
            value={home}
            placeholder="Optional absolute path"
            spellCheck={false}
            onChange={(event) => setHome(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={busy || label.trim().length === 0}
          onClick={() =>
            void add({
              label,
              ...(home.trim().length > 0 ? { home: home.trim() } : {}),
            })
          }
        >
          <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
          {busy ? "Adding" : "Add account"}
        </button>
      </div>
    </div>
  );
}

/** "id = Display name" per line, which is how the field round-trips. */
function formatModels(models: readonly ModelInfo[]): string {
  return models
    .map((model) =>
      model.displayName && model.displayName !== model.id
        ? `${model.id} = ${model.displayName}`
        : model.id,
    )
    .join("\n");
}

function parseModels(text: string): ModelInfo[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const [rawId, ...rest] = line.split("=");
      const id = (rawId ?? "").trim();
      const displayName = rest.join("=").trim();
      return {
        id,
        displayName: displayName.length > 0 ? displayName : id,
        // The first entry is the one a new session starts with.
        ...(index === 0 ? { isDefault: true } : {}),
      };
    })
    .filter((model) => model.id.length > 0);
}

/** Says where the list came from, so an empty one is not a mystery. */
function modelsLabel(
  provider: ProviderSummary,
  configured: readonly ModelInfo[],
): string {
  if (provider.models.length === 0) {
    return "None yet — add them below";
  }
  const names = provider.models.map((model) => model.displayName).join(", ");
  return configured.length > 0 ? `${names} (yours)` : names;
}

function installationLabel(provider: ProviderSummary): string {
  switch (provider.installation.state) {
    case "installed":
      return provider.installation.version
        ? `Installed · ${provider.installation.version}`
        : "Installed";
    case "notInstalled":
      return "Not installed";
    case "unsupported":
      return "Unsupported on this platform";
    default:
      return "Unknown";
  }
}

function authLabel(provider: ProviderSummary): string {
  switch (provider.auth.state) {
    case "authenticated":
      return provider.auth.accountLabel ?? "Connected";
    case "authenticationRequired":
      return provider.auth.detail ?? "Sign-in required";
    case "authenticationExpired":
      return "Sign-in expired";
    case "notApplicable":
      return provider.auth.detail ?? "Not required";
    case "unsupported":
      return "Not supported";
    default:
      return provider.auth.detail ?? "Unknown";
  }
}

function usageStateLabel(state: string): string {
  switch (state) {
    case "available":
      return "Reported by the provider";
    case "partial":
      return "Partially reported";
    case "estimated":
      return "Estimated";
    default:
      return "Unavailable";
  }
}

/**
 * Custom OpenAI-compatible providers (spec §16, G8): any endpoint that speaks
 * the OpenAI HTTP format — Ollama, llama.cpp, vLLM, OpenRouter, a company
 * gateway. Name, base URL, credential reference and model ids are validated
 * locally into a versioned manifest (`schemaVersion: 1`) and stored on the
 * host, which registers them through `ProviderRegistry.register` with no core
 * changes. Only the credential reference crosses into the renderer — the key
 * itself lives in OS-backed storage and is never pasted here (spec §57).
 */
function CustomProviderSection({
  configs,
}: {
  readonly configs: Record<string, StoredProviderConfig>;
}): JSX.Element {
  const saveProviderConfig = useWorkbench((state) => state.saveProviderConfig);
  const refreshProviders = useWorkbench((state) => state.refreshProviders);
  const summaries = useWorkbench((state) => state.providers);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyReference, setKeyReference] = useState("");
  const [models, setModels] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const activeIds = new Set(summaries.map((summary) => summary.metadata.id));
  const saved = Object.values(configs).filter(
    (config) =>
      config.providerId.startsWith("custom-") ||
      config.baseUrl !== null ||
      config.credentialReference !== null,
  );

  const save = async (): Promise<void> => {
    setNotice(null);
    setProblem(null);
    let profile: OpenAiCompatibleProfile;
    try {
      profile = createCustomProfile({
        displayName: name,
        baseUrl,
        ...(keyReference.trim().length > 0
          ? { credentialReference: keyReference.trim() }
          : {}),
        models: parseCustomModels(models),
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    setSaving(true);
    try {
      await saveProviderConfig({
        providerId: profile.id,
        baseUrl: profile.baseUrl,
        credentialReference: profile.credentialReference ?? null,
        defaultModel: profile.defaultModel ?? null,
        models: profile.models,
      });
      await refreshProviders();
      const active = useWorkbench
        .getState()
        .providers.some((summary) => summary.metadata.id === profile.id);
      setNotice(
        active
          ? `Saved. "${profile.displayName}" is active.`
          : `Saved. "${profile.displayName}" is stored and appears here once the host loads custom providers at startup.`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Custom providers">
      <p className="section__label">Custom providers</p>
      <p className="field__description">
        An OpenAI-compatible server of your own. The secret itself is never
        pasted here: keep it in the operating system&apos;s keychain and enter
        only its credential reference, or leave it empty for servers that need
        no key.
      </p>
      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input
            className="text-input"
            value={name}
            placeholder="Local Llama"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">OpenAI base URL</span>
          <input
            className="text-input"
            value={baseUrl}
            placeholder="http://localhost:11434/v1"
            spellCheck={false}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">API key reference, if the server needs one</span>
          <input
            className="text-input"
            value={keyReference}
            placeholder="Optional credential reference"
            spellCheck={false}
            onChange={(event) => setKeyReference(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">
            Models, one per line as <code>id</code> or <code>id = Name</code>.
          </span>
          <textarea
            className="text-input text-input--multiline"
            value={models}
            rows={3}
            spellCheck={false}
            placeholder={"llama3.1 = Llama 3.1\nqwen2.5"}
            onChange={(event) => setModels(event.target.value)}
          />
        </label>
        {problem ? (
          <p className="notice" role="alert">
            {problem}
          </p>
        ) : null}
        {notice ? (
          <p className="field__description" role="status">
            {notice}
          </p>
        ) : null}
        <button
          type="button"
          className="ghost-button"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "Saving" : "Save custom provider"}
        </button>
      </div>
      {saved.map((config) => (
        <div className="row" key={config.providerId} title={config.baseUrl ?? ""}>
          <span className="row__text">{config.providerId}</span>
          <span className="row__meta">{storedCustomLabel(config, activeIds)}</span>
        </div>
      ))}
    </section>
  );
}

/** What a stored custom configuration holds, and whether it is active. */
function storedCustomLabel(
  config: StoredProviderConfig,
  activeIds: ReadonlySet<string>,
): string {
  const models = Array.isArray(config.settings["models"])
    ? (config.settings["models"] as ModelInfo[]).length
    : 0;
  const state = activeIds.has(config.providerId) ? "active" : "stored";
  return `${models} model${models === 1 ? "" : "s"} · ${state}`;
}
