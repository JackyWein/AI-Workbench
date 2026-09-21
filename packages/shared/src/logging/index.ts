/** Structured log categories (spec §59). */
export const logCategories = [
  "CORE",
  "DATABASE",
  "IPC",
  "PROVIDER",
  "PROCESS",
  "SESSION",
  "WORKSPACE",
  "SKILL",
  "PLUGIN",
  "MCP",
  "TEAM",
  "TERMINAL",
  "STATUS_ISLAND",
] as const;

export type LogCategory = (typeof logCategories)[number];

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(category: LogCategory): Logger;
}
