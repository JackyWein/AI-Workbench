import type { AppEvent, IpcChannel, IpcInput, IpcOutput } from "@ai-workbench/shared";

/**
 * Thin typed wrapper around the preload bridge. Every renderer call to the main
 * process goes through here, so there is one place where failures are shaped.
 * A per-call timeout keeps a hanging handler from freezing the view forever.
 */
const DEFAULT_IPC_TIMEOUT_MS = 30_000;

export async function invoke<C extends IpcChannel>(
  channel: C,
  input: IpcInput<C>,
  timeoutMs: number = DEFAULT_IPC_TIMEOUT_MS,
): Promise<IpcOutput<C>> {
  const call = window.workbench.invoke(channel, input);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return call;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Request timed out: ${channel}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function onAppEvent(listener: (event: AppEvent) => void): () => void {
  return window.workbench.onEvent(listener);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Electron prefixes IPC rejections with the handler location.
    return error.message.replace(/^Error invoking remote method '[^']+': /, "");
  }
  return String(error);
}
