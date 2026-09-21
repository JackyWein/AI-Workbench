import type { NormalizedProviderError, ProviderErrorKind } from "@ai-workbench/shared";

/**
 * Adapters throw this so the core can surface a normalized error without
 * knowing anything about the underlying provider (spec §13, §60).
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly detail: string | undefined;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryable?: boolean; detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }

  toNormalized(): NormalizedProviderError {
    return {
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

/** Turns anything thrown into a normalized error. Never throws itself. */
export function normalizeError(error: unknown): NormalizedProviderError {
  if (error instanceof ProviderError) {
    return error.toNormalized();
  }
  if (error instanceof Error) {
    const kind: ProviderErrorKind =
      error.name === "AbortError" ? "cancelled" : "unknown";
    return {
      kind,
      message: error.message || "Unknown provider error",
      retryable: false,
    };
  }
  return {
    kind: "unknown",
    message: typeof error === "string" ? error : "Unknown provider error",
    retryable: false,
  };
}
