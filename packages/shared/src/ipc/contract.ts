import { z } from "zod";
import {
  createWorkspaceInputSchema,
  updateWorkspaceInputSchema,
  workspaceSchema,
} from "../domain/workspace.js";
import {
  createSessionInputSchema,
  sessionSchema,
  updateSessionInputSchema,
} from "../domain/session.js";
import { chatMessageSchema } from "../domain/message.js";
import {
  providerSummarySchema,
  saveProviderConfigInputSchema,
  storedProviderConfigSchema,
} from "../domain/provider.js";
import { aggregatedUsageSchema } from "../domain/usage.js";
import {
  appSettingsSchema,
  updateSettingsInputSchema,
} from "../domain/settings.js";

/**
 * The single source of truth for privileged main-process operations (spec §105).
 * Every channel declares an input and an output schema; the main process
 * validates input before touching a service, and there is deliberately no
 * generic "run this code" channel (spec §5).
 */
export const ipcContract = {
  "app.getInfo": {
    input: z.void(),
    output: z.object({
      version: z.string(),
      platform: z.string(),
      userDataPath: z.string(),
    }),
  },

  "workspace.list": { input: z.void(), output: z.array(workspaceSchema) },
  "workspace.create": {
    input: createWorkspaceInputSchema,
    output: workspaceSchema,
  },
  "workspace.update": {
    input: updateWorkspaceInputSchema,
    output: workspaceSchema,
  },
  "workspace.delete": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
  },
  "workspace.chooseDirectory": {
    input: z.void(),
    output: z.object({ path: z.string().nullable() }),
  },

  "session.list": {
    input: z.object({ workspaceId: z.string().min(1).optional() }),
    output: z.array(sessionSchema),
  },
  "session.create": { input: createSessionInputSchema, output: sessionSchema },
  "session.update": { input: updateSessionInputSchema, output: sessionSchema },
  "session.delete": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
  },
  "session.sendMessage": {
    input: z.object({
      sessionId: z.string().min(1),
      text: z.string().min(1).max(100_000),
    }),
    output: z.object({ messageId: z.string() }),
  },
  "session.cancel": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({ cancelled: z.boolean() }),
  },
  "session.getStatus": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({ busy: z.boolean() }),
  },

  "message.list": {
    input: z.object({
      sessionId: z.string().min(1),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    output: z.array(chatMessageSchema),
  },

  "provider.list": { input: z.void(), output: z.array(providerSummarySchema) },
  "provider.refresh": { input: z.void(), output: z.array(providerSummarySchema) },
  "provider.getConfigs": {
    input: z.void(),
    output: z.array(storedProviderConfigSchema),
  },
  "provider.saveConfig": {
    input: saveProviderConfigInputSchema,
    output: z.object({
      config: storedProviderConfigSchema,
      summary: providerSummarySchema,
    }),
  },
  "provider.getUsage": { input: z.void(), output: aggregatedUsageSchema },
  "provider.refreshUsage": {
    input: z.void(),
    output: aggregatedUsageSchema,
  },

  "settings.get": { input: z.void(), output: appSettingsSchema },
  "settings.update": {
    input: updateSettingsInputSchema,
    output: appSettingsSchema,
  },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;

export type IpcInput<C extends IpcChannel> = z.infer<IpcContract[C]["input"]>;
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContract[C]["output"]>;

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

export function isIpcChannel(value: string): value is IpcChannel {
  return Object.prototype.hasOwnProperty.call(ipcContract, value);
}

/** Single push channel from main to renderer, carrying AppEvent payloads. */
export const APP_EVENT_CHANNEL = "workbench:event" as const;

/** Shape of an error crossing the IPC boundary. */
export const ipcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;
