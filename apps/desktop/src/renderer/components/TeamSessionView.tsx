import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FileText, Flag, FolderOpen, Image, Pause, Play, Square, Users } from "lucide-react";
import type {
  AgentDefinition,
  ProviderSummary,
  Session,
  TeamArtifact,
  TeamDecision,
  TeamDefinition,
  TeamMessage,
  TeamRun,
  TeamRunSnapshot,
  TeamTask,
  TeamTurn,
} from "@ai-workbench/shared";
import { Composer } from "./Composer.js";
import { MessageBody } from "./MessageItem.js";
import { SessionHeader } from "./SessionHeader.js";
import {
  ARTIFACT_MAX_LINES,
  ARTIFACT_PREVIEW_LINES,
  artifactLanguage,
  artifactReason,
  classifyArtifact,
  diffLineKind,
  diffStats,
  extractCodeContent,
} from "../lib/team-artifacts.js";
import {
  MemberAvatar,
  TaskIcon,
  durationLabel,
  isGoing,
  memberLine,
  memberStateOf,
  runLabel,
  runTone,
  runsOn,
  stopReasonLabel,
  taskLabel,
  useLiveReports,
  withNames,
} from "./TeamParts.js";
import { useWorkbench } from "../store/workbench.js";
import { useNow } from "../lib/usage.js";

/**
 * A team working inside a session (spec §40–§53, §80).
 *
 * The session's own conversation makes way for the team's. At the top, the
 * goal and how far the run has come; below it, the members, each with where
 * it stands — pick one to follow only its story. The timeline reads like a
 * conversation: who said what to whom, which tasks moved, what was published
 * and decided, in the order it happened. The run is the only source; nothing
 * here is made up, and a member that has not spoken yet says so.
 *
 * The box at the bottom gives the team a goal, which starts a run in this
 * session's workspace, or, while a run is going, a note to its lead that the
 * lead reads on its next turn.
 */
