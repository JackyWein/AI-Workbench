import {
  cliProviderFactory,
  parseProfile,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import { claudeCodeProfile } from "./profile.js";
import { statusLineTelemetry } from "./telemetry.js";

export { claudeCodeProfile } from "./profile.js";

/** Claude Code's profile, parsed. */
export const claudeCode = parseProfile(claudeCodeProfile);
export * from "./telemetry.js";
export * from "./attention.js";
export { parseResetTime } from "./reset-time.js";

/** What Claude Code needs beyond its profile data. */
export const claudeCodeExtensions: CliProviderExtensions = {
  interactiveTelemetry: statusLineTelemetry,
};

/** Claude Code's entries: the default account and any further ones. */
export function claudeCodeFactory(): ProviderFactory {
  return cliProviderFactory(claudeCode, claudeCodeExtensions);
}
