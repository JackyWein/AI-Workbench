import type { AppEvent, IpcChannel, IpcInput, IpcOutput } from "@ai-workbench/shared";

/**
 * Thin typed wrapper around the preload bridge. Every renderer call to the main
 * process goes through here, so there is one place where failures are shaped.
 *
 * A caller may bound a call with `timeoutMs`; by default nothing is bounded.
 * A blanket limit misreported slow but working calls as failures: the folder
 * dialog waits on the person, and `provider.list` asks every installed tool
 * for its version, sign-in and models, which on a slow machine takes longer
 * than any fixed guess and left the provider list empty. A timeout here also
 * never stops the work in the main process, it only stops waiting for it.
 */
const DEFAULT_IPC_TIMEOUT_MS = 0;

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
    return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  }
  return String(error);
}
