import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, TeamDefinition, TeamTask } from "@ai-workbench/shared";
import { TeamRuleError, type TeamService } from "@ai-workbench/team";

/** Git operations scoped to the application's isolated worktrees. */
export interface TeamWorktreeGit {
  status(folder: string): Promise<{ isRepository: boolean; clean: boolean }>;
  ensureWorktree(folder: string, target: string, branch: string): Promise<void>;
  checkpointWorktree(folder: string, message: string): Promise<string>;
  mergeWorktree(folder: string, branch: string): Promise<{ conflicts: string[] }>;
}

/** Each run is kept on disk, so pausing/restarting preserves every member's files. */
export async function prepareTeamWorktrees(
  git: TeamWorktreeGit,
  directory: string,
  source: string,
  team: TeamDefinition,
  runId: string,
  firstRun: boolean,
): Promise<TeamDefinition> {
  if (firstRun) {
    const status = await git.status(source);
    if (!status.isRepository || !status.clean) {
      throw new Error("Separate worktrees need a clean Git repository with an initial commit. Commit or stash your changes first.");
    }
  }
  if (![runId, ...team.agents.map((agent) => agent.id)].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Invalid worktree identifier.");
  }
  const root = join(directory, runId);
  await mkdir(root, { recursive: true });
  const agents: AgentDefinition[] = [];
  for (const agent of team.agents) {
    const folder = join(root, agent.id);
    await git.ensureWorktree(source, folder, worktreeBranch(runId, agent.id));
    agents.push({ ...agent, workingDirectory: folder });
  }
  return { ...team, agents };
}

export function worktreeBranch(runId: string, agentId: string): string {
  return `workbench/${runId}/${agentId}`;
}

/** Integration happens while the lead is idle, before its next turn sees the files. */
export function teamWorktreeLifecycle(git: TeamWorktreeGit, service: TeamService): {
  beforeTurn(agent: AgentDefinition): Promise<void>;
  afterTurn(agent: AgentDefinition, task: TeamTask | null): Promise<void>;
  beforeFinish(): Promise<void>;
} {
  const leadId = service.team.leadAgentId ?? service.team.agents[0]?.id;
  const lead = service.team.agents.find((agent) => agent.id === leadId);
  if (!lead) throw new Error("Separate worktrees need a lead.");
  const integrationTasks = (): TeamTask[] => service.snapshot().tasks.filter((task) => task.description.startsWith("WORKBENCH_MERGE_CONFLICT\n"));
  const unresolved = (): boolean => integrationTasks().some((task) => task.status !== "completed" && task.status !== "cancelled");
  const integrate = async (): Promise<void> => {
    if (unresolved()) return;
    await git.checkpointWorktree(lead.workingDirectory, `Lead checkpoint for ${service.run.id}`);
    for (const agent of service.team.agents) {
      if (agent.id === lead.id) continue;
      const done = service.snapshot().tasks.some((task) => task.assignedTo === agent.id && task.status === "completed");
      if (!done) continue;
      const branch = worktreeBranch(service.run.id, agent.id);
      const result = await git.mergeWorktree(lead.workingDirectory, branch);
      if (result.conflicts.length > 0) {
        await service.createTask({
          title: `Resolve merge from ${agent.displayName}`,
          description: `WORKBENCH_MERGE_CONFLICT\nMerge of ${branch} into your worktree is paused with conflicts in: ${result.conflicts.join(", ")}. Resolve the files in ${lead.workingDirectory}, then complete this task. The application will record the resolved merge. Do not discard either member's work.`,
          createdBy: "orchestrator",
          assignedTo: lead.id,
          priority: 100,
        });
        service.emitAttentionRequired(`Merge conflict: ${result.conflicts.join(", ")}`);
        return;
      }
    }
  };
  return {
    async beforeTurn(agent) {
      if (agent.id === lead.id) await integrate();
    },
    async afterTurn(agent, task) {
      // Failed/unfinished work stays in its member's folder and is not integrated.
      if (task && service.getTask(task.id)?.status === "completed") {
        await git.checkpointWorktree(agent.workingDirectory, `Completed: ${task.title}`);
      }
    },
    async beforeFinish() {
      if (service.view().inFlight.length > 0) throw new TeamRuleError("Wait for members' tasks to finish before integrating the goal.");
      await integrate();
      if (unresolved()) throw new TeamRuleError("Resolve the merge conflict task before finishing the goal.");
      await service.publishArtifact({
        name: "Integrated run branch", type: "note", createdBy: lead.id,
        path: lead.workingDirectory,
        content: `Finished work is on branch ${worktreeBranch(service.run.id, lead.id)} in ${lead.workingDirectory}. Review it there, then merge that branch into your project when ready.`,
        metadata: { source: "worktrees", branch: worktreeBranch(service.run.id, lead.id) },
      });
    },
  };
}
