import { useState, type JSX } from "react";
import type {
  ChatMessage,
  ProviderSummary,
  Session,
  SessionStatus,
  Workspace,
} from "@ai-workbench/shared";
import { ChatView } from "./ChatView.js";
import { Composer } from "./Composer.js";
import { SessionHeader } from "./SessionHeader.js";
import type { AggregatedUsage } from "@ai-workbench/shared";

interface TeamSessionPreviewProps {
  readonly session: Session;
  readonly workspace: Workspace | undefined;
  readonly providers: ProviderSummary[];
  readonly usage: AggregatedUsage | null;
  readonly status: SessionStatus | undefined;
}

type AgentKey = "lead" | "builder" | "reviewer" | "all";

const AGENTS: ReadonlyArray<{ key: AgentKey; name: string; state: string; meta: string }> = [
  { key: "lead", name: "Lead", state: "waiting", meta: "reviewing" },
  { key: "builder", name: "Builder", state: "ready", meta: "working" },
  { key: "reviewer", name: "Reviewer", state: "idle", meta: "waiting" },
  { key: "all", name: "All", state: "idle", meta: "together" },
];

/**
 * Clickable design preview: how a team would live inside a session.
 * Real components (SessionHeader, ChatView, Composer) with mock team data —
 * no backend, no IPC. Gated behind developer mode + palette toggle, so it
 * can never leak into normal use. Delete this file once the real design
 * is agreed.
 */
export function TeamSessionPreview({
  session,
  workspace,
  providers,
  usage,
  status,
}: TeamSessionPreviewProps): JSX.Element {
  const [agent, setAgent] = useState<AgentKey>("builder");
  const [recipient, setRecipient] = useState("Builder");
  const [extra, setExtra] = useState<ChatMessage[]>([]);

  const base = mocks(session.id, agent === "all" ? "lead" : agent);
  const teamed: ChatMessage[] =
    agent === "all"
      ? [...mocks(session.id, "lead"), ...mocks(session.id, "builder"), ...extra]
      : [...base, ...extra];

  const cycleRecipient = (): void => {
    const order = ["Lead", "Builder", "Reviewer"];
    const next = order[(order.indexOf(recipient) + 1) % order.length] ?? "Lead";
    setRecipient(next);
  };

  return (
    <>
      <SessionHeader
        session={session}
        workspace={workspace}
        providers={providers}
        usage={usage}
        status={status}
      />
      <div className="main__body">
        <p className="notice" role="note" style={{ margin: "0 0 4px" }}>
          Mockup preview (developer mode): team OMEGA inside this session.{" "}
          <span className="row__meta">Tabs switch members · To: chooses the recipient</span>
        </p>
        <dl className="detail-list">
          <div className="detail">
            <dt className="detail__label">Team goal</dt>
            <dd className="detail__value">
              Build a premium 3D space website{" "}
              <span className="row__meta">· OMEGA · 2 calls of 30 · Running</span>
            </dd>
          </div>
        </dl>
        <div className="panel__tabs" role="tablist" aria-label="Team members">
          {AGENTS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              className="panel__tab"
              aria-selected={agent === entry.key}
              onClick={() => {
                setAgent(entry.key);
                if (entry.key !== "all") {
                  setRecipient(entry.name);
                }
              }}
            >
              <span className="status-dot" data-state={entry.state} aria-hidden="true" />{" "}
              {entry.name} · {entry.meta}
            </button>
          ))}
        </div>
        <ChatView
          key={`${session.id}:team-preview:${agent}:${teamed.length}`}
          messages={teamed}
        />
        {/* One run-control strip, the same width and chrome as the composer
            and directly attached to its top edge: Pause, Stop, the call
            counter, and the recipient. No loose floating buttons. */}
        <div style={{ maxWidth: 620, margin: "0 auto 2px", padding: "0 14px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 10px",
              background: "var(--surface-raised)",
              border: "1px solid var(--border-strong)",
              borderBottom: "none",
              borderRadius: "12px 12px 0 0",
              boxShadow: "0 -4px 12px rgba(0, 0, 0, 0.18)",
            }}
          >
            <button type="button" className="quiet-button">
              Pause
            </button>
            <button type="button" className="quiet-button">
              Stop
            </button>
            <span
              className="row__meta"
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              2 calls of 30
            </span>
            <button
              type="button"
              className="pill pill--acc"
              onClick={cycleRecipient}
              title="Recipient (mockup)"
              style={{ marginLeft: "auto", flex: "none" }}
            >
              To: {recipient} ▾
            </button>
          </div>
        </div>
        <div style={{ marginTop: -2 }}>
        <Composer
          busy={false}
          disabled={false}
          onSend={(text) => {
            const now = new Date();
            setExtra((list) => [
              ...list,
              {
                id: `extra-${Date.now()}`,
                sessionId: session.id,
                role: "user",
                content: text,
                status: "complete",
                providerId: null,
                modelId: null,
                toolCalls: [],
                attachments: [],
                usage: null,
                error: null,
                createdAt: now,
                updatedAt: now,
              },
            ]);
          }}
          onCancel={() => undefined}
        />
        </div>
      </div>
    </>
  );
}

