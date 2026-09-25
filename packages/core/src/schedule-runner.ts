import type { Schedule, MessageUsage } from "@ai-workbench/shared";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { TeamManager } from "./team-manager.js";
import type { ScheduleExecution, SchedulerOptions } from "./scheduler-service.js";

function reportedTokens(usage: Pick<MessageUsage, "inputTokens" | "outputTokens"> | null): number | null {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Scheduled solo work is one turn; teams use the orchestrator's own turn bound. */
export function scheduleExecutor(sessions: SessionManager, teams: TeamManager, events: EventBus): SchedulerOptions["execute"] {
  return async (schedule: Schedule, signal, attach): Promise<ScheduleExecution> => {
    const target = schedule.target;
    const session = await sessions.create({
      workspaceId: schedule.workspaceId,
      name: `${schedule.name} — ${new Date().toLocaleDateString()}`.slice(0, 200),
      type: target.kind === "team" ? "team" : "solo",
      ...(target.kind === "solo" ? { providerId: target.providerId, ...(target.modelId ? { modelId: target.modelId } : {}) } : {}),
      settings: { permissionMode: schedule.permissionMode, ...(target.kind === "solo" && target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}), scheduled: true },
    });
    let tokens: number | null = null;
    let budget = false;
    let teamRunId: string | null = null;
    const stop = (): void => {
      budget = true;
      if (teamRunId) void teams.cancelRun(teamRunId).catch(() => undefined);
      else void sessions.cancel(session.id).catch(() => undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
    // The provider's usage event arrives before persistence, so a reported
    // ceiling can stop streaming immediately. Missing usage remains null.
    const unsubscribe = events.on("provider.event", (event) => {
      if (event.type !== "provider.event" || event.sessionId !== session.id || event.event.type !== "usage") return;
      const current = reportedTokens(event.event.usage);
      if (current !== null) tokens = Math.max(tokens ?? 0, current);
      if (schedule.budget.maxTokens !== null && tokens !== null && tokens >= schedule.budget.maxTokens) stop();
    });
    try {
      await attach({ sessionId: session.id });
      if (signal.aborted) return { status: "interrupted", sessionId: session.id, teamRunId, turns: 0, tokens, error: String(signal.reason) };
      if (target.kind === "team") {
        const run = await teams.startRun({ teamId: target.teamId, goal: schedule.prompt, workspaceId: schedule.workspaceId, sessionId: session.id, limits: { maxAgentCalls: schedule.budget.maxTurns, maxConcurrentAgents: 1, maxRuntimeMinutes: Math.max(1, Math.ceil(schedule.budget.maxRuntimeSeconds / 60)) }, permissionMode: schedule.permissionMode });
        teamRunId = run.id;
        await sessions.update({ id: session.id, uiState: { teamId: target.teamId, teamRunId } });
        await attach({ sessionId: session.id, teamRunId });
        if (signal.aborted) stop();
        for (;;) {
          const snapshot = await teams.getSnapshot(teamRunId);
          if (!["pending", "running"].includes(snapshot.run.status)) {
            return { status: budget || snapshot.run.stopReason === "limitReached" ? "budget" : snapshot.run.status === "completed" ? "completed" : "failed", sessionId: session.id, teamRunId, turns: snapshot.run.agentCalls, tokens: null, error: budget ? String(signal.reason ?? "Budget reached") : snapshot.run.stopReason === "goalFinished" ? null : snapshot.run.stopReason };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await sessions.sendMessage(session.id, schedule.prompt);
      if (signal.aborted) stop();
      while (sessions.isBusy(session.id)) await new Promise((resolve) => setTimeout(resolve, 100));
      const answer = (await sessions.listMessages(session.id)).filter((entry) => entry.role === "assistant").at(-1);
      tokens = reportedTokens(answer?.usage ?? null) ?? tokens;
      if (schedule.budget.maxTokens !== null && tokens !== null && tokens >= schedule.budget.maxTokens) budget = true;
      return { status: budget ? "budget" : answer?.status === "complete" ? "completed" : "failed", sessionId: session.id, teamRunId, turns: 1, tokens, error: budget ? String(signal.reason ?? "Reported token budget reached") : answer?.error ?? null };
    } finally { unsubscribe(); signal.removeEventListener("abort", stop); }
  };
}
