import { scheduleContentSchema, type ScheduleContent } from "@ai-workbench/shared";
import { askOnce, type OneTurnRequest } from "./one-turn.js";
import type { ProviderManager } from "./provider-manager.js";
import { nextScheduleRun } from "./scheduler-service.js";

export async function draftSchedule(providers: ProviderManager, request: Omit<OneTurnRequest, "prompt"> & { request: string; workspaceId: string; timezone: string }, scratch: string): Promise<ScheduleContent> {
  const answer = await askOnce(providers, { ...request, prompt: `Draft one scheduled task from this request. Return only JSON with name, prompt, cron (five fields), timezone. Do not run the task. Timezone: ${request.timezone}.\nRequest: ${request.request}` }, scratch);
  if (answer.failure) throw new Error(answer.failure);
  const start = answer.text.indexOf("{"); const end = answer.text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return a schedule as JSON.");
  const parsed = JSON.parse(answer.text.slice(start, end + 1)) as Record<string, unknown>;
  const schedule = scheduleContentSchema.parse({ ...parsed, workspaceId: request.workspaceId, target: { kind: "solo", providerId: request.providerId, modelId: request.modelId, reasoningEffort: request.reasoningEffort }, permissionMode: "readOnly", budget: { maxTurns: 1, maxTokens: null, maxRuntimeSeconds: 600 }, enabled: true, catchUp: "skip" });
  nextScheduleRun(schedule.cron, schedule.timezone, new Date());
  return schedule;
}
