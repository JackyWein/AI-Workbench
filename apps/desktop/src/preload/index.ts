import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  APP_EVENT_CHANNEL,
  ISLAND_NAVIGATE_CHANNEL,
  ISLAND_DRAG_CHANNEL,
  ISLAND_STATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  isIpcChannel,
  type AppEvent,
  type IpcChannel,
  type IpcInput,
  type IpcOutput,
  type IslandDrag,
  type IslandState,
  type IslandTarget,
  type TerminalEvent,
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

  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent,
    ): void => {
      listener(payload);
    };
    ipcRenderer.on(TERMINAL_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, handler);
    };
  },

  /**
   * Where a file the person dropped into the window lives. Only files they
   * dragged in have one; this reads nothing and reaches nothing else.
   */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },

  /** Where the Status Island asked the main window to go (spec §98). */
  onNavigate(listener: (target: IslandTarget) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: IslandTarget,
    ): void => {
      listener(payload);
    };
    ipcRenderer.on(ISLAND_NAVIGATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(ISLAND_NAVIGATE_CHANNEL, handler);
    };
  },
};

/**
 * The island's bridge is separate and tiny on purpose: a floating,
 * always-on-top window gets only what it needs (spec §5). It may show state,
 * navigate the main window, settle back, cycle widgets, type a prompt into an
 * agent and answer what an agent waits on — nothing else.
 */
const islandApi = {
  onState(listener: (state: IslandState) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: IslandState): void => {
      listener(payload);
    };
    ipcRenderer.on(ISLAND_STATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(ISLAND_STATE_CHANNEL, handler);
    };
  },

  async open(target: IslandTarget): Promise<void> {
    await ipcRenderer.invoke("statusIsland.open", target);
  },

  async dismiss(): Promise<void> {
    await ipcRenderer.invoke("statusIsland.dismiss", undefined);
  },

  async ask(
    key: string,
    text: string,
  ): Promise<{ sent: boolean; to: string | null; reason: string | null }> {
    return (await ipcRenderer.invoke("statusIsland.ask", { key, text })) as {
      sent: boolean;
      to: string | null;
      reason: string | null;
    };
  },

  async respond(key: string, option: string): Promise<{ answered: boolean; reason: string | null }> {
    return (await ipcRenderer.invoke("statusIsland.respond", { key, option })) as {
      answered: boolean;
      reason: string | null;
    };
  },

  async cycle(direction: 1 | -1): Promise<void> {
    await ipcRenderer.invoke("statusIsland.cycle", { direction });
  },

  async resetPosition(): Promise<void> {
    await ipcRenderer.invoke("statusIsland.resetPosition", undefined);
  },

  async resize(width: number, height: number): Promise<void> {
    await ipcRenderer.invoke("statusIsland.resize", { width, height });
  },

  onDrag(listener: (drag: IslandDrag) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: IslandDrag): void => {
      listener(payload);
    };
    ipcRenderer.on(ISLAND_DRAG_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(ISLAND_DRAG_CHANNEL, handler);
    };
  },

  async dragStart(grabX: number, grabY: number): Promise<void> {
    await ipcRenderer.invoke("statusIsland.dragStart", { grabX, grabY });
  },

  async dragEnd(): Promise<void> {
    await ipcRenderer.invoke("statusIsland.dragEnd", undefined);
  },
};

export type WorkbenchApi = typeof api;

// One preload file serves both pages, but each page gets only its own bridge:
// the island page (island/index.html, in dev and in the build) can reach the
// island channels and nothing else, while the main window keeps the full
// contract. Least privilege per window, not per file (spec §5).
// Declared locally: this project compiles the preload without the DOM lib.
declare const location: { pathname: string };
const isIslandPage = location.pathname.endsWith("island/index.html");
if (isIslandPage) {
  contextBridge.exposeInMainWorld("workbenchIsland", islandApi);
} else {
  contextBridge.exposeInMainWorld("workbench", api);
}
