import type {
  AppEvent,
  IpcChannel,
  IpcInput,
  IpcOutput,
  IslandDrag,
  IslandState,
  IslandTarget,
  TerminalEvent,
} from "@ai-workbench/shared";

export interface WorkbenchApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  /** Where a file dropped into the window lives; empty when it has no path. */
  pathForFile(file: File): string;
  /** Where the Status Island asked the main window to go (spec §98). */
  onNavigate(listener: (target: IslandTarget) => void): () => void;
}

/**
 * The Status Island's own bridge. It is deliberately tiny: the island shows
 * what it is given and can ask for a few things — navigate, settle, type a
 * prompt, answer what an agent waits on — so a floating always-on-top window
 * carries none of the main window's reach (spec §5).
 */
export interface WorkbenchIslandApi {
  onState(listener: (state: IslandState) => void): () => void;
  /** Brings the main window forward at the place this entry is about. */
  open(target: IslandTarget): Promise<void>;
  /** Lets the island settle back to its compact state (spec §97). */
  dismiss(): Promise<void>;
  /** Types a prompt into the agent listed under this key. */
  ask(key: string, text: string): Promise<{ sent: boolean; to: string | null; reason: string | null }>;
  /** Answers the entry under this key in place with one of its options. */
  respond(key: string, option: string): Promise<{ answered: boolean; reason: string | null }>;
  /** Steps through the widgets that currently have something to say. */
  cycle(direction: 1 | -1): Promise<void>;
  /** Forgets a dragged spot and edge-dock, back to the default corner. */
  resetPosition(): Promise<void>;
  /** Reports the size the current face needs so the window fits it. */
  resize(width: number, height: number): Promise<void>;
  /** Live drag state: the rail the pill rides, or where a blob would dock. */
  onDrag(listener: (drag: IslandDrag) => void): () => void;
  /** Hands the unit to main, which moves the window with the pointer. */
  dragStart(grabX: number, grabY: number): Promise<void>;
  /** Lets go; the unit settles onto a rail or stays where it was put. */
  dragEnd(): Promise<void>;
}

declare global {
  interface Window {
    readonly workbench: WorkbenchApi;
    /** Absent when the page loads outside the island (then it shows why). */
    readonly workbenchIsland?: WorkbenchIslandApi | undefined;
  }
}
