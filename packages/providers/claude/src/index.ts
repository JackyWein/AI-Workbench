import { join } from "node:path";
import {
  cliProviderFactory,
  findSkills,
  parseProfile,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import { claudeCodeProfile } from "./profile.js";
import { configHomeOf, statusLineTelemetry } from "./telemetry.js";
import { readUsage } from "./usage.js";

export { claudeCodeProfile } from "./profile.js";

/** Claude Code's profile, parsed. */
export const claudeCode = parseProfile(claudeCodeProfile);
export * from "./telemetry.js";
export * from "./attention.js";
export * from "./usage.js";
export { parseResetTime } from "./reset-time.js";

/** What Claude Code needs beyond its profile data. */
export const claudeCodeExtensions: CliProviderExtensions = {
  interactiveTelemetry: statusLineTelemetry,
  // Token totals from the tool's own local transcripts, so usage is known
  // before the first turn in the application; current rate limits still only
  // arrive while the tool works.
  readUsage,
  // Claude Code's own skill folders: the user's, and the project's.
  discoverImportables: async (context, request) => ({
    skills: await findSkills([
      { path: join(configHomeOf(context), "skills"), source: "your Claude Code skills" },
      ...(request.workspacePath
        ? [{ path: join(request.workspacePath, ".claude", "skills"), source: "this project's Claude Code skills" }]
        : []),
    ]),
    mcpServers: [],
  }),
};


/** Claude Code's entries: the default account and any further ones. */
export function claudeCodeFactory(): ProviderFactory {
  return cliProviderFactory(claudeCode, claudeCodeExtensions);
}