export function TeamSessionView({
  session,
  team,
  snapshot,
}: {
  readonly session: Session;
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot | null;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const workspaces = useWorkbench((state) => state.workspaces);
  const refreshTeamRun = useWorkbench((state) => state.refreshTeamRun);
  const setSessionTeam = useWorkbench((state) => state.setSessionTeam);
  const sendTeamNote = useWorkbench((state) => state.sendTeamNote);

  const runId = (session.uiState["teamRunId"] as string | null | undefined) ?? null;
  const workspace = workspaces.find((entry) => entry.id === session.workspaceId);
  const [member, setMember] = useState<string>(EVERYONE);

  // Follow the run: team events refresh it, and a slow tick keeps it honest
  // while a turn streams without producing a team event.
  useEffect(() => {
    if (!runId) {
      return;
    }
    void refreshTeamRun(runId);
    const timer = setInterval(() => void refreshTeamRun(runId), 3_000);
    return () => clearInterval(timer);
  }, [refreshTeamRun, runId]);

  // A member that left the team is no longer a view to stay on.
  useEffect(() => {
    if (member !== EVERYONE && !team.agents.some((agent) => agent.id === member)) {
      setMember(EVERYONE);
    }
  }, [member, team.agents]);

  const current = snapshot && snapshot.run.id === runId ? snapshot : null;
  const run = current?.run ?? null;
  const going = isGoing(run);
  const live = useLiveReports(run);
  const lead = team.agents.find((agent) => agent.id === team.leadAgentId) ?? team.agents[0];
  // Where this run writes: the team's own folder, or this session's workspace.
  const folder =
    team.settings.workingDirectory ??
    workspaces.find((entry) => entry.id === (run?.workspaceId ?? session.workspaceId))?.path ??
    workspace?.path ??
    null;
  // Files go with a note or a goal when at least one member's provider takes
  // them (capability-based, never by provider name).
  const attach = teamAttachSupport(team, providers);

  return (
    <>
      <SessionHeader
        session={session}
        workspace={workspace}
        providers={providers}
        usage={null}
        status={going ? "working" : run ? "idle" : undefined}
      />
      <div className="main__body team-session">
        <RunHeader session={session} team={team} snapshot={current} folder={folder} />

        <MemberStrip
          team={team}
          providers={providers}
          snapshot={current}
          live={live}
          selected={member}
          onSelect={setMember}
        />

        <TeamTimeline
          team={team}
          providers={providers}
          snapshot={current}
          member={member}
          live={live}
          folder={folder}
        />

        <Composer
          key={`team:${session.id}`}
          draftKey={`team:${session.id}`}
          busy={false}
          disabled={false}
          placeholder={
            going
              ? `Note to ${lead?.displayName ?? "the team"} — read on its next turn`
              : run
                ? "Give the team its next goal…"
                : "Give the team a goal…"
          }
          attach={attach}
          onSend={(text, attachments) => {
            if (going && run) {
              void sendTeamNote(run.id, text, attachments);
            } else {
              // One new run, in this session's workspace.
              void setSessionTeam({ sessionId: session.id, teamId: team.id, goal: text, attachments });
            }
          }}
          onCancel={() => undefined}
        />
      </div>
    </>
  );
}

const EVERYONE = "__team__";

/** The goal, how far the run has come, and what can be done with it. */
function RunHeader({
  session,
  team,
  snapshot,
  folder,
}: {
  readonly session: Session;
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot | null;
  readonly folder: string | null;
}): JSX.Element {
  const pauseTeamRun = useWorkbench((state) => state.pauseTeamRun);
  const resumeTeamRun = useWorkbench((state) => state.resumeTeamRun);
  const cancelTeamRun = useWorkbench((state) => state.cancelTeamRun);
  const clearSessionTeam = useWorkbench((state) => state.clearSessionTeam);
  const [working, setWorking] = useState(false);
  const run = snapshot?.run ?? null;
  const going = isGoing(run);
  const now = useNow(going ? 30_000 : 600_000);

  const act = (action: () => Promise<unknown>): void => {
    setWorking(true);
    void action().finally(() => setWorking(false));
  };

  const tasks = snapshot?.tasks ?? [];
  const done = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const active = tasks.filter((task) => task.status === "running" || task.status === "claimed").length;
  const started = run?.startedAt ?? run?.createdAt ?? null;

  return (
    <header className="team-run" data-status={run?.status ?? "none"}>
      <div className="team-run__top">
        <span className="team-run__team">
          <Users size={13} strokeWidth={1.75} aria-hidden="true" />
          {team.name}
        </span>
        {run ? (
          <span className="pill" data-tone={runTone(run)}>
            {runLabel(run)}
          </span>
        ) : null}
        {run && active > 1 ? (
          <span className="pill" data-tone="live" title={`${active} tasks running at the same time`}>
            {active} parallel
          </span>
        ) : null}
        <span className="team-run__spacer" />
        {run?.status === "running" ? (
          <button
            type="button"
            className="quiet-button"
            disabled={working}
            onClick={() => act(() => pauseTeamRun(run.id))}
          >
            <Pause size={13} strokeWidth={1.75} aria-hidden="true" />
            Pause
          </button>
        ) : null}
        {run?.status === "paused" ? (
          <button
            type="button"
            className="quiet-button"
            disabled={working}
            onClick={() => act(() => resumeTeamRun(run.id))}
          >
            <Play size={13} strokeWidth={1.75} aria-hidden="true" />
            Resume
          </button>
        ) : null}
        {run && (going || run.status === "paused") ? (
          <button
            type="button"
            className="quiet-button"
            data-tone="danger"
            disabled={working}
            onClick={() => act(() => cancelTeamRun(run.id))}
          >
            <Square size={12} strokeWidth={1.75} aria-hidden="true" />
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="quiet-button"
          title="Leave team mode; the session talks to its own model again"
          onClick={() => void clearSessionTeam(session.id)}
        >
          Solo session
        </button>
      </div>

      {run ? (
        <div
          className="team-run__progress"
          role="progressbar"
          aria-label="Tasks done"
          aria-valuemin={0}
          aria-valuemax={Math.max(tasks.length, 1)}
          aria-valuenow={done}
        >
          <span className="team-run__bar">
            <span
              className="team-run__fill"
              style={{ width: tasks.length > 0 ? `${(done / tasks.length) * 100}%` : "0%" }}
            />
          </span>
          <span className="team-run__count">
            {tasks.length === 0 ? "Planning" : `${done} of ${tasks.length} tasks`}
            {failed > 0 ? <span className="team-run__failed"> · {failed} failed</span> : null}
          </span>
        </div>
      ) : null}

      <p className="team-run__meta">
        <FolderOpen size={12} strokeWidth={1.75} aria-hidden="true" />
        {folder ? (
          <span className="team-run__path" title={folder}>
            {folder}
          </span>
        ) : (
          <span>No folder: open a local workspace</span>
        )}
        {run ? (
          <>
            <span className="team-run__dot" aria-hidden="true" />
            <span>
              {run.agentCalls} of {run.limits.maxAgentCalls} calls
            </span>
            {started ? (
              <>
                <span className="team-run__dot" aria-hidden="true" />
                <span>{durationLabel(started, run.finishedAt ?? new Date(now))}</span>
              </>
            ) : null}
          </>
        ) : null}
      </p>
    </header>
  );
}

/** Everyone on the team, where each stands; picking one follows only its story. */
function MemberStrip({
  team,
  providers,
  snapshot,
  live,
  selected,
  onSelect,
}: {
  readonly team: TeamDefinition;
  readonly providers: readonly ProviderSummary[];
  readonly snapshot: TeamRunSnapshot | null;
  readonly live: (agentId: string) => string | null;
  readonly selected: string;
  readonly onSelect: (member: string) => void;
}): JSX.Element {
  const working = team.agents.filter((agent) => {
    const state = memberStateOf(agent.id, snapshot, live(agent.id));
    return state === "running" || state === "waiting";
  });
  return (
    <div className="team-members" role="tablist" aria-label="Team members">
      <button
        type="button"
        role="tab"
        className="team-member"
        aria-selected={selected === EVERYONE}
        onClick={() => onSelect(EVERYONE)}
      >
        <span className="avatar avatar--team" aria-hidden="true">
          <Users size={13} strokeWidth={1.75} />
        </span>
        <span className="team-member__text">
          <span className="team-member__name">Everyone</span>
          <span className="team-member__line">
            {snapshot && isGoing(snapshot.run) && working.length > 0
              ? `${working.length} of ${team.agents.length} at work`
              : `${team.agents.length} member${team.agents.length === 1 ? "" : "s"}`}
          </span>
        </span>
      </button>
      {team.agents.map((agent) => {
        const report = live(agent.id);
        const state = memberStateOf(agent.id, snapshot, report);
        const line = memberLine(agent.id, snapshot, report);
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            className="team-member"
            data-state={state}
            aria-selected={selected === agent.id}
            title={`${agent.displayName} · ${runsOn(agent, providers)}\n${line}`}
            onClick={() => onSelect(agent.id)}
          >
            <MemberAvatar agent={agent} providers={providers} state={state} size={28} />
            <span className="team-member__text">
              <span className="team-member__name">
                {agent.displayName}
                {agent.id === team.leadAgentId ? <span className="team-member__lead">lead</span> : null}
              </span>
              <span className="team-member__line">{line}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type FeedEntry =
  | { readonly kind: "message"; readonly id: string; readonly at: Date; readonly author: string; readonly message: TeamMessage }
  | { readonly kind: "task"; readonly id: string; readonly at: Date; readonly author: string; readonly task: TeamTask }
  | { readonly kind: "artifact"; readonly id: string; readonly at: Date; readonly author: string; readonly artifact: TeamArtifact }
  | { readonly kind: "decision"; readonly id: string; readonly at: Date; readonly author: string; readonly decision: TeamDecision }
  | { readonly kind: "turn"; readonly id: string; readonly at: Date; readonly author: string; readonly turn: TeamTurn };

/** Entries by one author this close together read as one turn. */
const GROUP_MS = 5 * 60_000;

function TeamTimeline({
  team,
  providers,
  snapshot,
  member,
  live,
  folder,
}: {
  readonly team: TeamDefinition;
  readonly providers: readonly ProviderSummary[];
  readonly snapshot: TeamRunSnapshot | null;
  readonly member: string;
  readonly live: (agentId: string) => string | null;
  readonly folder: string | null;
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const agents = useMemo(() => new Map(team.agents.map((agent) => [agent.id, agent])), [team.agents]);
  const nameOf = (id: string): string =>
    id === "user" ? "You" : id === "*" ? "everyone" : (agents.get(id)?.displayName ?? "A former member");
  const entries = useMemo(() => (snapshot ? feedFor(snapshot, member) : []), [snapshot, member]);
  const agent = member === EVERYONE ? null : (agents.get(member) ?? null);
  const run = snapshot?.run ?? null;
  const working = team.agents
    .filter((entry) => agent === null || entry.id === agent.id)
    .map((entry) => ({ agent: entry, detail: live(entry.id) }))
    .filter((entry): entry is { agent: AgentDefinition; detail: string } => entry.detail !== null);

  // Stays at the newest entry while someone reads there; scrolled up, it
  // leaves them where they are.
  useEffect(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (nearBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries.length, working.length]);

  return (
    <div className="chat team-feed" ref={scroller} role="log" aria-live="polite" aria-label="Team activity">
      <div className="chat__inner">
        {!snapshot ? (
          <TeamIntro team={team} providers={providers} folder={folder} />
        ) : (
          <>
            {agent ? (
              <MemberCard
                agent={agent}
                team={team}
                providers={providers}
                snapshot={snapshot}
                live={live(agent.id)}
              />
            ) : null}
            {entries.length === 0 ? (
              <p className="team-feed__empty">
                {agent ? `Nothing from ${agent.displayName} yet.` : "Nothing yet — the run has just begun."}
              </p>
            ) : (
              entries.map((entry, index) => {
                const previous = entries[index - 1];
                const head =
                  !previous ||
                  previous.author !== entry.author ||
                  groupKey(previous) !== groupKey(entry) ||
                  entry.at.getTime() - previous.at.getTime() > GROUP_MS;
                const author = agents.get(entry.author) ?? null;
                return (
                  <FeedItem
                    key={entry.id}
                    entry={entry}
                    head={head}
                    author={author}
                    authorName={nameOf(entry.author)}
                    providers={providers}
                    team={team}
                    nameOf={nameOf}
                    snapshot={snapshot}
                  />
                );
              })
            )}
            {run && agent === null ? <RunEnding run={run} team={team} /> : null}
            {working.map(({ agent: entry, detail }) => (
              <div className="team-live" key={entry.id}>
                <MemberAvatar agent={entry} providers={providers} state="running" size={22} />
                <span className="team-live__name">{entry.displayName}</span>
                <span className="team-live__detail">{detail}</span>
                <span className="team-live__dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** A message stays apart from a message to someone else. */
function groupKey(entry: FeedEntry): string {
  return entry.kind === "message" ? `message:${entry.message.to}` : "work";
}

/** Before the first run: who is on the team and where it will work. */
function TeamIntro({
  team,
  providers,
  folder,
}: {
  readonly team: TeamDefinition;
  readonly providers: readonly ProviderSummary[];
  readonly folder: string | null;
}): JSX.Element {
  return (
    <div className="team-intro">
      <p className="team-intro__title">{team.name} is ready</p>
      <p className="team-intro__hint">
        Write a goal below. {team.agents.find((agent) => agent.id === team.leadAgentId)?.displayName ?? "The lead"}{" "}
        plans the work and hands it out; the team works in{" "}
        <span className="team-intro__path">{folder ?? "this session's workspace"}</span>.
      </p>
      <ul className="team-intro__members">
        {team.agents.map((agent) => (
          <li key={agent.id}>
            <MemberAvatar agent={agent} providers={providers} size={30} />
            <span className="team-intro__text">
              <span className="team-intro__name">
                {agent.displayName}
                {agent.id === team.leadAgentId ? <span className="team-member__lead">lead</span> : null}
              </span>
              <span className="team-intro__role">{agent.role.trim() || runsOn(agent, providers)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One member, followed: who it is, what it runs on and where it stands. */
function MemberCard({
  agent,
  team,
  providers,
  snapshot,
  live,
}: {
  readonly agent: AgentDefinition;
  readonly team: TeamDefinition;
  readonly providers: readonly ProviderSummary[];
  readonly snapshot: TeamRunSnapshot;
  readonly live: string | null;
}): JSX.Element {
  const state = memberStateOf(agent.id, snapshot, live);
  return (
    <div className="team-now" data-state={state}>
      <MemberAvatar agent={agent} providers={providers} state={state} size={36} />
      <div className="team-now__text">
        <p className="team-now__name">
          {agent.displayName}
          {agent.id === team.leadAgentId ? <span className="team-member__lead">lead</span> : null}
          <span className="team-now__runs">{runsOn(agent, providers)}</span>
        </p>
        {agent.role.trim() ? <p className="team-now__role">{agent.role.trim()}</p> : null}
        <p className="team-now__state">
          <span className="status-dot" data-state={state} aria-hidden="true" />
          {live ? `Working · ${live}` : memberLine(agent.id, snapshot, null)}
        </p>
      </div>
    </div>
  );
}

function FeedItem({
  entry,
  head,
  author,
  authorName,
  providers,
  team,
  nameOf,
  snapshot,
}: {
  readonly entry: FeedEntry;
  readonly head: boolean;
  readonly author: AgentDefinition | null;
  readonly authorName: string;
  readonly providers: readonly ProviderSummary[];
  readonly team: TeamDefinition;
  readonly nameOf: (id: string) => string;
  readonly snapshot: TeamRunSnapshot;
}): JSX.Element {
  const time = entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <article
      className="team-entry"
      data-kind={entry.kind}
      data-head={head}
      data-from={entry.author === "user" ? "you" : "member"}
    >
      <div className="team-entry__gutter">
        {head ? (
          <MemberAvatar agent={author} you={entry.author === "user"} providers={providers} size={28} />
        ) : (
          <time className="team-entry__hover-time">{time}</time>
        )}
      </div>
      <div className="team-entry__main">
        {head ? (
          <div className="team-entry__meta">
            <span className="team-entry__who">{authorName}</span>
            {entry.kind === "message" ? (
              <span className="team-entry__to">to {nameOf(entry.message.to)}</span>
            ) : null}
            <time>{time}</time>
          </div>
        ) : null}
        <EntryBody entry={entry} team={team} nameOf={nameOf} snapshot={snapshot} />
      </div>
    </article>
  );
}

function EntryBody({
  entry,
  team,
  nameOf,
  snapshot,
}: {
  readonly entry: FeedEntry;
  readonly team: TeamDefinition;
  readonly nameOf: (id: string) => string;
  readonly snapshot: TeamRunSnapshot;
}): JSX.Element {
  switch (entry.kind) {
    case "turn":
      return <TurnBody turn={entry.turn} team={team} snapshot={snapshot} />;
    case "message": {
      const { message } = entry;
      return (
        <div className="team-message" data-type={message.type}>
          {message.type !== "info" ? <span className="team-entry__tag">{message.type}</span> : null}
          {(message.attachments ?? []).length > 0 ? (
            <ul className="message__files" aria-label="Attached files">
              {(message.attachments ?? []).map((file) => (
                <li key={file.path} className="file-chip" title={file.path}>
                  {file.kind === "image" ? (
                    <Image size={13} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  <span className="file-chip__name">{file.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <Collapsible text={withNames(message.content, team)} />
        </div>
      );
    }
    case "task": {
      const { task } = entry;
      const handedBy = task.assignedTo && task.createdBy !== task.assignedTo ? task.createdBy : null;
      return (
        <div className="team-task" data-status={task.status}>
          <div className="team-task__head">
            <TaskIcon task={task} />
            <span className="team-task__title">{task.title}</span>
            <span className="team-entry__tag" data-status={task.status}>
              {taskLabel(task)}
            </span>
          </div>
          {handedBy ? <p className="team-task__from">From {nameOf(handedBy)}</p> : null}
          {task.status === "failed" && task.error ? (
            <p className="team-task__error">{withNames(task.error, team)}</p>
          ) : null}
          {task.status === "completed" && task.result ? (
            <Collapsible text={withNames(task.result, team)} />
          ) : null}
        </div>
      );
    }
    case "artifact": {
      const { artifact } = entry;
      const task = artifact.taskId ? snapshot.tasks.find((item) => item.id === artifact.taskId) : undefined;
      return (
        <ArtifactBody artifact={artifact} taskTitle={task?.title ?? null} team={team} />
      );
    }
    case "decision": {
      const { decision } = entry;
      return (
        <div className="team-decision">
          <p className="team-decision__label">
            <Flag size={12} strokeWidth={1.75} aria-hidden="true" />
            Decision
          </p>
          <p className="team-decision__title">{decision.title}</p>
          <Collapsible text={withNames(decision.decision, team)} />
          {decision.reason.trim() ? (
            <p className="team-decision__reason">{withNames(decision.reason, team)}</p>
          ) : null}
        </div>
      );
    }
  }
}

/** Steps shown while a turn runs; the rest fold away. */
const LIVE_STEPS = 5;

/**
 * A published artifact: code/diff types render as visual lines (added/
 * removed highlighting, file path, counts), everything else keeps the plain
 * markdown view. The "why" comes only from data the agent actually sent
 * (artifact metadata) or the linked task — never invented.
 */
function ArtifactBody({
  artifact,
  taskTitle,
  team,
}: {
  readonly artifact: TeamArtifact;
  readonly taskTitle: string | null;
  readonly team: TeamDefinition;
}): JSX.Element {
  const kind = classifyArtifact(artifact);
  const reason = artifactReason(artifact.metadata);
  const content = artifact.content?.trim() ? artifact.content : null;
  const stats = kind === "diff" && content ? diffStats(content) : null;
  return (
    <div className="team-file" data-artifact-kind={kind}>
      <div className="team-file__head">
        <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="team-file__name" title={artifact.path ?? artifact.name}>
          {artifact.path ?? artifact.name}
        </span>
        <span className="team-entry__tag">{artifact.type}</span>
        {stats && (stats.added > 0 || stats.removed > 0) ? (
          <span className="team-entry__tag" data-status="completed" title={`${stats.added} added, ${stats.removed} removed`}>
            +{stats.added} −{stats.removed}
          </span>
        ) : null}
      </div>
      {artifact.name && artifact.path && artifact.name !== artifact.path ? (
        <p className="team-file__title">{withNames(artifact.name, team)}</p>
      ) : null}
      {taskTitle ? <p className="team-file__task">For “{taskTitle}”</p> : null}
      {reason ? <p className="team-file__reason">{withNames(reason, team)}</p> : null}
      {content ? (
        kind === "diff" ? (
          <ArtifactDiff content={content} />
        ) : kind === "code" ? (
          <ArtifactCode content={content} language={artifactLanguage(artifact)} />
        ) : (
          <details className="team-file__details">
            <summary>Show content</summary>
            <MessageBody content={content} role="assistant" />
          </details>
        )
      ) : null}
    </div>
  );
}

/** Unified diff with added/removed/hunk highlighting; long diffs fold. */
function ArtifactDiff({ content }: { readonly content: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = content.split("\n").slice(0, ARTIFACT_MAX_LINES);
  const truncated = content.split("\n").length > ARTIFACT_MAX_LINES;
  const shown = open ? lines : lines.slice(0, ARTIFACT_PREVIEW_LINES);
  return (
    <div className="diff-preview" data-source="artifact">
      <pre className="diff-preview__pre">
        {shown.map((line, index) => (
          <span key={index} className="diff-preview__line" data-kind={diffLineKind(line)}>
            {line || " "}
          </span>
        ))}
      </pre>
      {lines.length > ARTIFACT_PREVIEW_LINES || truncated ? (
        <button type="button" className="link-button" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : `Show all ${truncated ? "(capped)" : `(${lines.length} lines)`}`}
        </button>
      ) : null}
    </div>
  );
}

/** Code with line numbers; unwraps one outer markdown fence if present. */
function ArtifactCode({ content, language }: { readonly content: string; readonly language: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const code = extractCodeContent(content.trim());
  const lines = code.split("\n");
  const shown = open ? lines.slice(0, ARTIFACT_MAX_LINES) : lines.slice(0, ARTIFACT_PREVIEW_LINES);
  return (
    <div className="codeblock" data-source="artifact">
      <div className="codeblock__head">
        <span className="codeblock__lang">{language || "code"}</span>
        <span className="row__meta">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
      </div>
      <pre className="codeblock__pre">
        {shown.map((line, index) => (
          <span key={index} className="codeblock__line">
            <span className="codeblock__no" aria-hidden="true">
              {index + 1}
            </span>
            <span>{line || " "}</span>
          </span>
        ))}
      </pre>
      {lines.length > ARTIFACT_PREVIEW_LINES ? (
        <div className="codeblock__head">
          <button type="button" className="link-button" onClick={() => setOpen((value) => !value)}>
            {open ? "Show less" : `Show all (${lines.length} lines)`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One turn of one member, as it happened: what it worked on, every step its
 * tool reported, and everything it wrote. While it runs it grows here; the
 * team's own action blocks are left out of the text, since the tasks,
 * messages and decisions they made have entries of their own.
 */
function TurnBody({
  turn,
  team,
  snapshot,
}: {
  readonly turn: TeamTurn;
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot;
}): JSX.Element {
  const going = isGoing(snapshot.run);
  const running = turn.status === "running" && going;
  const now = useNow(running ? 1_000 : 600_000);
  const task = turn.taskId ? snapshot.tasks.find((entry) => entry.id === turn.taskId) : undefined;
  const { text, actions } = useMemo(() => withoutTeamBlocks(turn.output), [turn.output]);
  const status = running
    ? "running"
    : turn.status === "running"
      ? "interrupted"
      : turn.status;
  const what = task ? task.title : turn.agentId === team.leadAgentId ? "Planned the next steps" : "Took a turn";
  const took = durationLabel(turn.startedAt, turn.finishedAt ?? new Date(now));
  const shown = running ? turn.steps.slice(-LIVE_STEPS) : [];
  return (
    <div className="team-turn" data-status={status}>
      <div className="team-turn__head">
        <span className="team-turn__what">{task ? `Worked on “${what}”` : what}</span>
        <span className="team-turn__meta">
          {took}
          {turn.steps.length > 0 ? ` · ${turn.steps.length} step${turn.steps.length === 1 ? "" : "s"}` : ""}
        </span>
        <span className="team-entry__tag" data-status={status}>
          {status === "running"
            ? "Working"
            : status === "completed"
              ? "Done"
              : status === "interrupted"
                ? "Interrupted"
                : "Failed"}
        </span>
      </div>
      {running ? (
        <ol className="team-turn__steps" aria-label="Latest steps">
          {turn.steps.length > shown.length ? (
            <li className="team-turn__earlier">{turn.steps.length - shown.length} earlier</li>
          ) : null}
          {shown.map((step, index) => (
            <li key={`${step.at.getTime()}:${index}`}>{step.detail}</li>
          ))}
        </ol>
      ) : turn.steps.length > 0 ? (
        <details className="team-turn__details">
          <summary>Every step</summary>
          <ol className="team-turn__steps">
            {turn.steps.map((step, index) => (
              <li key={`${step.at.getTime()}:${index}`}>
                <time>{step.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                {step.detail}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {text ? <Collapsible text={withNames(text, team)} /> : running ? null : (
        <p className="team-turn__quiet">It wrote nothing beyond its team actions.</p>
      )}
      {actions > 0 ? (
        <p className="team-turn__actions">
          {actions} team action{actions === 1 ? "" : "s"} — shown as their own entries
        </p>
      ) : null}
      {turn.error ? <p className="team-task__error">{withNames(turn.error, team)}</p> : null}
    </div>
  );
}

/** A member's words without its ```team action blocks, and how many there were. */
function withoutTeamBlocks(output: string): { text: string; actions: number } {
  let actions = 0;
  const text = output
    .replace(/```team[^\n]*\n[\s\S]*?(?:```|$)/g, () => {
      actions += 1;
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, actions };
}

/** How the run ended, in its own words, once it has. */
function RunEnding({ run, team }: { readonly run: TeamRun; readonly team: TeamDefinition }): JSX.Element | null {
  if (isGoing(run) || run.status === "paused") {
    return null;
  }
  const reason = run.stopReason ? stopReasonLabel(run.stopReason) : runLabel(run);
  return (
    <div className="team-ending" data-status={run.status}>
      <p className="team-ending__label">{run.status === "completed" ? "Finished" : reason}</p>
      {run.outcome ? (
        <Collapsible text={withNames(run.outcome, team)} />
      ) : (
        <p className="team-ending__reason">{run.status === "completed" ? reason : "The run ended here."}</p>
      )}
    </div>
  );
}

/** Long text folds after a few lines, so one answer does not bury the rest. */
function Collapsible({ text }: { readonly text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.length > 900;
  return (
    <div className="team-entry__body" data-folded={long && !open}>
      <MessageBody content={long && !open ? `${text.slice(0, 900)}…` : text} role="assistant" />
      {long ? (
        <button type="button" className="link-button" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One member's story, or the whole team's: messages it sent or received,
 * tasks it worked on or handed out, what it published and decided — each at
 * the moment it happened.
 */
function feedFor(snapshot: TeamRunSnapshot, member: string): FeedEntry[] {
  const everyone = member === EVERYONE;
  const mine = (id: string | null): boolean => everyone || id === member;
  const entries: FeedEntry[] = [];
  for (const message of snapshot.messages) {
    if (everyone || message.from === member || message.to === member) {
      entries.push({ kind: "message", id: `m:${message.id}`, at: message.timestamp, author: message.from, message });
    }
  }
  for (const task of snapshot.tasks) {
    if (mine(task.assignedTo) || (!everyone && task.createdBy === member && !task.assignedTo)) {
      // A task shows where it stands, at the moment it last moved, as the
      // work of whoever holds it.
      entries.push({
        kind: "task",
        id: `t:${task.id}`,
        at: task.completedAt ?? task.startedAt ?? task.createdAt,
        author: task.assignedTo ?? task.createdBy,
        task,
      });
    }
  }
  for (const artifact of snapshot.artifacts) {
    if (mine(artifact.createdBy)) {
      entries.push({ kind: "artifact", id: `a:${artifact.id}`, at: artifact.timestamp, author: artifact.createdBy, artifact });
    }
  }
  for (const decision of snapshot.decisions) {
    if (mine(decision.author)) {
      entries.push({ kind: "decision", id: `d:${decision.id}`, at: decision.timestamp, author: decision.author, decision });
    }
  }
  for (const turn of snapshot.turns) {
    if (mine(turn.agentId)) {
      entries.push({ kind: "turn", id: `u:${turn.id}`, at: turn.startedAt, author: turn.agentId, turn });
    }
  }
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Whether the team takes files, by capability rather than provider name: one
 * member whose provider supports attachments is enough, since each adapter
 * applies its own profile flags to the files it receives.
 */
function teamAttachSupport(
  team: TeamDefinition,
  providers: readonly ProviderSummary[],
): { supported: boolean; reason?: string } {
  if (team.agents.length === 0) {
    return { supported: false, reason: "Add a member to the team to attach files" };
  }
  const byId = new Map(providers.map((entry) => [entry.metadata.id, entry]));
  const capable = team.agents.some((agent) =>
    byId.get(agent.providerId)?.capabilities.supported.includes("attachments"),
  );
  return capable
    ? { supported: true }
    : { supported: false, reason: "No member's provider takes files" };
}
