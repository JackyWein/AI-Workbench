import { CronExpressionParser } from "cron-parser";
import { desc, eq } from "drizzle-orm";
import { schedules, scheduleRuns, scheduleProposals, type Database } from "@ai-workbench/database";
import { scheduleContentSchema, scheduleRunSchema, type Schedule, type ScheduleContent, type ScheduleInput, type ScheduleProposal, type ScheduleRun } from "@ai-workbench/shared";
import { createId } from "./ids.js";

/** Explicit IANA validation: the parser otherwise accepts invalid zones as local time. */
export function nextScheduleRun(cron: string, timezone: string, after: Date): Date {
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
  if (!/^(\S+\s+){4,5}\S+$/.test(cron.trim()) || /\bH\b/.test(cron)) {
    throw new Error("Use five cron fields (minute hour day month weekday), or six including seconds.");
  }
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

export interface ScheduleExecution {
  status: "completed" | "failed" | "budget" | "interrupted";
  sessionId: string | null; teamRunId: string | null; turns: number; tokens: number | null; error: string | null;
}
export interface SchedulerOptions {
  db: Database;
  execute: (schedule: Schedule, signal: AbortSignal, attach: (ids: { sessionId: string; teamRunId?: string }) => Promise<void>) => Promise<ScheduleExecution>;
  validate?: (schedule: ScheduleContent) => Promise<void>;
  now?: () => Date;
  changed?: () => void;
}

/** One timer, persisted due dates, one active run per schedule. No catch-up storm. */
export class SchedulerService {
  readonly #options: SchedulerOptions;
  readonly #active = new Map<string, { abort: AbortController; done: Promise<ScheduleRun> }>();
  readonly #confirming = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #ticking = false;
  constructor(options: SchedulerOptions) { this.#options = options; }
  #now(): Date { return this.#options.now?.() ?? new Date(); }
  async list(): Promise<Schedule[]> {
    const rows = await this.#options.db.select().from(schedules);
    return rows.map((row) => ({ ...scheduleContentSchema.parse(row.content), ...row, content: undefined }));
  }
  async runs(scheduleId?: string): Promise<ScheduleRun[]> {
    const query = this.#options.db.select().from(scheduleRuns);
    const rows = await (scheduleId ? query.where(eq(scheduleRuns.scheduleId, scheduleId)) : query).orderBy(desc(scheduleRuns.startedAt)).limit(200);
    return rows.map((row) => scheduleRunSchema.parse(row));
  }
  async save(input: ScheduleInput, id?: string): Promise<Schedule> {
    const content = scheduleContentSchema.parse(input);
    const now = this.#now();
    const next = nextScheduleRun(content.cron, content.timezone, now);
    await this.#options.validate?.(content);
    const existing = id ? (await this.list()).find((entry) => entry.id === id) : undefined;
    if (id && !existing) throw new Error("This schedule no longer exists.");
    const row = { id: id ?? createId("schedule"), workspaceId: content.workspaceId, content, enabled: content.enabled, lastRunAt: existing?.lastRunAt ?? null, nextRunAt: content.enabled ? next : null, createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (existing) await this.#options.db.update(schedules).set(row).where(eq(schedules.id, row.id));
    else await this.#options.db.insert(schedules).values(row);
    this.#options.changed?.();
    await this.#arm();
    return { ...content, ...row };
  }
  async setEnabled(id: string, enabled: boolean): Promise<Schedule> {
    const schedule = await this.#require(id);
    return this.save({ ...schedule, enabled }, id);
  }
  async delete(id: string): Promise<void> {
    if (this.#active.has(id)) throw new Error("Wait for this run to finish before deleting its schedule.");
    await this.#options.db.delete(schedules).where(eq(schedules.id, id));
    this.#options.changed?.();
    await this.#arm();
  }
  async proposals(): Promise<ScheduleProposal[]> {
    return (await this.#options.db.select().from(scheduleProposals).where(eq(scheduleProposals.status, "pending")))
      .map((row) => ({ id: row.id, schedule: scheduleContentSchema.parse(row.content), status: "pending", scheduleId: row.scheduleId, createdAt: row.createdAt }));
  }
  async propose(input: ScheduleInput): Promise<ScheduleProposal> {
    const content = scheduleContentSchema.parse(input);
    nextScheduleRun(content.cron, content.timezone, this.#now());
    await this.#options.validate?.(content);
    const proposal: ScheduleProposal = { id: createId("proposal"), schedule: content, status: "pending", scheduleId: null, createdAt: this.#now() };
    await this.#options.db.insert(scheduleProposals).values({ id: proposal.id, content, status: proposal.status, scheduleId: null, createdAt: proposal.createdAt });
    this.#options.changed?.();
    return proposal;
  }
  /** Intentionally not exposed to the agent-facing MCP server. */
  async resolveProposal(id: string, create: boolean, edited?: ScheduleInput): Promise<Schedule | null> {
    if (this.#confirming.has(id)) throw new Error("This proposal is already being handled.");
    this.#confirming.add(id);
    try {
      const proposal = (await this.proposals()).find((entry) => entry.id === id);
      if (!proposal) throw new Error("This proposal was already handled.");
      const schedule = create ? await this.save(edited ?? proposal.schedule) : null;
      await this.#options.db.update(scheduleProposals).set({ status: create ? "confirmed" : "dismissed", scheduleId: schedule?.id ?? null }).where(eq(scheduleProposals.id, id));
      this.#options.changed?.();
      return schedule;
    } finally { this.#confirming.delete(id); }
  }
  async start(): Promise<void> {
    if (this.#running) return;
    await this.#options.db.update(scheduleRuns).set({ status: "interrupted", finishedAt: this.#now(), error: "Application stopped before this run finished. It was not retried." }).where(eq(scheduleRuns.status, "running"));
    this.#running = true;
    await this.tick();
  }
  /** Called after sleep/resume as well as by the timer. Missed means over 60 seconds late. */
  async tick(): Promise<void> {
    if (this.#ticking || !this.#running) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const schedule of await this.list()) {
        if (!schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > now) continue;
        const missed = now.getTime() - schedule.nextRunAt.getTime() > 60_000;
        const due = schedule.nextRunAt;
        await this.#options.db.update(schedules).set({ nextRunAt: nextScheduleRun(schedule.cron, schedule.timezone, now), updatedAt: now }).where(eq(schedules.id, schedule.id));
        if (this.#active.has(schedule.id) || (missed && schedule.catchUp === "skip")) {
          await this.#options.db.insert(scheduleRuns).values({ id: createId("scheduled-run"), scheduleId: schedule.id, dueAt: due, startedAt: now, finishedAt: now, status: "skipped", turns: 0, tokens: null, error: this.#active.has(schedule.id) ? "Previous run is still active." : "Missed while the application was asleep or closed." });
        } else void this.runNow(schedule.id, due).catch(() => undefined);
      }
      this.#options.changed?.();
    } finally { this.#ticking = false; await this.#arm(); }
  }
  async runNow(id: string, dueAt = this.#now()): Promise<ScheduleRun> {
    if (this.#active.has(id)) throw new Error("This schedule already has a run in progress.");
    const abort = new AbortController();
    const active = { abort, done: Promise.resolve(null as unknown as ScheduleRun) };
    this.#active.set(id, active);
    active.done = this.#run(id, dueAt, abort).finally(() => { this.#active.delete(id); });
    return active.done;
  }
  async #run(id: string, dueAt: Date, abort: AbortController): Promise<ScheduleRun> {
    const schedule = await this.#require(id);
    const run: ScheduleRun = { id: createId("scheduled-run"), scheduleId: id, sessionId: null, teamRunId: null, dueAt, startedAt: this.#now(), finishedAt: null, status: "running", turns: 0, tokens: null, error: null };
    await this.#options.db.insert(scheduleRuns).values(run);
    await this.#options.db.update(schedules).set({ lastRunAt: run.startedAt }).where(eq(schedules.id, id));
    this.#options.changed?.();
    const timer = setTimeout(() => abort.abort("Runtime budget reached"), schedule.budget.maxRuntimeSeconds * 1000);
    try {
      Object.assign(run, await this.#options.execute(schedule, abort.signal, async (ids) => {
        run.sessionId = ids.sessionId; run.teamRunId = ids.teamRunId ?? null;
        await this.#options.db.update(scheduleRuns).set({ sessionId: run.sessionId, teamRunId: run.teamRunId }).where(eq(scheduleRuns.id, run.id));
        this.#options.changed?.();
      }));
    } catch (error) {
      run.status = abort.signal.aborted ? "budget" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
    } finally { clearTimeout(timer); }
    run.finishedAt = this.#now();
    await this.#options.db.update(scheduleRuns).set(run).where(eq(scheduleRuns.id, run.id));
    this.#options.changed?.();
    return run;
  }
  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    for (const active of this.#active.values()) active.abort.abort("Application is stopping");
    await Promise.allSettled([...this.#active.values()].map((entry) => entry.done));
  }
  async #require(id: string): Promise<Schedule> {
    const schedule = (await this.list()).find((entry) => entry.id === id);
    if (!schedule) throw new Error("This schedule no longer exists.");
    return schedule;
  }
  async #arm(): Promise<void> {
    clearTimeout(this.#timer);
    if (!this.#running) return;
    const next = (await this.list()).filter((entry) => entry.enabled && entry.nextRunAt).map((entry) => entry.nextRunAt!.getTime());
    // A minute ceiling also covers clock changes without an OS resume event.
    const delay = Math.min(60_000, Math.max(25, Math.min(...next) - this.#now().getTime()));
    this.#timer = setTimeout(() => { void this.tick().catch(() => undefined); }, delay);
    this.#timer.unref?.();
  }
}
