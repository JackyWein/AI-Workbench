import { useEffect, useState, type JSX } from "react";
import { FolderOpen } from "lucide-react";
import type { DirectoryEntry, SshAuthMethod, SshConnection } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import {
  Choice,
  SettingDisclosure,
  SettingGroup,
  SettingRow,
  type SegmentOption,
} from "./Controls.js";

/**
 * The machines a workspace can live on (spec §25), as one group of the
 * Settings screen.
 *
 * It is built only from the settings grammar the rest of the screen uses —
 * rows, a disclosure, the shared form fields and buttons — so adding it did
 * not add a new look. The secret is typed in once and goes straight to the
 * credential store; it is never read back, which is why no field shows it.
 */
export function ConnectionSettings(): JSX.Element {
  const connections = useWorkbench((state) => state.connections);
  const refreshConnections = useWorkbench((state) => state.refreshConnections);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  return (
    <SettingGroup
      title="Connections"
      lede="Machines reached over SSH. A workspace can live on one of them instead of on this computer."
    >
      {connections.length === 0 ? (
        <SettingRow
          label="No connections yet"
          description="Add a machine, then create a workspace on it."
        />
      ) : (
        connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
        ))
      )}
      <SettingDisclosure label="Add a connection">
        <AddConnection />
      </SettingDisclosure>
    </SettingGroup>
  );
}

function ConnectionRow({ connection }: { readonly connection: SshConnection }): JSX.Element {
  const test = useWorkbench((state) => state.connectionTests[connection.id]);
  const testConnection = useWorkbench((state) => state.testConnection);
  const deleteConnection = useWorkbench((state) => state.deleteConnection);
  const forgetHostKey = useWorkbench((state) => state.forgetConnectionHostKey);
  const createWorkspace = useWorkbench((state) => state.createWorkspace);
  const setView = useWorkbench((state) => state.setView);
  const [testing, setTesting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const address = `${connection.username}@${connection.host}${
    connection.port === 22 ? "" : `:${connection.port}`
  }`;

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
    <>
      <SettingRow
        label={connection.name}
        description={
          <>
            {address} · {authWording(connection.auth)}
            <br />
            <span className="setting__path">
              {connection.hostKeyFingerprint ?? "Host key not known yet — learned on first connection"}
            </span>
            {test ? (
              <>
                <br />
                {test.ok
                  ? `Connected. Home directory ${test.homeDirectory ?? "unknown"}.` +
                    (test.learnedHostKey ? " The host key was recorded." : "")
                  : (test.error ?? "The connection failed.")}
              </>
            ) : null}
          </>
        }
      >
        <button
          type="button"
          className="ghost-button"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            void testConnection(connection.id).finally(() => setTesting(false));
          }}
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          className="ghost-button"
          aria-expanded={picking}
          onClick={() => setPicking((value) => !value)}
        >
          {picking ? "Cancel" : "Add workspace"}
        </button>
        {connection.hostKeyFingerprint ? (
          <button
            type="button"
            className="ghost-button"
            title="Only when the machine was genuinely rebuilt: a changed key is otherwise refused."
            onClick={() => void forgetHostKey(connection.id)}
          >
            Forget key
          </button>
        ) : null}
        <button
          type="button"
          className="ghost-button"
          aria-label={`Remove ${connection.name}`}
          onClick={() => void deleteConnection(connection.id)}
        >
          Remove
        </button>
      </SettingRow>

      {picking ? (
        <div className="setting setting--stacked">
          <div className="setting__text">
            <p className="setting__label">Folder on {connection.name}</p>
            <p className="setting__description">
              Pick the folder the workspace should open.
            </p>
          </div>
          <RemoteDirectoryPicker connectionId={connection.id} onPick={setPicked} />
          <div className="setting__control">
            <button
              type="button"
              className="primary-button"
              disabled={!picked || creating}
              onClick={() => void addWorkspaceHere()}
            >
              {creating ? "Creating…" : `Use ${picked ?? "this folder"}`}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function authWording(auth: SshAuthMethod): string {
  if (auth === "password") {
    return "password in the system credential store";
  }
  if (auth === "key") {
    return "private key in the system credential store";
  }
  return "SSH agent on this computer";
}

const AUTH_METHODS: ReadonlyArray<SegmentOption<SshAuthMethod>> = [
  { value: "password", label: "Password" },
  { value: "key", label: "Private key" },
  { value: "agent", label: "SSH agent" },
];

function AddConnection(): JSX.Element {
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
        // Cleared at once: it is in the credential store now, and there is no
        // reason for it to sit in a form field afterwards.
        setSecret("");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setting setting--stacked">
      <div className="form-grid">
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
            spellCheck={false}
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">User</span>
          <input
            className="text-input"
            value={username}
            spellCheck={false}
            onChange={(event) => setUsername(event.target.value)}
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
          <span className="field__description">Sign-in</span>
          <Choice
            label="Sign-in method"
            value={auth}
            options={AUTH_METHODS}
            onChange={setAuth}
          />
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
          <label className="stacked-field form-grid__full">
            <span className="field__description">Private key</span>
            <textarea
              className="text-input text-input--multiline"
              rows={4}
              value={secret}
              spellCheck={false}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        ) : null}
      </div>
      <p className="setting__description">
        The password or key goes to this computer&rsquo;s credential store and is never
        shown again.
      </p>
      <div className="setting__control">
        <button
          type="button"
          className="ghost-button"
          disabled={!ready || saving}
          onClick={() => void submit()}
        >
          {saving ? "Adding…" : "Add connection"}
        </button>
      </div>
    </div>
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
    return (
      <p className="setting__description">{loading ? "Connecting…" : "Not connected"}</p>
    );
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
