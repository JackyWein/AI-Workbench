import type {
  TeamArtifact,
  TeamDecision,
  TeamMessage,
  TeamRun,
  TeamRunSnapshot,
  TeamTask,
  TeamTurn,
} from "@ai-workbench/shared";

/**
 * Persistence for a team run (spec §53). The service works against this port,
 * so the same logic is exercised by the tests in memory and by the application
 * against SQLite.
 */
export interface TeamRunStore {
  loadSnapshot(runId: string): Promise<TeamRunSnapshot | null>;
  saveRun(run: TeamRun): Promise<void>;
  saveTask(task: TeamTask): Promise<void>;
  saveMessage(message: TeamMessage): Promise<void>;
  saveDecision(decision: TeamDecision): Promise<void>;
  saveArtifact(artifact: TeamArtifact): Promise<void>;
  saveTurn(turn: TeamTurn): Promise<void>;
}

/** Test double; also what a run falls back to if persistence is unavailable. */
export class InMemoryTeamRunStore implements TeamRunStore {
  readonly #runs = new Map<string, TeamRun>();
  readonly #tasks = new Map<string, TeamTask>();
  readonly #messages = new Map<string, TeamMessage>();
  readonly #decisions = new Map<string, TeamDecision>();
  readonly #artifacts = new Map<string, TeamArtifact>();
  readonly #turns = new Map<string, TeamTurn>();

  async loadSnapshot(runId: string): Promise<TeamRunSnapshot | null> {
    const run = this.#runs.get(runId);
    if (!run) {
      return null;
    }
    const forRun = <T extends { runId: string }>(source: Map<string, T>): T[] =>
      [...source.values()].filter((entry) => entry.runId === runId);
    return {
      run,
      tasks: forRun(this.#tasks),
      messages: forRun(this.#messages),
      decisions: forRun(this.#decisions),
      artifacts: forRun(this.#artifacts),
      turns: forRun(this.#turns),
    };
  }

  async saveRun(run: TeamRun): Promise<void> {
    this.#runs.set(run.id, run);
  }

  async saveTask(task: TeamTask): Promise<void> {
    this.#tasks.set(task.id, task);
  }

  async saveMessage(message: TeamMessage): Promise<void> {
    this.#messages.set(message.id, message);
  }

  async saveDecision(decision: TeamDecision): Promise<void> {
    this.#decisions.set(decision.id, decision);
  }

  async saveArtifact(artifact: TeamArtifact): Promise<void> {
    this.#artifacts.set(artifact.id, artifact);
  }

  async saveTurn(turn: TeamTurn): Promise<void> {
    this.#turns.set(turn.id, turn);
  }
}
