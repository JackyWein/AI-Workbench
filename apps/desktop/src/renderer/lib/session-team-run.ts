import type { Session, TeamRun } from "@ai-workbench/shared";

type SessionLike = Pick<Session, "id" | "workspaceId" | "uiState" | "createdAt">;

/**
 * The run of a team a session shows and continues — only ever its own.
 *
 * A run carries its members' whole history: tasks, messages, decisions and
 * the provider sessions they resume. Handing one session's run to another
 * would give the new session all of that context, and in another workspace
 * the old run's folder too. So a session gets:
 *
 * - the run it already shows, when that run is its own;
 * - otherwise its newest own run of the team (a session that switched to
 *   another team and back), the live one first;
 * - otherwise nothing, and the team starts fresh with the next goal.
 *
 * Runs from before runs knew their session belong to the first session that
 * showed them, and only in their own workspace.
 */
export function ownRunOf(
  session: SessionLike,
  teamId: string,
  runs: readonly TeamRun[],
  sessions: readonly SessionLike[],
): TeamRun | null {
  const ofTeam = runs.filter((run) => run.teamId === teamId);
  const shownId = session.uiState["teamId"] === teamId ? session.uiState["teamRunId"] : null;
  const shown = typeof shownId === "string" ? ofTeam.find((run) => run.id === shownId) : undefined;
  if (shown && belongsTo(shown, session, sessions)) {
    return shown;
  }
  const mine = ofTeam.filter((run) => run.sessionId === session.id);
  return mine.find((run) => run.status === "running" || run.status === "paused") ?? mine[0] ?? null;
}

function belongsTo(run: TeamRun, session: SessionLike, sessions: readonly SessionLike[]): boolean {
  if (run.sessionId !== null) {
    return run.sessionId === session.id;
  }
  if (run.workspaceId !== session.workspaceId) {
    return false;
  }
  const first = sessions
    .filter((entry) => entry.uiState["teamRunId"] === run.id)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
  return !first || first.id === session.id;
}
