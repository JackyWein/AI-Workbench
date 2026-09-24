import { useEffect, useMemo, useState, type JSX } from "react";
import { Check, ChevronRight, ExternalLink, Plus, Search, X } from "lucide-react";
import {
  CONNECTOR_CATALOG,
  catalogEntry,
  type ConnectorCatalogEntry,
  type McpServerConfig,
  type McpServerSaveInput,
  type McpServerStatus,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { CONNECTOR_LOGOS } from "./connector-logos.js";
import { Segmented, Switch } from "./Controls.js";

type Tab = "yours" | "discover";

/**
 * Connectors give every session and terminal agent access to a service
 * (spec §32, §37). Each one is an MCP server: picked from the catalog or
 * added by hand, signed in to once, and available everywhere unless it is
 * limited to some workspaces. Sign-ins and keys stay in the main process.
 */
export function ConnectorsView(): JSX.Element {
  const servers = useWorkbench((state) => state.mcpServers);
  const statuses = useWorkbench((state) => state.mcpStatuses);
  const refreshMcp = useWorkbench((state) => state.refreshMcp);
  const [tab, setTab] = useState<Tab>(servers.length > 0 ? "yours" : "discover");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ kind: "server"; id: string } | { kind: "catalog"; id: string } | { kind: "custom" } | null>(null);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  const needle = query.trim().toLowerCase();
  const matches = (text: string): boolean => needle === "" || text.toLowerCase().includes(needle);
  const discover = CONNECTOR_CATALOG.filter((entry) =>
    matches(`${entry.name} ${entry.publisher} ${entry.description} ${entry.category}`),
  );
  const yours = servers.filter((server) => matches(`${server.name} ${server.url ?? server.command ?? ""}`));
  const added = new Set(servers.map((server) => server.catalogId).filter(Boolean));

  const openServer = open?.kind === "server" ? servers.find((server) => server.id === open.id) : undefined;
  const openEntry =
    open?.kind === "catalog" ? catalogEntry(open.id) : openServer ? catalogEntry(openServer.catalogId) : undefined;

  return (
    <div className="connectors">
      <div className="view">
        <div className="view__inner">
          <header className="view__header connectors__header">
            <div className="view__heading">
              <h1 className="view__title">Connectors</h1>
              <p className="view__lede">
                Services your agents work with — mail, issues, docs. Sign in once and every session and
                terminal agent can use it, or only the workspaces you choose.
              </p>
            </div>
            <div className="view__actions">
              <button type="button" className="primary-button" onClick={() => setOpen({ kind: "custom" })}>
                <Plus size={13} strokeWidth={2} aria-hidden="true" />
                Add
              </button>
            </div>
          </header>
          <div className="view__toolbar">
            <Segmented<Tab>
              label="Show"
              value={tab}
              options={[
                { value: "yours", label: `Yours${servers.length > 0 ? ` · ${servers.length}` : ""}` },
                { value: "discover", label: "Discover" },
              ]}
              onChange={setTab}
            />
            <label className="connectors__search">
              <Search size={13} strokeWidth={1.75} aria-hidden="true" />
              <input
                value={query}
                placeholder="Search connectors"
                aria-label="Search connectors"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>

          {tab === "discover" ? (
            <div className="connector-grid">
              {discover.map((entry) => (
                <CatalogCard
                  key={entry.id}
                  entry={entry}
                  added={added.has(entry.id)}
                  onOpen={() => {
                    const server = servers.find((candidate) => candidate.catalogId === entry.id);
                    setOpen(server ? { kind: "server", id: server.id } : { kind: "catalog", id: entry.id });
                  }}
                />
              ))}
              {discover.length === 0 ? <p className="field__description">Nothing matches “{query}”.</p> : null}
            </div>
          ) : (
            <div className="connector-grid">
              {yours.map((server) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  status={statuses.find((status) => status.id === server.id)}
                  onOpen={() => setOpen({ kind: "server", id: server.id })}
                />
              ))}
              {servers.length === 0 ? (
                <div className="connectors__empty">
                  <p>No connectors yet.</p>
                  <button type="button" className="link-button" onClick={() => setTab("discover")}>
                    Discover services to connect
                  </button>
                </div>
              ) : yours.length === 0 ? (
                <p className="field__description">Nothing matches “{query}”.</p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {open ? (
        <ConnectorPanel onClose={() => setOpen(null)}>
          {open.kind === "custom" ? (
            <CustomConnector
              onSaved={(id) => {
                setTab("yours");
                setOpen({ kind: "server", id });
              }}
            />
          ) : openServer ? (
            <ServerDetail
              server={openServer}
              entry={openEntry}
              status={statuses.find((status) => status.id === openServer.id)}
              onRemoved={() => setOpen(null)}
            />
          ) : openEntry ? (
            <CatalogDetail entry={openEntry} onAdded={(id) => setOpen({ kind: "server", id })} />
          ) : null}
        </ConnectorPanel>
      ) : null}
    </div>
  );
}

/** A service's logo on a quiet tile, or its initial when there is none. */
function ConnectorLogo({
  icon,
  name,
  size = 36,
}: {
  readonly icon: string | undefined;
  readonly name: string;
  readonly size?: number;
}): JSX.Element {
  const logo = icon ? CONNECTOR_LOGOS[icon] : undefined;
  return (
    <span className="connector-logo" style={{ width: size, height: size }} aria-hidden="true">
      {logo ? (
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.55)} height={Math.round(size * 0.55)}>
          <path d={logo.path} fill={isDark(logo.color) ? "currentColor" : logo.color} />
        </svg>
      ) : (
        <span className="connector-logo__letter" style={{ fontSize: Math.round(size * 0.42) }}>
          {name.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
    </span>
  );
}

/** Near-black brand colours vanish on a dark tile; those take the text colour. */
function isDark(hex: string): boolean {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60;
}

function CatalogCard({
  entry,
  added,
  onOpen,
}: {
  readonly entry: ConnectorCatalogEntry;
  readonly added: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <button type="button" className="connector-card" onClick={onOpen}>
      <ConnectorLogo icon={entry.icon} name={entry.name} />
      <span className="connector-card__text">
        <span className="connector-card__name">{entry.name}</span>
        <span className="connector-card__description">{entry.description}</span>
        <span className="connector-card__meta">by {entry.publisher}</span>
      </span>
      <span className="connector-card__action" data-added={added ? "true" : undefined} aria-label={added ? "Added" : "Add"}>
        {added ? (
          <Check size={14} strokeWidth={2.25} aria-hidden="true" />
        ) : (
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </span>
    </button>
  );
}

function ServerCard({
  server,
  status,
  onOpen,
}: {
  readonly server: McpServerConfig;
  readonly status: McpServerStatus | undefined;
  readonly onOpen: () => void;
}): JSX.Element {
  const entry = catalogEntry(server.catalogId);
  const state = describeState(server, status);
  return (
    <button type="button" className="connector-card" onClick={onOpen}>
      <ConnectorLogo icon={entry?.icon} name={server.name} />
      <span className="connector-card__text">
        <span className="connector-card__name">{server.name}</span>
        <span className="connector-card__state" data-tone={state.tone}>
          <span className="status-dot" data-state={state.dot} aria-hidden="true" />
          {state.text}
        </span>
        <span className="connector-card__meta">
          {server.availability === "everywhere"
            ? "All sessions and terminals"
            : `${server.workspaceIds.length} ${server.workspaceIds.length === 1 ? "workspace" : "workspaces"}`}
        </span>
      </span>
      <ChevronRight size={14} strokeWidth={1.75} className="connector-card__chevron" aria-hidden="true" />
    </button>
  );
}

/** One line about a connector, in words: on, off, waiting for a sign-in, broken. */
function describeState(
  server: McpServerConfig,
  status: McpServerStatus | undefined,
): { text: string; tone: "ok" | "attention" | "error" | "quiet"; dot: string } {
  if (!server.enabled) {
    return { text: "Off", tone: "quiet", dot: "idle" };
  }
  switch (status?.state) {
    case "connected":
      return {
        text: `Connected · ${status.tools.length} ${status.tools.length === 1 ? "tool" : "tools"}`,
        tone: "ok",
        dot: "running",
      };
    case "signInRequired":
      return { text: "Sign in to use it", tone: "attention", dot: "waiting" };
    case "connecting":
      return { text: "Connecting…", tone: "quiet", dot: "waiting" };
    case "failed":
      return { text: status.detail ?? "Could not connect", tone: "error", dot: "error" };
    default:
      return { text: "Not connected", tone: "quiet", dot: "idle" };
  }
}

function ConnectorPanel({
  children,
  onClose,
}: {
  readonly children: JSX.Element | null;
  readonly onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="connector-panel" aria-label="Connector">
      <button type="button" className="icon-button connector-panel__close" aria-label="Close" onClick={onClose}>
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {children}
    </aside>
  );
}

function PanelHeader({
  icon,
  name,
  publisher,
  description,
}: {
  readonly icon: string | undefined;
  readonly name: string;
  readonly publisher?: string | undefined;
  readonly description?: string | undefined;
}): JSX.Element {
  return (
    <div className="connector-panel__head">
      <ConnectorLogo icon={icon} name={name} size={44} />
      <div>
        <h2 className="connector-panel__title">{name}</h2>
        {publisher ? <p className="connector-panel__publisher">by {publisher}</p> : null}
      </div>
      {description ? <p className="connector-panel__description">{description}</p> : null}
    </div>
  );
}

/** What a catalog service asks for before it can be added. */
function SignInFields({
  entry,
  apiKey,
  setApiKey,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
}: {
  readonly entry: Pick<ConnectorCatalogEntry, "signIn" | "setup" | "setupUrl">;
  readonly apiKey: string;
  readonly setApiKey: (value: string) => void;
  readonly clientId: string;
  readonly setClientId: (value: string) => void;
  readonly clientSecret: string;
  readonly setClientSecret: (value: string) => void;
}): JSX.Element | null {
  if (entry.signIn === "none" || entry.signIn === "oauth") {
    return null;
  }
  return (
    <div className="connector-panel__fields">
      {entry.setup ? (
        <p className="setting__description">
          {entry.setup}{" "}
          {entry.setupUrl ? (
            <a href={entry.setupUrl} target="_blank" rel="noreferrer" className="link-button">
              Open <ExternalLink size={11} strokeWidth={1.75} aria-hidden="true" />
            </a>
          ) : null}
        </p>
      ) : null}
      {entry.signIn === "api-key" ? (
        <label className="stacked-field">
          <span className="field__description">Key or token</span>
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      ) : (
        <>
          <label className="stacked-field">
            <span className="field__description">OAuth client ID</span>
            <input
              className="text-input"
              spellCheck={false}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </label>
          <label className="stacked-field">
            <span className="field__description">Client secret</span>
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </label>
        </>
      )}
    </div>
  );
}

function CatalogDetail({
  entry,
  onAdded,
}: {
  readonly entry: ConnectorCatalogEntry;
  readonly onAdded: (id: string) => void;
}): JSX.Element {
  const save = useWorkbench((state) => state.saveMcpServer);
  const signIn = useWorkbench((state) => state.signInMcp);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const ready =
    entry.signIn === "api-key" ? apiKey.trim() !== "" : entry.signIn === "oauth-client" ? clientId.trim() !== "" : true;

  const add = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const id = entry.id;
      const failed = await save({
        id,
        name: entry.name,
        transport: entry.transport,
        url: entry.url,
        catalogId: entry.id,
        ...(entry.signIn === "api-key" ? { apiKey: apiKey.trim() } : {}),
        ...(entry.signIn === "oauth" || entry.signIn === "oauth-client"
          ? {
              oauth: {
                scopes: [...(entry.scopes ?? [])],
                ...(entry.signIn === "oauth-client" ? { clientId: clientId.trim() } : {}),
              },
            }
          : {}),
      });
      if (failed) {
        setProblem(failed);
        return;
      }
      if (entry.signIn === "oauth" || entry.signIn === "oauth-client") {
        const signInFailed = await signIn(id, clientSecret.trim() || undefined);
        if (signInFailed) {
          // Added all the same: the sign-in can be tried again from its page.
          setProblem(signInFailed);
        }
      }
      onAdded(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelHeader icon={entry.icon} name={entry.name} publisher={entry.publisher} description={entry.description} />
      <dl className="connector-facts">
        <div>
          <dt>Signs in</dt>
          <dd>{signInWords(entry.signIn)}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd className="connector-facts__mono">{entry.url}</dd>
        </div>
        <div>
          <dt>Checked</dt>
          <dd>{entry.tested ? `Answered from AI Workbench on ${entry.tested}` : "Not tested with AI Workbench yet"}</dd>
        </div>
      </dl>
      <SignInFields
        entry={entry}
        apiKey={apiKey}
        setApiKey={setApiKey}
        clientId={clientId}
        setClientId={setClientId}
        clientSecret={clientSecret}
        setClientSecret={setClientSecret}
      />
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="connector-panel__actions">
        <button type="button" className="primary-button" disabled={!ready || busy} onClick={() => void add()}>
          {busy
            ? entry.signIn.startsWith("oauth")
              ? "Waiting for the sign-in in your browser…"
              : "Adding…"
            : entry.signIn.startsWith("oauth")
              ? "Add and sign in"
              : "Add"}
        </button>
      </div>
    </>
  );
}

function signInWords(signIn: ConnectorCatalogEntry["signIn"]): string {
  switch (signIn) {
    case "oauth":
      return "In your browser, with your account at the service";
    case "oauth-client":
      return "In your browser, with an OAuth client of your own";
    case "api-key":
      return "With a key or token from the service";
    case "none":
      return "No sign-in needed";
  }
}

function ServerDetail({
  server,
  entry,
  status,
  onRemoved,
}: {
  readonly server: McpServerConfig;
  readonly entry: ConnectorCatalogEntry | undefined;
  readonly status: McpServerStatus | undefined;
  readonly onRemoved: () => void;
}): JSX.Element {
  const save = useWorkbench((state) => state.saveMcpServer);
  const signIn = useWorkbench((state) => state.signInMcp);
  const signOut = useWorkbench((state) => state.signOutMcp);
  const remove = useWorkbench((state) => state.deleteMcpServer);
  const reconnect = useWorkbench((state) => state.connectMcpServer);
  const workspaces = useWorkbench((state) => state.workspaces);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const state = describeState(server, status);

  const update = async (patch: Partial<McpServerSaveInput>): Promise<void> => {
    setProblem(null);
    const failed = await save({ ...toSaveInput(server), ...patch });
    if (failed) {
      setProblem(failed);
    }
  };

  const runSignIn = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const failed = await signIn(server.id, clientSecret.trim() || undefined);
      if (failed) {
        setProblem(failed);
      }
    } finally {
      setBusy(false);
    }
  };

  const signsIn = Boolean(server.oauth);
  const signedIn = Boolean(server.oauth?.reference) && status?.state !== "signInRequired";
  const usesKey = !server.oauth && server.transport !== "stdio" && (entry?.signIn === "api-key" || Boolean(server.credentialReference));

  return (
    <>
      <PanelHeader
        icon={entry?.icon}
        name={server.name}
        publisher={entry?.publisher}
        description={entry?.description}
      />
      <div className="connector-panel__status" data-tone={state.tone}>
        <span className="status-dot" data-state={state.dot} aria-hidden="true" />
        <span>{state.text}</span>
        <Switch
          checked={server.enabled}
          label={server.enabled ? `Turn ${server.name} off` : `Turn ${server.name} on`}
          onChange={(enabled) => void update({ enabled })}
        />
      </div>

      {signsIn ? (
        <div className="connector-panel__section">
          <p className="connector-panel__label">Sign-in</p>
          {signedIn ? (
            <div className="connector-panel__row">
              <span className="setting__description">Signed in. The sign-in stays on this computer and renews itself.</span>
              <button type="button" className="ghost-button" onClick={() => void signOut(server.id)}>
                Sign out
              </button>
            </div>
          ) : (
            <>
              {server.oauth?.clientId ? (
                <label className="stacked-field">
                  <span className="field__description">Client secret (only if your OAuth client has one)</span>
                  <input
                    className="text-input"
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="connector-panel__row">
                <span className="setting__description">
                  Opens {entry?.publisher ?? "the service"}&rsquo;s sign-in page in your browser.
                </span>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void runSignIn()}>
                  {busy ? "Waiting for your browser…" : "Sign in"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {usesKey ? (
        <div className="connector-panel__section">
          <p className="connector-panel__label">Key</p>
          <div className="connector-panel__row">
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              placeholder={server.credentialReference ? "Stored — enter a new one to replace it" : "Key or token"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button
              type="button"
              className="ghost-button"
              disabled={apiKey.trim() === ""}
              onClick={() => void update({ apiKey: apiKey.trim() }).then(() => setApiKey(""))}
            >
              Save key
            </button>
          </div>
        </div>
      ) : null}

      <div className="connector-panel__section">
        <p className="connector-panel__label">Available in</p>
        <label className="radio-row">
          <input
            type="radio"
            name={`availability-${server.id}`}
            checked={server.availability === "everywhere"}
            onChange={() => void update({ availability: "everywhere" })}
          />
          <span>
            All sessions and terminal agents
            <span className="field__description">A session can still switch it off for itself.</span>
          </span>
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name={`availability-${server.id}`}
            checked={server.availability === "workspaces"}
            onChange={() => void update({ availability: "workspaces" })}
          />
          <span>Only these workspaces</span>
        </label>
        {server.availability === "workspaces" ? (
          <ul className="connector-workspaces">
            {workspaces.map((workspace) => {
              const on = server.workspaceIds.includes(workspace.id);
              return (
                <li key={workspace.id}>
                  <label className="radio-row">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        void update({
                          workspaceIds: on
                            ? server.workspaceIds.filter((id) => id !== workspace.id)
                            : [...server.workspaceIds, workspace.id],
                        })
                      }
                    />
                    <span>{workspace.name}</span>
                  </label>
                </li>
              );
            })}
            {workspaces.length === 0 ? <li className="field__description">No workspaces yet.</li> : null}
          </ul>
        ) : null}
      </div>

      {status && status.tools.length > 0 ? (
        <div className="connector-panel__section">
          <button
            type="button"
            className="connector-panel__toggle"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((value) => !value)}
          >
            <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
            {status.tools.length} {status.tools.length === 1 ? "tool" : "tools"}
          </button>
          {toolsOpen ? (
            <ul className="connector-tools">
              {status.tools.map((tool) => (
                <li key={tool.name}>
                  <span className="connector-tools__name">{tool.name}</span>
                  {tool.description ? (
                    <span className="connector-tools__description">{firstSentence(tool.description)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="connector-panel__actions">
        {status?.state === "failed" ? (
          <button type="button" className="ghost-button" onClick={() => void reconnect(server.id)}>
            Try again
          </button>
        ) : null}
        <button
          type="button"
          className="ghost-button"
          data-tone="danger"
          onClick={() => {
            void remove(server.id).then(onRemoved);
          }}
        >
          Remove
        </button>
      </div>
    </>
  );
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** A stored server as the save input takes it; credentials are never sent back. */
function toSaveInput(server: McpServerConfig): McpServerSaveInput {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    args: server.args,
    env: server.env,
    ...(server.url ? { url: server.url } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    enabled: server.enabled,
    availability: server.availability,
    workspaceIds: server.workspaceIds,
    ...(server.catalogId ? { catalogId: server.catalogId } : {}),
    ...(server.oauth
      ? {
          oauth: {
            scopes: server.oauth.scopes,
            ...(server.oauth.clientId ? { clientId: server.oauth.clientId } : {}),
          },
        }
      : {}),
  };
}

type CustomKind = "remote" | "local";
type CustomSignIn = "none" | "oauth" | "api-key";

/** A connector not in the catalog: any MCP server, by address or command. */
function CustomConnector({ onSaved }: { readonly onSaved: (id: string) => void }): JSX.Element {
  const save = useWorkbench((state) => state.saveMcpServer);
  const signIn = useWorkbench((state) => state.signInMcp);
  const servers = useWorkbench((state) => state.mcpServers);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CustomKind>("remote");
  const [url, setUrl] = useState("");
  const [sse, setSse] = useState(false);
  const [auth, setAuth] = useState<CustomSignIn>("none");
  const [apiKey, setApiKey] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const id = useMemo(() => uniqueId(name, servers.map((server) => server.id)), [name, servers]);
  const validUrl = (() => {
    try {
      return ["http:", "https:"].includes(new URL(url.trim()).protocol);
    } catch {
      return false;
    }
  })();
  const ready =
    name.trim() !== "" &&
    (kind === "remote" ? validUrl && (auth !== "api-key" || apiKey.trim() !== "") : command.trim() !== "");

  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const environment = Object.fromEntries(
        env
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1)]),
      );
      const failed = await save(
        kind === "remote"
          ? {
              id,
              name: name.trim(),
              transport: sse ? "sse" : "http",
              url: url.trim(),
              ...(auth === "api-key" ? { apiKey: apiKey.trim() } : {}),
              ...(auth === "oauth" ? { oauth: { scopes: [] } } : {}),
            }
          : {
              id,
              name: name.trim(),
              transport: "stdio",
              command: command.trim(),
              args: args.split("\n").map((line) => line.trim()).filter(Boolean),
              env: environment,
            },
      );
      if (failed) {
        setProblem(failed);
        return;
      }
      if (kind === "remote" && auth === "oauth") {
        const signInFailed = await signIn(id);
        if (signInFailed) {
          setProblem(signInFailed);
        }
      }
      onSaved(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelHeader
        icon={undefined}
        name={name.trim() || "New connector"}
        description="Any MCP server: a service's address, or a program on this computer."
      />
      <div className="connector-panel__fields">
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <Segmented<CustomKind>
          label="Kind"
          value={kind}
          options={[
            { value: "remote", label: "Service address" },
            { value: "local", label: "Program on this computer" },
          ]}
          onChange={setKind}
        />
        {kind === "remote" ? (
          <>
            <label className="stacked-field">
              <span className="field__description">Address</span>
              <input
                className="text-input"
                spellCheck={false}
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label className="radio-row">
              <input type="checkbox" checked={sse} onChange={(event) => setSse(event.target.checked)} />
              <span>
                Uses the older SSE transport
                <span className="field__description">Only if the service says so; most use streamable HTTP.</span>
              </span>
            </label>
            <Segmented<CustomSignIn>
              label="Sign-in"
              value={auth}
              options={[
                { value: "none", label: "No sign-in" },
                { value: "oauth", label: "Sign in (OAuth)" },
                { value: "api-key", label: "Key or token" },
              ]}
              onChange={setAuth}
            />
            {auth === "api-key" ? (
              <label className="stacked-field">
                <span className="field__description">Key or token (sent as the Authorization header)</span>
                <input
                  className="text-input"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            ) : null}
          </>
        ) : (
          <>
            <label className="stacked-field">
              <span className="field__description">Command</span>
              <input
                className="text-input"
                spellCheck={false}
                placeholder="npx"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label className="stacked-field">
              <span className="field__description">Arguments, one per line</span>
              <textarea
                className="text-input text-input--multiline"
                rows={3}
                spellCheck={false}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
            <label className="stacked-field">
              <span className="field__description">Environment, one NAME=value per line</span>
              <textarea
                className="text-input text-input--multiline"
                rows={2}
                spellCheck={false}
                value={env}
                onChange={(event) => setEnv(event.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="connector-panel__actions">
        <button type="button" className="primary-button" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? (auth === "oauth" && kind === "remote" ? "Waiting for your browser…" : "Adding…") : "Add connector"}
        </button>
      </div>
    </>
  );
}

/** A short id from the name, unique among the servers there are. */
function uniqueId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "connector";
  let id = base;
  for (let count = 2; taken.includes(id); count += 1) {
    id = `${base}-${count}`;
  }
  return id;
}
