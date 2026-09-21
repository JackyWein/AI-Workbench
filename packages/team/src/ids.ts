import { randomUUID } from "node:crypto";

/** Prefixed ids, so a value is recognizable wherever it turns up in a log. */
export const newTeamId = (): string => `team_${randomUUID()}`;
export const newAgentId = (): string => `agent_${randomUUID()}`;
export const newRunId = (): string => `run_${randomUUID()}`;
export const newTaskId = (): string => `task_${randomUUID()}`;
export const newMessageId = (): string => `msg_${randomUUID()}`;
export const newDecisionId = (): string => `dec_${randomUUID()}`;
export const newArtifactId = (): string => `art_${randomUUID()}`;
