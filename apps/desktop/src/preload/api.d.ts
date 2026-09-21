import type { AppEvent, IpcChannel, IpcInput, IpcOutput } from "@ai-workbench/shared";

export interface WorkbenchApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

declare global {
  interface Window {
    readonly workbench: WorkbenchApi;
  }
}
