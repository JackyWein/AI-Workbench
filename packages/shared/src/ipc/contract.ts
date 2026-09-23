import { z } from "zod";
import {
  createWorkspaceInputSchema,
  updateWorkspaceInputSchema,
  workspaceSchema,
} from "../domain/workspace.js";
import {
  createSshConnectionInputSchema,
  sshConnectionSchema,
  sshConnectionTestSchema,
  updateSshConnectionInputSchema,
} from "../domain/connection.js";
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
  agentTerminalSchema,
  launchAgentTerminalInputSchema,
  updateAgentTerminalInputSchema,
} from "../domain/agent-terminal.js";
import {
  addProviderAccountInputSchema,
  detectedProviderAccountSchema,
  providerAccountSchema,
} from "../domain/account.js";
import {
  appSettingsSchema,
  updateSettingsInputSchema,
} from "../domain/settings.js";
import {
  directoryEntrySchema,
  fileContentsSchema,
  gitStatusSchema,
  terminalInfoSchema,
} from "../domain/workspace-tools.js";
import {
  effectiveSkillSchema,
  skillAssignmentInputSchema,
  skillManifestSchema,
  skillScopesSchema,
} from "../domain/skill.js";
import {
  pluginAccountSchema,
  pluginAssignmentInputSchema,
  pluginManifestSchema,
  pluginScopesSchema,
  resolvedPluginSchema,
} from "../domain/plugin.js";
import {
  mcpServerConfigSchema,
  mcpServerStatusSchema,
} from "../domain/mcp.js";
import {
  islandPreferencesSchema,
  islandStateSchema,
  islandTargetSchema,
  islandWidgetIdSchema,
} from "../domain/status-island.js";
import {
  createTeamInputSchema,
  teamDefinitionSchema,
  teamRunSchema,
  teamRunSnapshotSchema,
} from "../domain/team.js";
import { updateStateSchema } from "../domain/updater.js";

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
      /** OS account name for the sidebar card; "local" when unreadable. */
      username: z.string(),
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
  /** Asks the tool again which models it offers, bypassing the cache. */
  "provider.rescanModels": {
    input: z.object({ providerId: z.string().min(1) }),
    output: providerSummarySchema,
  },
  "provider.getUsage": { input: z.void(), output: aggregatedUsageSchema },
  "provider.refreshUsage": {
    input: z.void(),
    output: aggregatedUsageSchema,
  },

  "account.list": { input: z.void(), output: z.array(providerAccountSchema) },
  /** Configuration homes on this machine that are not connected yet. */
  "account.detect": { input: z.void(), output: z.array(detectedProviderAccountSchema) },
  "account.add": { input: addProviderAccountInputSchema, output: providerAccountSchema },
  "account.remove": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },

  "connection.list": { input: z.void(), output: z.array(sshConnectionSchema) },
  "connection.create": {
    input: createSshConnectionInputSchema,
    output: sshConnectionSchema,
  },
  "connection.update": {
    input: updateSshConnectionInputSchema,
    output: sshConnectionSchema,
  },
  "connection.delete": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
  },
  "connection.test": {
    input: z.object({ id: z.string().min(1) }),
    output: sshConnectionTestSchema,
  },
  /** Lists a directory on a connection, so a remote root can be picked. */
  "connection.browse": {
    input: z.object({
      id: z.string().min(1),
      path: z.string().max(4096).default(""),
    }),
    output: z.object({
      path: z.string(),
      entries: z.array(directoryEntrySchema),
    }),
  },

  "files.list": {
    input: z.object({
      sessionId: z.string().min(1),
      path: z.string().max(4096).default(""),
    }),
    output: z.array(directoryEntrySchema),
  },
  "files.read": {
    input: z.object({
      sessionId: z.string().min(1),
      path: z.string().min(1).max(4096),
    }),
    output: fileContentsSchema,
  },
  "files.write": {
    input: z.object({
      sessionId: z.string().min(1),
      path: z.string().min(1).max(4096),
      content: z.string().max(512 * 1024),
    }),
    output: directoryEntrySchema,
  },

  "git.status": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: gitStatusSchema,
  },
  "git.diff": {
    input: z.object({
      sessionId: z.string().min(1),
      path: z.string().min(1).max(4096),
      staged: z.boolean().default(false),
    }),
    output: z.object({ path: z.string(), diff: z.string().max(200 * 1024) }),
  },

  "terminal.list": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.array(terminalInfoSchema),
  },
  "terminal.create": {
    input: z.object({
      sessionId: z.string().min(1),
      cols: z.number().int().positive().max(1000).optional(),
      rows: z.number().int().positive().max(1000).optional(),
    }),
    output: terminalInfoSchema,
  },
  /** Reuses the session's terminal and returns what it printed so far. */
  "terminal.attach": {
    input: z.object({
      sessionId: z.string().min(1),
      cols: z.number().int().positive().max(1000).optional(),
      rows: z.number().int().positive().max(1000).optional(),
    }),
    output: z.object({
      info: terminalInfoSchema,
      scrollback: z.string(),
    }),
  },
  "terminal.write": {
    input: z.object({
      terminalId: z.string().min(1),
      data: z.string().max(100_000),
    }),
    output: z.object({ written: z.boolean() }),
  },
  "terminal.resize": {
    input: z.object({
      terminalId: z.string().min(1),
      cols: z.number().int().positive().max(1000),
      rows: z.number().int().positive().max(1000),
    }),
    output: z.object({ resized: z.boolean() }),
  },
  "terminal.close": {
    input: z.object({ terminalId: z.string().min(1) }),
    output: z.object({ closed: z.boolean() }),
  },

  /** Rejoins a running terminal by id and returns what it printed so far. */
  "terminal.reattach": {
    input: z.object({ terminalId: z.string().min(1) }),
    output: z.object({ exists: z.boolean(), scrollback: z.string() }),
  },

  "agentTerminal.list": {
    input: z.object({ workspaceId: z.string().min(1) }),
    output: z.array(agentTerminalSchema),
  },
  "agentTerminal.launch": { input: launchAgentTerminalInputSchema, output: agentTerminalSchema },
  "agentTerminal.start": {
    input: z.object({
      id: z.string().min(1),
      cols: z.number().int().positive().max(1000).optional(),
      rows: z.number().int().positive().max(1000).optional(),
    }),
    output: agentTerminalSchema,
  },
  "agentTerminal.stop": {
    input: z.object({ id: z.string().min(1) }),
    output: agentTerminalSchema,
  },
  "agentTerminal.remove": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  "agentTerminal.update": { input: updateAgentTerminalInputSchema, output: agentTerminalSchema },
  /** Opens a provider's own sign-in for one of its accounts in a terminal. */
  "agentTerminal.login": {
    input: z.object({
      workspaceId: z.string().min(1),
      providerId: z.string().min(1),
      cols: z.number().int().positive().max(1000).optional(),
      rows: z.number().int().positive().max(1000).optional(),
    }),
    output: agentTerminalSchema,
  },

  "skill.list": { input: z.void(), output: z.array(skillManifestSchema) },
  "skill.save": { input: skillManifestSchema, output: skillManifestSchema },
  "skill.delete": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
  },
  /** Imports skill files the user picks from a directory. */
  "skill.importFromDirectory": {
    input: z.void(),
    output: z.object({
      cancelled: z.boolean(),
      imported: z.array(skillManifestSchema),
      failed: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
  },
  "skill.assign": {
    input: skillAssignmentInputSchema,
    output: z.object({ assigned: z.boolean() }),
  },
  "skill.assignments": {
    input: z.object({
      workspaceId: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
    }),
    output: skillScopesSchema,
  },
  /** What a session actually composes into its system instructions. */
  "skill.effectiveForSession": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.array(effectiveSkillSchema),
  },

  "plugin.list": { input: z.void(), output: z.array(pluginManifestSchema) },
  "plugin.save": { input: pluginManifestSchema, output: pluginManifestSchema },
  "plugin.assign": {
    input: pluginAssignmentInputSchema,
    output: z.object({ assigned: z.boolean() }),
  },
  "plugin.assignments": {
    input: z.object({
      workspaceId: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
    }),
    output: pluginScopesSchema,
  },
  "plugin.resolveForSession": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.array(resolvedPluginSchema),
  },
  "plugin.accounts": { input: z.void(), output: z.array(pluginAccountSchema) },
  /**
   * The secret travels renderer to main once and is encrypted before it is
   * stored; nothing ever sends it back the other way (spec §90).
   */
  "plugin.connectAccount": {
    input: z.object({
      accountType: z.string().min(1),
      label: z.string().min(1).max(200),
      secret: z.string().min(1).max(10_000),
    }),
    output: pluginAccountSchema,
  },
  "plugin.disconnectAccount": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ disconnected: z.boolean() }),
  },

  "mcp.list": { input: z.void(), output: z.array(mcpServerConfigSchema) },
  "mcp.save": { input: mcpServerConfigSchema, output: mcpServerConfigSchema },
  "mcp.delete": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
  },
  "mcp.statuses": { input: z.void(), output: z.array(mcpServerStatusSchema) },
  "mcp.connect": {
    input: z.object({ id: z.string().min(1) }),
    output: mcpServerStatusSchema.nullable(),
  },
  "mcp.disconnect": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ disconnected: z.boolean() }),
  },
  "mcp.sessionAccess": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({ serverIds: z.array(z.string()) }),
  },
  "mcp.setSessionAccess": {
    input: z.object({
      sessionId: z.string().min(1),
      serverId: z.string().min(1),
      enabled: z.boolean(),
    }),
    output: z.object({ updated: z.boolean() }),
  },

  "team.list": {
    input: z.object({ workspaceId: z.string().min(1).optional() }),
    output: z.array(teamDefinitionSchema),
  },
  "team.create": { input: createTeamInputSchema, output: teamDefinitionSchema },
  "team.setLead": {
    input: z.object({
      teamId: z.string().min(1),
      agentId: z.string().min(1).nullable(),
    }),
    output: teamDefinitionSchema,
  },
  "team.delete": {
    input: z.object({ teamId: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
  },

  "team.listRuns": {
    input: z.object({ teamId: z.string().min(1).optional() }),
    output: z.array(teamRunSchema),
  },
  /** The whole run: graph, mail, decisions and artifacts (spec §53). */
  "team.getRun": {
    input: z.object({ runId: z.string().min(1) }),
    output: teamRunSnapshotSchema,
  },
  "team.startRun": {
    input: z.object({
      teamId: z.string().min(1),
      goal: z.string().min(1).max(20_000),
    }),
    output: teamRunSchema,
  },
  "team.resumeRun": {
    input: z.object({ runId: z.string().min(1) }),
    output: teamRunSchema,
  },
  "team.pauseRun": {
    input: z.object({ runId: z.string().min(1) }),
    output: teamRunSchema,
  },
  "team.cancelRun": {
    input: z.object({ runId: z.string().min(1) }),
    output: teamRunSchema,
  },

  "statusIsland.getState": { input: z.void(), output: islandStateSchema },
  "statusIsland.setPreferences": {
    input: islandPreferencesSchema.partial(),
    output: islandStateSchema,
  },
  "statusIsland.show": { input: z.void(), output: z.object({ visible: z.boolean() }) },
  "statusIsland.hide": { input: z.void(), output: z.object({ visible: z.boolean() }) },
  "statusIsland.pinWidget": {
    input: z.object({ widget: islandWidgetIdSchema.nullable() }),
    output: islandStateSchema,
  },
  "statusIsland.cycle": {
    input: z.object({ direction: z.union([z.literal(1), z.literal(-1)]).default(1) }),
    output: islandStateSchema,
  },
  /** Brings the main window forward at the place an island entry is about. */
  "statusIsland.open": {
    input: islandTargetSchema,
    output: z.object({ opened: z.boolean() }),
  },
  "statusIsland.dismiss": { input: z.void(), output: islandStateSchema },
  /**
   * Types a prompt into an agent the island lists, by its row key. Only a
   * running agent terminal can take one mid-work; the reason says why not.
   */
  "statusIsland.ask": {
    input: z.object({ key: z.string().min(1).max(200), text: z.string().trim().min(1).max(4000) }),
    output: z.object({ sent: z.boolean(), to: z.string().nullable(), reason: z.string().nullable() }),
  },
  /**
   * Answers what an agent on the island waits on, in place, by the entry's
   * key and one of its options (Allow/Deny, or a question's choice). The
   * agent's tool decides whether it takes the answer; the reason says why not.
   */
  "statusIsland.respond": {
    input: z.object({ key: z.string().min(1).max(300), option: z.string().min(1).max(200) }),
    output: z.object({ answered: z.boolean(), reason: z.string().nullable() }),
  },
  /** Returns the island to its default corner and forgets a dragged spot. */
  "statusIsland.resetPosition": { input: z.void(), output: islandStateSchema },
  /**
   * The island page grabbed its unit: main moves the window with the pointer
   * from here on, sliding a docked pill along its rails or carrying a free
   * blob, until the page lets go. Grab is where the unit was pressed, in page
   * pixels.
   */
  "statusIsland.dragStart": {
    input: z.object({
      grabX: z.number().finite().min(0).max(2000),
      grabY: z.number().finite().min(0).max(2000),
    }),
    output: z.object({ dragging: z.boolean() }),
  },
  /** The pointer let go: the island settles on a rail or where it was put. */
  "statusIsland.dragEnd": { input: z.void(), output: z.object({ dragging: z.boolean() }) },
  /** Lets the island page report the size its current face needs. */
  "statusIsland.resize": {
    input: z.object({
      width: z.number().int().min(42).max(480),
      height: z.number().int().min(42).max(640),
    }),
    output: z.object({ visible: z.boolean() }),
  },

  "settings.get": { input: z.void(), output: appSettingsSchema },
  "settings.update": {
    input: updateSettingsInputSchema,
    output: appSettingsSchema,
  },

  /**
   * Updates over GitHub Releases. Checking only asks which version is
   * current; downloading and installing each wait for their own explicit user
   * action, so there is no silent fetch and no silent install.
   */
  "update.check": {
    input: z.void(),
    output: z.object({ started: z.boolean() }),
  },
  "update.download": {
    input: z.void(),
    output: z.object({ started: z.boolean() }),
  },
  "update.install": {
    input: z.void(),
    output: z.object({ installing: z.boolean() }),
  },
  "update.getStatus": { input: z.void(), output: updateStateSchema },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;

/**
 * What a caller may send: schemas with `.default()` accept the field as
 * optional on the wire, and the main process applies the default when it
 * parses the payload before any service is touched.
 */
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]["input"]>;
/**
 * What a handler receives after parsing: defaults applied, so fields with
 * `.default()` are present. This is what `z.infer` describes.
 */
export type IpcHandlerInput<C extends IpcChannel> = z.output<
  IpcContract[C]["input"]
>;
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContract[C]["output"]>;

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

export function isIpcChannel(value: string): value is IpcChannel {
  return Object.prototype.hasOwnProperty.call(ipcContract, value);
}

/** Single push channel from main to renderer, carrying AppEvent payloads. */
export const APP_EVENT_CHANNEL = "workbench:event" as const;

/** Island state, pushed to the island window only. */
export const ISLAND_STATE_CHANNEL = "workbench:island" as const;

/** Live drag state (the rail under the pointer), pushed to the island only. */
export const ISLAND_DRAG_CHANNEL = "workbench:island-drag" as const;

/** Where the island asked the main window to go (spec §98). */
export const ISLAND_NAVIGATE_CHANNEL = "workbench:navigate" as const;

/** Shape of an error crossing the IPC boundary. */
export const ipcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;
