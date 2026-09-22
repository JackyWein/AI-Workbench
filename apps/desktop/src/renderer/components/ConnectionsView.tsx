import { useEffect, useState, type JSX } from "react";
import { ChevronRight, FolderOpen, Trash2, Wifi } from "lucide-react";
import type { DirectoryEntry, SshAuthMethod, SshConnection } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

/**
 * The machines a workspace can live on (spec §25).
 *
 * A connection is defined once here and used by any number of workspaces. The
 * secret is typed in once and goes straight to the credential store; it is
 * never read back, which is why there is no field showing it.
 */
export function ConnectionsView(): JSX.Element {
  const connections = useWorkbench((state) => state.connections);
  const refreshConnections = useWorkbench((state) => state.refreshConnections);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">Connections</h1>
        </div>

        {connections.length === 0 ? (
          <p className="field__description">
            No connections yet. Add a machine below, then create a workspace on
            it to work in a folder that is not on this computer.
          </p>
        ) : (
          <section>
            {connections.map((connection) => (
              <ConnectionEntry key={connection.id} connection={connection} />
            ))}
          </section>
        )}

        <AddConnectionForm />
      </div>
    </div>
  );
}

function ConnectionEntry({
  connection,
}: {
  readonly connection: SshConnection;
}): JSX.Element {
  const test = useWorkbench((state) => state.connectionTests[connection.id]);
  const testConnection = useWorkbench((state) => state.testConnection);
  const deleteConnection = useWorkbench((state) => state.deleteConnection);
  const forgetHostKey = useWorkbench((state) => state.forgetConnectionHostKey);
  const createWorkspace = useWorkbench((state) => state.createWorkspace);
  const setView = useWorkbench((state) => state.setView);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const detailsId = `connection-${connection.id}-details`;

  const addWorkspaceHere = async (): Promise<void> => {
    if (!picked) {
      return;
    }
    setCreating(true);
    try {
      const name = picked.split("/").filter(Boolean).pop() ?? connection.name;
      const workspace = await createWorkspace(name, picked, connection.id);
      if (workspace) {
        setPicking(false);
        setPicked(null);
        // Straight into the workspace that was just made, rather than leaving
        // the person to go and find it.
        setView("chat");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <article className="provider-entry">
      <div className="sidebar__row">
        <button
          type="button"
          className="provider-entry__head provider-entry__toggle"
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
          <span className="provider-entry__name">{connection.name}</span>
          <span className="row__meta">
            {connection.username}@{connection.host}
            {connection.port === 22 ? "" : `:${connection.port}`}
          </span>
        </button>
        <button
          type="button"
          className="sidebar__delete"
          aria-label={`Remove ${connection.name}`}
          onClick={() => void deleteConnection(connection.id)}
        >
          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div id={detailsId} hidden={!open}>
        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Sign-in</dt>
            <dd>{authWording(connection.auth)}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Host key</dt>
            <dd>
              {connection.hostKeyFingerprint ?? "Not known yet — learned on first connection"}
            </dd>
          </div>
          {test ? (
            <div className="detail-list__row">
              <dt>Last test</dt>
              <dd>
                {test.ok
                  ? `Connected. Home directory ${test.homeDirectory ?? "unknown"}.` +
                    (test.learnedHostKey ? " The host key was recorded." : "")
                  : (test.error ?? "Failed")}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="provider-entry__config">
          <button
            type="button"
            className="quiet-button"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              void testConnection(connection.id).finally(() => setTesting(false));
            }}
          >
            <Wifi size={13} strokeWidth={1.75} aria-hidden="true" />
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setPicking((value) => !value)}
          >
            <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
            {picking ? "Cancel" : "Add a workspace here"}
          </button>
          {connection.hostKeyFingerprint ? (
            <button
              type="button"
              className="quiet-button"
              onClick={() => void forgetHostKey(connection.id)}
            >
              Forget host key
            </button>
          ) : null}
        </div>

        {picking ? (
          <div className="provider-entry__config">
            <RemoteDirectoryPicker connectionId={connection.id} onPick={setPicked} />
            <button
              type="button"
              className="primary-button"
              disabled={!picked || creating}
              onClick={() => void addWorkspaceHere()}
            >
              {creating ? "Creating…" : `Use ${picked ?? "this folder"}`}
            </button>
          </div>
        ) : null}
        <p className="detail__note">
          The host key is remembered the first time this machine answers. If it
          ever changes, connecting is refused rather than trusted — forget the
          key only when the machine was genuinely rebuilt.
        </p>
      </div>
    </article>
  );
}

function authWording(auth: SshAuthMethod): string {
  if (auth === "password") {
    return "Password, kept in the system credential store";
  }
  if (auth === "key") {
    return "Private key, kept in the system credential store";
  }
  return "The SSH agent running on this computer";
}

function AddConnectionForm(): JSX.Element {
  const createConnection = useWorkbench((state) => state.createConnection);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [auth, setAuth] = useState<SshAuthMethod>("password");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const ready =
    name.trim() !== "" &&
    host.trim() !== "" &&
    username.trim() !== "" &&
    (auth === "agent" || secret !== "");

  const submit = async (): Promise<void> => {
    if (!ready) {
      return;
    }
    setSaving(true);
    try {
      const created = await createConnection({
        name: name.trim(),
        host: host.trim(),
        port: Number.parseInt(port, 10) || 22,
        username: username.trim(),
        auth,
        ...(auth === "agent" ? {} : { secret }),
      });
      if (created) {
        setName("");
        setHost("");
        setPort("22");
        setUsername("");
        // Cleared immediately: it is in the credential store now, and there is
        // no reason for it to sit in a form field afterwards.
        setSecret("");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">Add a connection</span>
      </div>
      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input
            className="text-input"
            value={name}
            placeholder="What you call this machine"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Host</span>
          <input
            className="text-input"
            value={host}
            placeholder="build.example.com"
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Port</span>
          <input
            className="text-input"
            value={port}
            inputMode="numeric"
            onChange={(event) => setPort(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">User</span>
          <input
            className="text-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Sign-in</span>
          <select
            className="select"
            aria-label="Sign-in method"
            value={auth}
            onChange={(event) => setAuth(event.target.value as SshAuthMethod)}
          >
            <option value="password">Password</option>
            <option value="key">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>
        {auth === "password" ? (
          <label className="stacked-field">
            <span className="field__description">Password</span>
            <input
              className="text-input"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        ) : null}
        {auth === "key" ? (
          <label className="stacked-field">
            <span className="field__description">Private key</span>
            <textarea
              className="text-input"
              rows={4}
              value={secret}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        ) : null}

        <div className="provider-entry__config">
          <button
            type="button"
            className="primary-button"
            disabled={!ready || saving}
            onClick={() => void submit()}
          >
            {saving ? "Adding…" : "Add connection"}
          </button>
        </div>
        <p className="detail__note">
          The password or key is stored in this computer&rsquo;s credential
          store and never shown again.
        </p>
      </div>
    </section>
  );
}

/**
 * Picks a folder on a machine, one directory at a time. A remote machine has
 * no folder dialog to borrow, so this is the browser for it.
 */
export function RemoteDirectoryPicker({
  connectionId,
  onPick,
}: {
  readonly connectionId: string;
  readonly onPick: (path: string) => void;
}): JSX.Element {
  const browseConnection = useWorkbench((state) => state.browseConnection);
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const go = (target: string): void => {
    setLoading(true);
    void browseConnection(connectionId, target)
      .then((result) => {
        if (result) {
          setPath(result.path);
          setEntries(result.entries.filter((entry) => entry.kind === "directory"));
          onPick(result.path);
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // Starts at the account's home directory, which is where a person looking
    // for a project on a server starts too.
    go("");
    // The connection is the only thing this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  if (path === null) {
    return <p className="field__description">{loading ? "Connecting…" : "Not connected"}</p>;
  }

  return (
    <div className="remote-picker">
      <div className="remote-picker__path">
        <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
        <span>{path}</span>
      </div>
      <div className="remote-picker__list">
        <button
          type="button"
          className="remote-picker__entry"
          onClick={() => go(parentOf(path))}
          disabled={path === "/"}
        >
          ..
        </button>
        {entries.map((entry) => (
          <button
            type="button"
            className="remote-picker__entry"
            key={entry.path}
            onClick={() => go(joinPosix(path, entry.name))}
          >
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

function joinPosix(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}
