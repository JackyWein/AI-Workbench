import {
  cliProviderFactory,
  parseProfile,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import { claudeCodeProfile } from "./profile.js";
import { statusLineTelemetry } from "./telemetry.js";
import { readUsage } from "./usage.js";
import { discoverClaudeImportables } from "./importables.js";

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
  // Skills and MCP servers Claude Code already has, to use in every tool.
  discoverImportables: discoverClaudeImportables,
};


/** Claude Code's entries: the default account and any further ones. */
export function claudeCodeFactory(): ProviderFactory {
  return cliProviderFactory(claudeCode, claudeCodeExtensions);
}
