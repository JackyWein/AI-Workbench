import type { SessionManager } from "./session-manager.js";
import type { TeamManager } from "./team-manager.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export interface WorkspaceRemovalServices {
  readonly workspaces: Pick<WorkspaceManager, "get" | "delete">;
  readonly sessions: Pick<SessionManager, "list" | "delete">;
  readonly teams?: Pick<TeamManager, "cancelRunsIn">;
}

/**
 * Removes a workspace and stops everything working in it.
 *
 * The database drops a workspace's sessions and runs on its own, but not what
 * they were doing: a turn still streaming would keep an agent editing a folder
 * the person just removed, and the session's shells, provider session and
 * attached files would stay behind. So every team run in the workspace is
 * stopped and every session is deleted the way the person would delete it —
 * turn cancelled, provider session ended, files removed — before the
 * workspace itself goes. One session that cannot be cleaned up does not keep
 * the workspace; the database still removes its rows.
 */
export async function removeWorkspace(
  services: WorkspaceRemovalServices,
  workspaceId: string,
): Promise<boolean> {
  if (!(await services.workspaces.get(workspaceId))) {
    return false;
  }
  await services.teams?.cancelRunsIn(workspaceId).catch(() => undefined);
  for (const session of await services.sessions.list(workspaceId)) {
    await services.sessions.delete(session.id).catch(() => undefined);
  }
  return services.workspaces.delete(workspaceId);
}
