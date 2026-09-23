import { useEffect, useState, type JSX } from "react";
import { ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  modelInfoSchema,
  type ModelInfo,
  type ProviderSummary,
  type StoredProviderConfig,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { formatIn, meterTone, tightestLimit, useNow } from "../lib/usage.js";
import { Logo } from "./Logo.js";
import { SettingDisclosure, SettingGroup, Switch } from "./Controls.js";
import { familyOf } from "../lib/provider-label.js";
import {
  createCustomProfile,
  parseCustomModels,
  type OpenAiCompatibleProfile,
} from "@ai-workbench/provider-openai-compatible";

interface ProvidersViewProps {
  readonly providers: ProviderSummary[];
  readonly configs: Record<string, StoredProviderConfig>;
}

/**
 * Central provider screen (spec §19). Each tool is one line — its mark, its
 * version, whether it is signed in, how much of its limit is used, and a
 * switch — that opens onto everything the adapter reported and what a user
 * edits to make a command line tool work. Nothing here is guessed.
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
  // Defensive: malformed entries never crash the whole screen (grey-screen).
  const safeProviders = Array.isArray(providers) ? providers.filter((p) => p && p.metadata && typeof p.metadata.id === "string") : [];
  const safeAccounts = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a.family === "string") : [];
  const safeDetected = Array.isArray(detectedAccounts) ? detectedAccounts.filter((d) => d && typeof d.family === "string") : [];
  const multiAccountFamilies = new Set([
    ...safeAccounts.map((account) => account.family),
    ...safeDetected.map((detected) => detected.family),
    ...safeProviders
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

  const installed = safeProviders.filter((provider) => provider.installation?.state === "installed");
  const missing = safeProviders.filter((provider) => provider.installation?.state !== "installed");
  const entry = (provider: ProviderSummary): JSX.Element => (
    <ProviderEntry
      key={provider.metadata.id}
      provider={provider}
      config={configs[provider.metadata.id]}
      showAccounts={!provider.metadata.account && multiAccountFamilies.has(familyOf(provider))}
    />
  );

  return (
    <div className="view">
      <div className="view__inner view__inner--narrow">
        <header className="view__header">
          <div className="view__heading">
            <h1 className="view__title">Providers</h1>
            <p className="view__lede">
              What each tool reports about itself. Unverified stays unverified.
            </p>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
              className={refreshing ? "spin" : undefined}
            />
            {refreshing ? "Checking…" : "Check again"}
          </button>
        </header>

        {installed.length > 0 ? <div className="entry-list">{installed.map(entry)}</div> : null}

        {missing.length > 0 ? (
          <section className="setting-group" aria-label="Not installed">
            <header className="setting-group__header">
              <h2 className="setting-group__title">Not installed</h2>
              <p className="setting-group__lede">
                Install the tool, or point to its executable, then check again.
              </p>
            </header>
            <div className="entry-list">{missing.map(entry)}</div>
          </section>
        ) : null}

        <CustomProviderSection configs={configs} />
      </div>
    </div>
  );
}

/** Capabilities shown before the rest are folded behind "+N". */
const CAPABILITY_PREVIEW = 6;

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
  const usage = useWorkbench((state) => state.usage);
  const setView = useWorkbench((state) => state.setView);
  const startProviderSetup = useWorkbench((state) => state.startProviderSetup);
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const [allCapabilities, setAllCapabilities] = useState(false);
  const safeModels = Array.isArray(provider.models) ? provider.models.filter((m) => m && typeof m.id === "string") : [];
  const [path, setPath] = useState(config?.executablePath ?? "");
  const [args, setArgs] = useState(Array.isArray(config?.arguments) ? (config.arguments as string[]).join(" ") : "");
  const [models, setModels] = useState(formatModels(safeModels));
  const [saving, setSaving] = useState(false);

  const id = provider.metadata.id;
  const detailsId = `provider-${id}-details`;
  const transportTypes = Array.isArray(provider.metadata.transportTypes) ? provider.metadata.transportTypes : [];
  const configurable = transportTypes.includes("cli");
  const configuredModels = modelsOf(config);
  const tightest = tightestLimit(usage, new Set([id]), now);
  const capabilities = Array.isArray(provider.capabilities?.supported) ? provider.capabilities.supported : [];
  const shownCapabilities = allCapabilities
    ? capabilities
    : capabilities.slice(0, CAPABILITY_PREVIEW);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await saveProviderConfig({
        providerId: id,
        executablePath: path.trim().length > 0 ? path.trim() : null,
        arguments: args.trim().length > 0 ? args.trim().split(/\s+/) : [],
        models: parseModels(models),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="provider-entry provider-row" data-enabled={provider.enabled}>
      <div className="provider-row__head">
        <button
          type="button"
          className="provider-entry__toggle provider-row__toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            aria-hidden="true"
            className="provider-entry__chevron"
            data-open={open}
          />
          <span className="logo-well logo-well--sm" aria-hidden="true">
            <Logo name={provider.metadata.icon} label={provider.metadata.displayName ?? provider.metadata.id ?? "Unknown"} size={14} />
          </span>
          <span className="provider-row__name">{provider.metadata.displayName ?? provider.metadata.id}</span>
          <span className="row__meta">{installationLabel(provider)}</span>
        </button>

        {tightest ? (
          <button
            type="button"
            className="provider-row__usage"
            data-tone={meterTone(tightest.percentUsed)}
            onClick={() => setView("usage")}
            title={`${tightest.limit.label}: ${tightest.percentUsed}% used${
              tightest.limit.resetsAt ? `, resets ${formatIn(tightest.limit.resetsAt, now)}` : ""
            }`}
          >
            <span className="mini-meter" aria-hidden="true">
              <span className="mini-meter__fill" style={{ width: `${tightest.percentUsed}%` }} />
            </span>
            {tightest.percentUsed}%
          </button>
        ) : null}
        {provider.installation?.state === "installed" ? (
          <span className={`pill ${authTone(provider)}`}>{authPillLabel(provider)}</span>
        ) : null}
        <Switch
          label={provider.enabled ? `Hide ${provider.metadata.displayName ?? provider.metadata.id}` : `Show ${provider.metadata.displayName ?? provider.metadata.id}`}
          checked={provider.enabled}
          onChange={(enabled) => void saveProviderConfig({ providerId: id, enabled })}
        />
      </div>

      <div className="provider-entry__details provider-row__details" id={detailsId} hidden={!open}>
        {provider.metadata.description ? (
          <p className="provider-row__description">{provider.metadata.description}</p>
        ) : null}

        {provider.metadata.notice ? (
          <p className="notice" role="note">
            {provider.metadata.notice}
          </p>
        ) : null}

        <dl className="detail-list">
          <div className="detail">
            <dt className="detail__label">Account</dt>
            <dd className="detail__value">{authLabel(provider)}</dd>
          </div>
          <div className="detail">
            <dt className="detail__label">Runs as</dt>
            <dd className="detail__value">{transportTypes.join(", ") || "Unknown"}</dd>
          </div>
          {provider.installation?.executablePath ? (
            <div className="detail">
              <dt className="detail__label">Executable</dt>
              <dd className="detail__value detail__value--path">
                {provider.installation?.executablePath}
              </dd>
            </div>
          ) : null}
          <div className="detail">
            <dt className="detail__label">Models</dt>
            <dd className="detail__value">
              {modelsLabel(provider, configuredModels)}
              {/* Why a tool's own list is missing, when it is (spec §56). */}
              {provider.modelsNote ? (
                <span className="detail__note">{provider.modelsNote}</span>
              ) : null}
            </dd>
          </div>
          <div className="detail">
            <dt className="detail__label">Usage</dt>
            <dd className="detail__value">{usageLabel(provider)}</dd>
          </div>
          {/* A one-time setup the tool needs, run with the tool's own installer. */}
          {provider.integration ? (
            <div className="detail">
              <dt className="detail__label">{provider.integration.name}</dt>
              <dd className="detail__value">
                {integrationLabel(provider.integration.state)}
                {provider.integration.state !== "ready" ? (
                  <button
                    type="button"
                    className="quiet-button detail__action"
                    onClick={() => void startProviderSetup(provider.metadata.id)}
                  >
                    {provider.integration.state === "updateNeeded" ? "Update" : "Set up"}
                  </button>
                ) : null}
                <span className="detail__note">
                  {provider.integration.detail ?? provider.integration.description}
                </span>
              </dd>
            </div>
          ) : null}
        </dl>

        {capabilities.length > 0 ? (
          <div className="tag-list" aria-label="Capabilities">
            {shownCapabilities.map((capability) => (
              <span className="tag" key={capability}>
                {capabilityLabel(capability)}
              </span>
            ))}
            {capabilities.length > CAPABILITY_PREVIEW ? (
              <button
                type="button"
                className="tag tag--more"
                onClick={() => setAllCapabilities((value) => !value)}
              >
                {allCapabilities ? "Less" : `+${capabilities.length - CAPABILITY_PREVIEW}`}
              </button>
            ) : null}
          </div>
        ) : null}

        {showAccounts ? <AccountsSection family={familyOf(provider)} /> : null}

        {configurable ? (
          <div className="provider-row__config">
            <p className="provider-row__subtitle">Command line</p>
            <div className="form-grid">
              <label className="stacked-field">
                <span className="field__description">Executable path</span>
                <input
                  className="text-input"
                  value={path}
                  placeholder="Leave empty to search PATH"
                  spellCheck={false}
                  onChange={(event) => setPath(event.target.value)}
                />
              </label>
              <label className="stacked-field">
                <span className="field__description">Extra arguments</span>
                <input
                  className="text-input"
                  value={args}
                  placeholder="Optional, separated by spaces"
                  spellCheck={false}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </label>
              <label className="stacked-field form-grid__full">
                <span className="field__description">
                  Models, one per line as <code>id</code> or <code>id = Name</code>. What
                  you enter here is what the session picker offers.
                </span>
                <textarea
                  className="text-input text-input--multiline"
                  value={models}
                  rows={3}
                  spellCheck={false}
                  placeholder={"gpt-5.5 = GPT-5.5\ngpt-5.4-mini"}
                  onChange={(event) => setModels(event.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save and re-check"}
            </button>
          </div>
        ) : null}
      </div>
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
    <div className="provider-row__config">
      <p className="provider-row__subtitle">Accounts</p>
      {accounts.length === 0 && detected.length === 0 ? (
        <p className="field__description">
          The tool&apos;s own sign-in, plus every account added here as its own entry.
        </p>
      ) : null}
      {accounts.length + detected.length > 0 ? (
        <div className="account-list">
          {accounts.map((account) => (
            <div className="account-row" key={account.id} title={account.home}>
              <span className="account-row__label">{account.label}</span>
              <span className="account-row__home">{account.home}</span>
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
            <div className="account-row" key={candidate.home} title={candidate.home}>
              <span className="account-row__label">{candidate.suggestedLabel}</span>
              <span className="account-row__home">detected · {candidate.home}</span>
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
        </div>
      ) : null}
      <div className="form-grid">
        <label className="stacked-field">
          <span className="field__description">Label for a further account</span>
          <input
            className="text-input"
            value={label}
            placeholder="Work"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Existing home, or empty for a fresh one</span>
          <input
            className="text-input"
            value={home}
            placeholder="Optional absolute path"
            spellCheck={false}
            onChange={(event) => setHome(event.target.value)}
          />
        </label>
      </div>
      <p className="field__description">Signing in happens in the tool itself.</p>
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
        {busy ? "Adding…" : "Add account"}
      </button>
    </div>
  );
}

/** The models a stored configuration holds; anything malformed is skipped. */
function modelsOf(config: StoredProviderConfig | undefined): ModelInfo[] {
  const raw: unknown = (config?.settings as Record<string, unknown> | undefined)?.["models"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const parsed = modelInfoSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** "id = Display name" per line, which is how the field round-trips. */
function formatModels(models: readonly ModelInfo[] | undefined | null): string {
  if (!Array.isArray(models)) {
    return "";
  }
  return models
    .filter((model) => model && typeof model.id === "string")
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
  const list = Array.isArray(provider.models) ? provider.models.filter((m) => m && typeof m.id === "string") : [];
  if (list.length === 0) {
    return "None yet — add them below";
  }
  const names = list.map((model) => model.displayName ?? model.id).join(", ");

  // Where a list came from changes how much it can be trusted, so it is said
  // rather than left for the user to assume (spec §56).
  const sources = new Set(list.map((model) => model.source ?? "profile"));
  const provenance = sources.has("provider")
    ? "reported by the tool"
    : configured.length > 0 || sources.has("user")
      ? "yours"
      : "shipped defaults — this tool does not list its models";

  return `${names} · ${provenance}`;
}

/** "sessionResume" → "session resume": the capability's own words, spaced. */
function capabilityLabel(capability: string): string {
  return capability.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function installationLabel(provider: ProviderSummary): string {
  switch (provider.installation.state) {
    case "installed":
      return provider.installation.version ?? "Installed";
    case "notInstalled":
      return "Not installed";
    case "unsupported":
      return "Unsupported here";
    default:
      return "Unknown";
  }
}

/**
 * Turns a tool's own identifier into something readable without inventing a
 * name for it: separators become spaces, the wording stays the tool's.
 */
function accountWording(label: string): string {
  const spaced = label.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? label : spaced;
}

/** Row pill: state first, honest about the unknown. */
function authTone(provider: ProviderSummary): string {
  switch (provider.auth.state) {
    case "authenticated":
      return "pill--live";
    case "authenticationRequired":
    case "authenticationExpired":
      return "pill--warn";
    default:
      return "pill--dim";
  }
}

function authPillLabel(provider: ProviderSummary): string {
  switch (provider.auth.state) {
    case "authenticated":
      return "Signed in";
    case "authenticationRequired":
      return "Sign-in required";
    case "authenticationExpired":
      return "Sign-in expired";
    case "notApplicable":
      return "No sign-in";
    case "unsupported":
      return "Unsupported";
    default:
      return "Unknown auth";
  }
}

function authLabel(provider: ProviderSummary): string {
  switch (provider.auth.state) {
    case "authenticated": {
      const account = provider.auth.accountLabel;
      const plan = provider.auth.plan;
      // The state first, then how, because the state is what is being asked.
      return [
        "Signed in",
        account ? `· ${accountWording(account)}` : "",
        plan ? `· ${plan}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
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

/**
 * Usage says what is known and, when nothing is, why — "unavailable" on its
 * own leaves the user unable to tell a missing feature from a broken one.
 */
function integrationLabel(state: "ready" | "setupNeeded" | "updateNeeded"): string {
  switch (state) {
    case "ready":
      return "Set up";
    case "updateNeeded":
      return "Set up, update available";
    case "setupNeeded":
      return "Not set up";
  }
}

function usageLabel(provider: ProviderSummary): string {
  const usage = provider.usage;
  if (!usage) {
    return "Not reported";
  }
  // The tool's own note is the specific answer; the state is the fallback.
  return usage.note ?? usageStateLabel(usage.state);
}

function usageStateLabel(state: string): string {
  switch (state) {
    case "available":
      return "Reported by the tool";
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

  const activeIds = new Set(summaries.map((summary) => summary?.metadata?.id).filter((id): id is string => typeof id === "string"));
  const saved = Object.values(configs ?? {}).filter(
    (config) =>
      config &&
      typeof config.providerId === "string" &&
      (config.providerId.startsWith("custom-") ||
        config.baseUrl !== null ||
        config.credentialReference !== null),
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
    <SettingGroup
      title="Custom providers"
      lede="An OpenAI-compatible server of your own: Ollama, llama.cpp, vLLM, a company gateway."
    >
      {saved.map((config) => (
        <div className="setting" key={config.providerId} title={config.baseUrl ?? ""}>
          <div className="setting__text">
            <p className="setting__label">{config.providerId}</p>
            <p className="setting__description">{storedCustomLabel(config, activeIds)}</p>
          </div>
        </div>
      ))}
      <SettingDisclosure label="Add a server">
        <div className="provider-row__config provider-row__config--inset">
          <div className="form-grid">
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
            <label className="stacked-field form-grid__full">
              <span className="field__description">
                API key reference, if the server needs one. The key itself stays in the
                system keychain and is never pasted here.
              </span>
              <input
                className="text-input"
                value={keyReference}
                placeholder="Optional credential reference"
                spellCheck={false}
                onChange={(event) => setKeyReference(event.target.value)}
              />
            </label>
            <label className="stacked-field form-grid__full">
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
          </div>
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
            {saving ? "Saving…" : "Save custom provider"}
          </button>
        </div>
      </SettingDisclosure>
    </SettingGroup>
  );
}

/** What a stored custom configuration holds, and whether it is active. */
function storedCustomLabel(
  config: StoredProviderConfig,
  activeIds: ReadonlySet<string>,
): string {
  const models = modelsOf(config).length;
  const state = activeIds.has(config.providerId) ? "active" : "stored, loads at startup";
  return `${config.baseUrl ?? "No URL"} · ${models} model${models === 1 ? "" : "s"} · ${state}`;
}
