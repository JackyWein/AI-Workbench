import { useEffect, useState, type JSX } from "react";
import { FolderOpen, KeyRound } from "lucide-react";
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
  const [editing, setEditing] = useState(false);

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
        <button
          type="button"
          className="ghost-button"
          aria-expanded={editing}
          onClick={() => setEditing((value) => !value)}
        >
          Change sign-in
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

      {editing ? <ChangeSignIn connection={connection} onDone={() => setEditing(false)} /> : null}

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

/** What the sign-in part of a connection form holds. */
interface SignIn {
  readonly auth: SshAuthMethod;
  readonly secret: string;
  readonly passphrase: string;
  /** A key file picked in the dialog; the main process reads it. */
  readonly keyFile: string | null;
}

const EMPTY_SIGN_IN: SignIn = { auth: "password", secret: "", passphrase: "", keyFile: null };

/** Whether the sign-in part has what its method needs. */
function signInReady(signIn: SignIn): boolean {
  if (signIn.auth === "agent") {
    return true;
  }
  if (signIn.auth === "key") {
    return signIn.keyFile !== null || signIn.secret.trim() !== "";
  }
  return signIn.secret !== "";
}

/** The sign-in as the main process takes it; nothing that is not needed. */
function signInInput(signIn: SignIn): {
  auth: SshAuthMethod;
  secret?: string;
  passphrase?: string;
  keyFile?: string;
} {
  if (signIn.auth === "agent") {
    return { auth: "agent" };
  }
  if (signIn.auth === "password") {
    return { auth: "password", secret: signIn.secret };
  }
  return {
    auth: "key",
    ...(signIn.keyFile ? { keyFile: signIn.keyFile } : { secret: signIn.secret }),
    ...(signIn.passphrase ? { passphrase: signIn.passphrase } : {}),
  };
}

/**
 * Password, private key (a file, or pasted) with its passphrase, or the SSH
 * agent. A key file is read by the main process, so the key itself never
 * passes through this window.
 */
function SignInFields({
  value,
  onChange,
}: {
  readonly value: SignIn;
  readonly onChange: (next: SignIn) => void;
}): JSX.Element {
  const chooseKeyFile = useWorkbench((state) => state.chooseKeyFile);
  const onWindows = navigator.userAgent.includes("Windows");
  const set = (patch: Partial<SignIn>): void => onChange({ ...value, ...patch });
  const fileName = value.keyFile?.split(/[\\/]/).pop() ?? null;

  return (
    <>
      <label className="stacked-field">
        <span className="field__description">Sign-in</span>
        <Choice
          label="Sign-in method"
          value={value.auth}
          options={AUTH_METHODS}
          onChange={(auth) => set({ auth, secret: "", passphrase: "", keyFile: null })}
        />
      </label>
      {value.auth === "password" ? (
        <label className="stacked-field">
          <span className="field__description">Password</span>
          <input
            className="text-input"
            type="password"
            value={value.secret}
            onChange={(event) => set({ secret: event.target.value })}
          />
        </label>
      ) : null}
      {value.auth === "key" ? (
        <div className="stacked-field form-grid__full">
          <span className="field__description">Private key</span>
          {fileName ? (
            <div className="key-file">
              <span className="key-file__name" title={value.keyFile ?? ""}>
                {fileName}
              </span>
              <button type="button" className="link-button" onClick={() => set({ keyFile: null })}>
                Paste a key instead
              </button>
            </div>
          ) : (
            <>
              <div className="key-file">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    void chooseKeyFile().then((path) => {
                      if (path) {
                        set({ keyFile: path, secret: "" });
                      }
                    })
                  }
                >
                  <KeyRound size={13} strokeWidth={1.75} aria-hidden="true" />
                  Choose key file…
                </button>
                <span className="field__description">
                  usually id_ed25519 or id_rsa in your .ssh folder — not the .pub file
                </span>
              </div>
              <textarea
                className="text-input text-input--multiline"
                rows={4}
                value={value.secret}
                spellCheck={false}
                aria-label="Private key"
                placeholder="…or paste it: -----BEGIN OPENSSH PRIVATE KEY-----"
                onChange={(event) => set({ secret: event.target.value })}
              />
            </>
          )}
        </div>
      ) : null}
      {value.auth === "key" ? (
        <label className="stacked-field">
          <span className="field__description">Passphrase (only if the key has one)</span>
          <input
            className="text-input"
            type="password"
            value={value.passphrase}
            autoComplete="off"
            onChange={(event) => set({ passphrase: event.target.value })}
          />
        </label>
      ) : null}
      {value.auth === "agent" ? (
        <p className="setting__description form-grid__full">
          {onWindows
            ? "Uses the keys loaded into Windows' OpenSSH Authentication Agent (ssh-add)."
            : "Uses the keys loaded into your SSH agent (ssh-add)."}
        </p>
      ) : null}
    </>
  );
}

