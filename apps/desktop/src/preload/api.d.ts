import type {
  AppEvent,
  IpcChannel,
  IpcInput,
  IpcOutput,
  IslandState,
  IslandTarget,
  TerminalEvent,
} from "@ai-workbench/shared";

export interface WorkbenchApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  /** Where the Status Island asked the main window to go (spec §98). */
  onNavigate(listener: (target: IslandTarget) => void): () => void;
}

/**
 * The Status Island's own bridge. It is deliberately tiny: the island shows
 * what it is given and can ask for two things, so a floating always-on-top
 * window carries none of the main window's reach (spec §5).
 */
export interface WorkbenchIslandApi {
  onState(listener: (state: IslandState) => void): () => void;
  /** Brings the main window forward at the place this entry is about. */
  open(target: IslandTarget): Promise<void>;
  /** Lets the island settle back to its compact state (spec §97). */
  dismiss(): Promise<void>;
  /** Steps through the widgets that currently have something to say. */
  cycle(direction: 1 | -1): Promise<void>;
}

declare global {
  interface Window {
    readonly workbench: WorkbenchApi;
    readonly workbenchIsland: WorkbenchIslandApi;
  }
}
