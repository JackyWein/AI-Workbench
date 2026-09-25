import type { ProviderUsageSnapshot, UsageLimit } from "@ai-workbench/shared";

interface Sample { at: number; percent: number }
interface WindowHistory { identity: string; samples: Sample[] }
const HOUR = 3_600_000;

/** In-memory observations: restarting needs fresh evidence, not an invented pace. */
export class UsageForecaster {
  readonly #history = new Map<string, WindowHistory>();

  observe(snapshot: ProviderUsageSnapshot, now = Date.now()): ProviderUsageSnapshot {
    const at = snapshot.updatedAt.getTime();
    const reported = snapshot.state !== "unavailable" && snapshot.state !== "estimated" && snapshot.source !== "estimated";
    const limits = snapshot.limits.map((limit): UsageLimit => {
      // An adapter never supplies the application's prediction.
      const { forecast: _forecast, ...clean } = limit;
      const key = JSON.stringify([snapshot.providerId, limit.id]);
      const percent = percentage(limit);
      if (!reported || percent === null || !Number.isFinite(at) || at > now + 60_000 || now - at > 10 * 60_000) {
        this.#history.delete(key);
        return clean;
      }
      const reset = limit.resetsAt?.getTime();
      const identity = JSON.stringify([snapshot.source, snapshot.plan, limit.unit, limit.total, reset, limit.windowMinutes]);
      let history = this.#history.get(key);
      const last = history?.samples.at(-1);
      if (!history || history.identity !== identity || (last && (percent < last.percent || at < last.at || at - last.at > 15 * 60_000))) {
        history = { identity, samples: [] };
        this.#history.set(key, history);
      }
      history.samples = history.samples.filter((sample) => sample.at >= at - HOUR);
      if (history.samples.at(-1)?.at !== at) history.samples.push({ at, percent });
      // Three distinct reports over at least ten minutes, in the same reset window.
      const first = history.samples[0];
      if (!first || history.samples.length < 3 || at - first.at < 600_000 || percent >= 100 || reset === undefined || reset <= now) return clean;
      const rise = percent - first.percent;
      if (rise < 1) return clean;
      const exhaustsAt = at + (100 - percent) * (at - first.at) / rise;
      // No claim after a reset, in the past, or beyond a useful observation horizon.
      if (exhaustsAt <= now || exhaustsAt >= reset || exhaustsAt - now > 7 * 24 * HOUR) return clean;
      return { ...clean, forecast: { exhaustsAt: new Date(exhaustsAt), sampledAt: new Date(at), samples: history.samples.length, observationMinutes: (at - first.at) / 60_000 } };
    });
    const liveKeys = new Set(snapshot.limits.map((limit) => JSON.stringify([snapshot.providerId, limit.id])));
    for (const key of this.#history.keys()) {
      if (key.startsWith(`[${JSON.stringify(snapshot.providerId)},`) && !liveKeys.has(key)) this.#history.delete(key);
    }
    return { ...snapshot, limits };
  }
}

function percentage(limit: UsageLimit): number | null {
  const total = limit.unit === "percent" ? 100 : limit.total;
  if (total === undefined || !Number.isFinite(total) || total <= 0) return null;
  const used = limit.used ?? (limit.remaining === undefined ? undefined : total - limit.remaining);
  return used === undefined || !Number.isFinite(used) || used < 0 || used > total ? null : used / total * 100;
}
