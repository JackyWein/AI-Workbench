import { contextBridge, ipcRenderer } from "electron";
import {
  APP_EVENT_CHANNEL,
  isIpcChannel,
  type AppEvent,
  type IpcChannel,
  type IpcInput,
  type IpcOutput,
} from "@ai-workbench/shared";

/**
 * The only bridge between renderer and main. It exposes exactly the contract
 * channels — no filesystem, no child processes, no arbitrary code execution
 * (spec §5).
 */
const api = {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
    if (!isIpcChannel(channel)) {
      return Promise.reject(new Error(`Unknown channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, input) as Promise<IpcOutput<C>>;
  },

  onEvent(listener: (event: AppEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(APP_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(APP_EVENT_CHANNEL, handler);
    };
  },
};

export type WorkbenchApi = typeof api;

contextBridge.exposeInMainWorld("workbench", api);
