import { useState, type JSX } from "react";
import { RefreshCw } from "lucide-react";
import type {
  ModelInfo,
  ProviderSummary,
  StoredProviderConfig,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

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
  const [refreshing, setRefreshing] = useState(false);

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
            />
          ))}
        </section>
      </div>
    </div>
  );
}

function ProviderEntry({
  provider,
  config,
}: {
  readonly provider: ProviderSummary;
  readonly config: StoredProviderConfig | undefined;
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
        <span className="provider-entry__name">{provider.metadata.displayName}</span>
        <span className="row__meta">{installationLabel(provider)}</span>
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
