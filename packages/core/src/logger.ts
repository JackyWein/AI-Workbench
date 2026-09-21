import pino from "pino";
import type { LogCategory, LogLevel, Logger } from "@ai-workbench/shared";

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  readonly destinationFile?: string;
  readonly pretty?: boolean;
}

/**
 * Structured logging baseline (spec §59). Anything that looks like a secret is
 * redacted before it can reach a log sink.
 */
const REDACTED_KEYS = [
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "secret",
  "credential",
  "credentialReference",
  "authorization",
  "env",
  "headers",
  "mcpConfig",
  "mcpServers",
  "cookie",
  "sessionToken",
];

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  if (options.destinationFile) {
    streams.push({ stream: pino.destination({ dest: options.destinationFile, sync: false }) });
  }

  const root = pino(
    {
      level: options.level ?? "info",
      base: undefined,
      redact: {
        paths: REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]),
        censor: "[redacted]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    streams.length === 1 ? streams[0]!.stream : pino.multistream(streams),
  );

  return wrap(root, "CORE");
}

/**
 * The category travels as a field on each record rather than as a pino child
 * binding, so switching category replaces it instead of appending a second one.
 */
function wrap(instance: pino.Logger, category: LogCategory): Logger {
  return {
    debug: (message, fields) => instance.debug({ category, ...fields }, message),
    info: (message, fields) => instance.info({ category, ...fields }, message),
    warn: (message, fields) => instance.warn({ category, ...fields }, message),
    error: (message, fields) => instance.error({ category, ...fields }, message),
    child: (next: LogCategory) => wrap(instance, next),
  };
}

/** A logger that discards everything, for tests. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
