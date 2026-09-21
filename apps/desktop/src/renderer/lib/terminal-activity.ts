/**
 * How much each terminal has printed recently, in fixed time buckets.
 *
 * It is the one honest signal the application has about a tool running in its
 * own interface: output volume, not a guess at what the agent is doing. The
 * tracker listens once for the whole window, so a tile that is not on screen
 * still has its history when it comes back.
 */
export const ACTIVITY_BUCKET_MS = 2000;
export const ACTIVITY_BUCKETS = 30;

type Listener = () => void;

interface Series {
  /** Characters printed per bucket, oldest first. */
  readonly buckets: number[];
  /** Start time of the newest bucket. */
  newestAt: number;
  lastOutputAt: number;
}

const series = new Map<string, Series>();
const listeners = new Map<string, Set<Listener>>();
let detach: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function bucketStart(time: number): number {
  return time - (time % ACTIVITY_BUCKET_MS);
}

function advance(entry: Series, now: number): void {
  const start = bucketStart(now);
  const steps = Math.min(ACTIVITY_BUCKETS, Math.floor((start - entry.newestAt) / ACTIVITY_BUCKET_MS));
  for (let step = 0; step < steps; step += 1) {
    entry.buckets.shift();
    entry.buckets.push(0);
  }
  if (steps > 0) {
    entry.newestAt = start;
  }
}

function notify(terminalId: string): void {
  for (const listener of listeners.get(terminalId) ?? []) {
    listener();
  }
}

/** Starts listening; safe to call more than once. */
export function startActivityTracking(): () => void {
  if (!detach) {
    detach = window.workbench.onTerminalEvent((event) => {
      if (event.type !== "data") {
        return;
      }
      const now = Date.now();
      let entry = series.get(event.terminalId);
      if (!entry) {
        entry = {
          buckets: new Array<number>(ACTIVITY_BUCKETS).fill(0),
          newestAt: bucketStart(now),
          lastOutputAt: now,
        };
        series.set(event.terminalId, entry);
      }
      advance(entry, now);
      const last = entry.buckets.length - 1;
      entry.buckets[last] = (entry.buckets[last] ?? 0) + event.chunk.length;
      entry.lastOutputAt = now;
    });
    // Views redraw on a steady beat rather than on every chunk, so a chatty
    // tool cannot make the whole window repaint continuously.
    ticker = setInterval(() => {
      const now = Date.now();
      for (const [terminalId, entry] of series) {
        advance(entry, now);
        notify(terminalId);
      }
    }, ACTIVITY_BUCKET_MS / 2);
  }
  return () => {
    detach?.();
    detach = null;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

export interface ActivitySnapshot {
  readonly buckets: readonly number[];
  /** Printed something within the last few seconds. */
  readonly active: boolean;
}

const EMPTY: ActivitySnapshot = {
  buckets: new Array<number>(ACTIVITY_BUCKETS).fill(0),
  active: false,
};

export function activityOf(terminalId: string | null): ActivitySnapshot {
  const entry = terminalId ? series.get(terminalId) : undefined;
  if (!entry) {
    return EMPTY;
  }
  return {
    buckets: [...entry.buckets],
    active: Date.now() - entry.lastOutputAt < ACTIVITY_BUCKET_MS * 2,
  };
}

export function subscribeActivity(terminalId: string, listener: Listener): () => void {
  let set = listeners.get(terminalId);
  if (!set) {
    set = new Set();
    listeners.set(terminalId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}
