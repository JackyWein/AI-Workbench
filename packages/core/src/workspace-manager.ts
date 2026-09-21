import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { workspaces, type WorkspaceRow } from "@ai-workbench/database";
import type {
  CreateWorkspaceInput,
  Logger,
  UpdateWorkspaceInput,
  Workspace,
} from "@ai-workbench/shared";
import type { EventBus } from "./event-bus.js";
import { createId } from "./ids.js";

export class WorkspaceNotFoundError extends Error {
  constructor(id: string) {
    super(`Workspace "${id}" does not exist`);
    this.name = "WorkspaceNotFoundError";
  }
}

export class InvalidWorkspacePathError extends Error {
  constructor(path: string, reason: string) {
    super(`Workspace path "${path}" is not usable: ${reason}`);
    this.name = "InvalidWorkspacePathError";
  }
}

export interface WorkspaceManagerOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
}

export class WorkspaceManager {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;

  constructor(options: WorkspaceManagerOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("WORKSPACE");
  }

  async list(): Promise<Workspace[]> {
    const rows = await this.#db.select().from(workspaces);
    return rows
      .map(toWorkspace)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Workspace | null> {
    const [row] = await this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    return row ? toWorkspace(row) : null;
  }

  async require(id: string): Promise<Workspace> {
    const workspace = await this.get(id);
    if (!workspace) {
      throw new WorkspaceNotFoundError(id);
    }
    return workspace;
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const path = await this.#validateDirectory(input.path);
    // The same folder twice is one workspace, not two: adding it again
    // selects the existing one instead of duplicating the sidebar.
    const same = (await this.list()).find(
      (workspace) => workspace.path.toLowerCase() === path.toLowerCase(),
    );
    if (same) {
      return same;
    }
    const now = new Date();
    const row: WorkspaceRow = {
      id: createId("ws"),
      name: input.name.trim(),
      path,
      settings: input.settings ?? {},
      createdAt: now,
      updatedAt: now,
    };

    await this.#db.insert(workspaces).values(row);
    const workspace = toWorkspace(row);
    this.#logger.info("Workspace created", { workspaceId: workspace.id });
    this.#events.publish({ type: "workspace.created", workspace });
    return workspace;
  }

  async update(input: UpdateWorkspaceInput): Promise<Workspace> {
    const existing = await this.require(input.id);
    const path =
      input.path === undefined
        ? existing.path
        : await this.#validateDirectory(input.path);

    const updated: Workspace = {
      ...existing,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      path,
      updatedAt: new Date(),
    };

    await this.#db
      .update(workspaces)
      .set({
        name: updated.name,
        path: updated.path,
        settings: updated.settings,
        updatedAt: updated.updatedAt,
      })
      .where(eq(workspaces.id, updated.id));

    this.#events.publish({ type: "workspace.updated", workspace: updated });
    return updated;
  }

  /** Cascades to sessions and their messages through the schema. */
  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) {
      return false;
    }
    await this.#db.delete(workspaces).where(eq(workspaces.id, id));
    this.#logger.info("Workspace deleted", { workspaceId: id });
    this.#events.publish({ type: "workspace.deleted", workspaceId: id });
    return true;
  }

  async #validateDirectory(path: string): Promise<string> {
    const resolved = resolve(path);
    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        throw new InvalidWorkspacePathError(resolved, "not a directory");
      }
    } catch (error) {
      if (error instanceof InvalidWorkspacePathError) {
        throw error;
      }
      throw new InvalidWorkspacePathError(resolved, "directory does not exist");
    }
    return resolved;
  }
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    settings: row.settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