/** "dev@build.example.com:2222" pasted into the host field fills all three. */
function splitAddress(text: string): { host: string; username?: string; port?: string } {
  const match = /^(?:([^@\s]+)@)?([^@\s:]+)(?::(\d{1,5}))?$/.exec(text.trim());
  if (!match) {
    return { host: text };
  }
  return {
    host: match[2] ?? text,
    ...(match[1] ? { username: match[1] } : {}),
    ...(match[3] ? { port: match[3] } : {}),
  };
}

function AddConnection(): JSX.Element {
  const createConnection = useWorkbench((state) => state.createConnection);
  const testConnection = useWorkbench((state) => state.testConnection);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [signIn, setSignIn] = useState<SignIn>(EMPTY_SIGN_IN);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const ready =
    host.trim() !== "" && username.trim() !== "" && signInReady(signIn);

  const submit = async (): Promise<void> => {
    if (!ready) {
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const result = await createConnection({
        name: name.trim() || host.trim(),
        host: host.trim(),
        port: Number.parseInt(port, 10) || 22,
        username: username.trim(),
        ...signInInput(signIn),
      });
      if ("error" in result) {
        setProblem(result.error);
        return;
      }
      setName("");
      setHost("");
      setPort("22");
      setUsername("");
      // Cleared at once: it is in the credential store now, and there is no
      // reason for it to sit in a form field afterwards.
      setSignIn(EMPTY_SIGN_IN);
      // Tried straight away, so whether it works is known now, not later.
      void testConnection(result.connection.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setting setting--stacked">
      <div className="form-grid">
        <label className="stacked-field">
          <span className="field__description">Host</span>
          <input
            className="text-input"
            value={host}
            placeholder="build.example.com or dev@build.example.com"
            spellCheck={false}
            onChange={(event) => setHost(event.target.value)}
            onBlur={() => {
              const parts = splitAddress(host);
              setHost(parts.host);
              if (parts.username) {
                setUsername(parts.username);
              }
              if (parts.port) {
                setPort(parts.port);
              }
            }}
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
          <span className="field__description">Name (optional)</span>
          <input
            className="text-input"
            value={name}
            placeholder="What you call this machine"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <SignInFields value={signIn} onChange={setSignIn} />
      </div>
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <p className="setting__description">
        The password, key and passphrase go to this computer&rsquo;s credential store and are never
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

/** A new password or key for a machine that is already set up. */
function ChangeSignIn({
  connection,
  onDone,
}: {
  readonly connection: SshConnection;
  readonly onDone: () => void;
}): JSX.Element {
  const updateSignIn = useWorkbench((state) => state.updateConnectionSignIn);
  const testConnection = useWorkbench((state) => state.testConnection);
  const [signIn, setSignIn] = useState<SignIn>({ ...EMPTY_SIGN_IN, auth: connection.auth });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      const result = await updateSignIn({ id: connection.id, ...signInInput(signIn) });
      if ("error" in result) {
        setProblem(result.error);
        return;
      }
      void testConnection(connection.id);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setting setting--stacked">
      <div className="form-grid">
        <SignInFields value={signIn} onChange={setSignIn} />
      </div>
      {problem ? (
        <p className="setting__description" data-tone="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="setting__control">
        <button type="button" className="ghost-button" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={saving || !signInReady(signIn)}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save sign-in"}
        </button>
      </div>
    </div>
  );
}

/**
 * Picks a folder on a machine, one directory at a time. A remote machine has
 * no folder dialog to borrow, so this is the browser for it.
 */
function RemoteDirectoryPicker({
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
