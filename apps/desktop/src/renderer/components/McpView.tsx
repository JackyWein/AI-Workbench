import { useEffect, useState, type JSX } from "react";
import { Plug, PlugZap, Trash2 } from "lucide-react";
import type { McpServerConfig, McpServerStatus } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

/**
 * MCP servers belong to the application, not to any one provider (spec §37).
 * Each session then decides which of them it may use (spec §38), which is the
 * toggle in the session's context panel rather than here.
 */
export function McpView(): JSX.Element {
  const servers = useWorkbench((state) => state.mcpServers);
  const statuses = useWorkbench((state) => state.mcpStatuses);
  const refreshMcp = useWorkbench((state) => state.refreshMcp);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  const statusOf = (id: string): McpServerStatus | undefined =>
    statuses.find((status) => status.id === id);

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">MCP servers</h1>
        </div>

        {servers.length === 0 ? (
          <p className="field__description">
            No servers configured. Add one below; a session can then be allowed
            to use it.
          </p>
        ) : (
          <section>
            {servers.map((server) => (
              <ServerEntry key={server.id} server={server} status={statusOf(server.id)} />
            ))}
          </section>
        )}

        <AddServerForm />
      </div>
    </div>
  );
}

function ServerEntry({
  server,
  status,
}: {
  readonly server: McpServerConfig;
  readonly status: McpServerStatus | undefined;
}): JSX.Element {
  const connectMcpServer = useWorkbench((state) => state.connectMcpServer);
  const disconnectMcpServer = useWorkbench((state) => state.disconnectMcpServer);
  const deleteMcpServer = useWorkbench((state) => state.deleteMcpServer);
  const connected = status?.state === "connected";

  return (
    <article className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">{server.name}</span>
        <span className="row__meta">{stateLabel(status)}</span>
      </div>

      <dl className="detail-list">
        <div className="detail">
          <dt className="detail__label">Transport</dt>
          <dd className="detail__value">{server.transport}</dd>
        </div>
        <div className="detail">
          <dt className="detail__label">
            {server.transport === "stdio" ? "Command" : "URL"}
          </dt>
          <dd className="detail__value">
            {server.transport === "stdio"
              ? [server.command, ...server.args].filter(Boolean).join(" ")
              : (server.url ?? "Not set")}
          </dd>
        </div>
      </dl>

      {status?.detail ? (
        <p className="notice" role="note">
          {status.detail}
        </p>
      ) : null}

      {status && status.tools.length > 0 ? (
        <div className="tag-list">
          {status.tools.map((tool) => (
            <span className="tag" key={tool.name}>
              {tool.name}
            </span>
          ))}
        </div>
      ) : null}

      <div className="provider-entry__config">
        <button
          type="button"
          className="quiet-button"
          onClick={() =>
            void (connected ? disconnectMcpServer(server.id) : connectMcpServer(server.id))
          }
        >
          {connected ? (
            <Plug size={13} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PlugZap size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
          {connected ? "Disconnect" : "Connect"}
        </button>
        <button
          type="button"
          className="quiet-button"
          onClick={() => void deleteMcpServer(server.id)}
        >
          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
          Remove
        </button>
      </div>
    </article>
  );
}

function AddServerForm(): JSX.Element {
  const saveMcpServer = useWorkbench((state) => state.saveMcpServer);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    if (!id.trim() || !name.trim() || !command.trim()) {
      return;
    }
    setSaving(true);
    try {
      await saveMcpServer({
        id: id.trim(),
        name: name.trim(),
        // Only stdio is implemented; the other transports say so rather than
        // pretending to work (spec §37).
        transport: "stdio",
        command: command.trim(),
        args: args.trim().length > 0 ? args.trim().split(/\s+/) : [],
        env: {},
        enabled: true,
      });
      setId("");
      setName("");
      setCommand("");
      setArgs("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">Add a server</span>
        <span className="row__meta">stdio</span>
      </div>
      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">Identifier</span>
          <input
            className="text-input"
            value={id}
            placeholder="Short and unique, e.g. filesystem"
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input
            className="text-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Command</span>
          <input
            className="text-input"
            value={command}
            placeholder="The executable to start"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Arguments</span>
          <input
            className="text-input"
            value={args}
            placeholder="Optional, separated by spaces"
            onChange={(event) => setArgs(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void submit()}
          disabled={saving || !id.trim() || !name.trim() || !command.trim()}
        >
          {saving ? "Saving" : "Add server"}
        </button>
      </div>
    </section>
  );
}

function stateLabel(status: McpServerStatus | undefined): string {
  switch (status?.state) {
    case "connected":
      return `Connected · ${status.tools.length} tools`;
    case "connecting":
      return "Connecting";
    case "failed":
      return "Failed";
    case "unsupported":
      return "Transport not implemented";
    case "disconnected":
      return "Disconnected";
    default:
      return "Not connected";
  }
}