/**
 * The right panel for the team mode: members with their live state instead of
 * the solo session's model/usage numbers. Mock only, same lifecycle as the
 * preview itself.
 */
export function TeamPreviewPanel(): JSX.Element {
  return (
    <aside className="context" aria-label="Team context">
      <div className="context__card">
        <div className="context__model">
          <div className="context__model-text">
            <span className="context__model-name">OMEGA</span>
            <span className="context__model-provider">3 agents · Team Test</span>
          </div>
        </div>
        <div className="context__status">
          <span className="pill pill--live">
            <span className="status-dot" data-state="ready" aria-hidden="true" /> Running
          </span>
        </div>
      </div>

      <div className="context__section">
        <p className="context__heading">Members</p>
        <div className="detail-list">
          <div className="detail">
            <dt className="detail__label">
              <span className="status-dot" data-state="waiting" aria-hidden="true" /> Lead
            </dt>
            <dd className="detail__value">
              OpenCode <span className="row__meta">· reviewing</span>
            </dd>
          </div>
          <div className="detail">
            <dt className="detail__label">
              <span className="status-dot" data-state="ready" aria-hidden="true" /> Builder
            </dt>
            <dd className="detail__value">
              OpenCode <span className="row__meta">· working</span>
            </dd>
          </div>
          <div className="detail">
            <dt className="detail__label">
              <span className="status-dot" data-state="idle" aria-hidden="true" /> Reviewer
            </dt>
            <dd className="detail__value">
              OpenCode <span className="row__meta">· waiting</span>
            </dd>
          </div>
        </div>
      </div>

      <div className="context__section">
        <p className="context__heading">Run</p>
        <div className="detail-list">
          <div className="detail">
            <dt className="detail__label">Goal</dt>
            <dd className="detail__value">Build a premium 3D space website</dd>
          </div>
          <div className="detail">
            <dt className="detail__label">Agent calls</dt>
            <dd className="detail__value">2 of 30</dd>
          </div>
          <div className="detail">
            <dt className="detail__label">Tasks</dt>
            <dd className="detail__value">1 running · 0 done</dd>
          </div>
        </div>
      </div>
    </aside>
  );
}

function mocks(sessionId: string, agent: Exclude<AgentKey, "all">): ChatMessage[] {
  const at = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
  if (agent === "lead") {
    return [
      msg(sessionId, "m-lead-1", "user", "Baue eine richtig geile Webseite mit 3D-Modellen über das Weltall.", "complete", null, null, at(4)),
      msg(sessionId, "m-lead-2", "assistant", "Verstanden. Drei Aufgaben: Storefront bauen (Builder), Review (Reviewer), finale Abnahme.", "complete", "opencode", "Lead · OpenCode", at(3), [
        { id: "t1", name: "task.create", summary: "„Build a premium 3D space website“ → Builder", state: "completed" },
      ]),
      msg(sessionId, "m-lead-3", "assistant", "Warte auf Builders Ergebnis, prüfe dann …", "streaming", "opencode", "Lead · OpenCode", at(1)),
    ];
  }
  if (agent === "builder") {
    return [
      msg(sessionId, "m-builder-1", "assistant", "Build a premium 3D space website. Modern, keine Emojis, schnell.", "complete", "opencode", "Lead → Builder", at(3)),
      msg(sessionId, "m-builder-2", "assistant", "Lege das Projekt an und baue die Seite.", "complete", "opencode", "Builder · OpenCode", at(2), [
        { id: "t2", name: "bash.exec", summary: "„npm create vite@latest space-site“ — läuft", state: "running" },
        { id: "t3", name: "edit", summary: "src/App.tsx — wartet", state: "running" },
      ]),
      msg(sessionId, "m-builder-3", "assistant", "Scaffolding steht, jetzt …", "streaming", "opencode", "Builder · OpenCode", at(0)),
    ];
  }
  return [
    msg(sessionId, "m-rev-1", "assistant", "Noch nichts zu prüfen — ich springe an, sobald der Builder fertig meldet.", "complete", "opencode", "Reviewer · OpenCode", at(2)),
  ];
}

function msg(
  sessionId: string,
  id: string,
  role: "user" | "assistant",
  content: string,
  status: "complete" | "streaming",
  providerId: string | null,
  modelId: string | null,
  at: Date,
  toolCalls: ChatMessage["toolCalls"] = [],
): ChatMessage {
  return {
    id,
    sessionId,
    role,
    content,
    status,
    providerId,
    modelId,
    toolCalls,
    attachments: [],
    usage: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}
