import type { AppEvent, IpcChannel, IpcInput, IpcOutput } from "@ai-workbench/shared";

/**
 * Thin typed wrapper around the preload bridge. Every renderer call to the main
 * process goes through here, so there is one place where failures are shaped.
 */
export async function invoke<C extends IpcChannel>(
  channel: C,
  input: IpcInput<C>,
): Promise<IpcOutput<C>> {
  return window.workbench.invoke(channel, input);
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
