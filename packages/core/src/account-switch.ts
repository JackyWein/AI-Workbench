import type { ChatMessage, ProviderUsageSnapshot } from "@ai-workbench/shared";

/** One account of a tool, in the order the application tries them. */
export interface AccountStanding {
  readonly providerId: string;
  readonly label: string;
  /**
   * Whether the account is at a limit right now, and when that ends. `until`
   * is null when the tool did not say; such an account counts as limited
   * until a turn on it succeeds again.
   */
  readonly limited: { readonly until: Date | null } | null;
}

export interface NextAccount {
  /** The account to continue on, or null when every other one is limited. */
  readonly next: AccountStanding | null;
  /** The earliest known moment an account of the tool frees up again. */
  readonly earliestReset: Date | null;
}

/**
 * The account after `currentId` that is not at a limit, going round the
 * tool's accounts in order. An account at its limit is never chosen; when
 * none is left the answer says when the earliest one resets, if any tool
 * said so.
 */
export function pickNextAccount(
  order: readonly AccountStanding[],
  currentId: string,
  now: number,
): NextAccount {
  const isLimited = (entry: AccountStanding): boolean =>
    entry.limited !== null && (entry.limited.until === null || entry.limited.until.getTime() > now);
  const start = order.findIndex((entry) => entry.providerId === currentId);
  for (let step = 1; step < order.length; step += 1) {
    const candidate = order[(Math.max(start, 0) + step) % order.length];
    if (candidate && candidate.providerId !== currentId && !isLimited(candidate)) {
      return { next: candidate, earliestReset: null };
    }
  }
  let earliestReset: Date | null = null;
  for (const entry of order) {
    const until = entry.limited?.until ?? null;
    if (until && until.getTime() > now && (!earliestReset || until < earliestReset)) {
      earliestReset = until;
    }
  }
  return { next: null, earliestReset };
}

/**
 * When a reported usage window says the account is used up: its reset time,
 * or null when it is used up without one. Undefined when no reported window
 * is at its limit. Windows that already reset do not count.
 */
export function exhaustedUntil(
  snapshot: ProviderUsageSnapshot | undefined,
  now: number,
): Date | null | undefined {
  if (!snapshot || snapshot.state === "unavailable") {
    return undefined;
  }
  let found: Date | null | undefined;
  for (const limit of snapshot.limits) {
    if (limit.resetsAt && limit.resetsAt.getTime() <= now) {
      continue;
    }
    const used =
      limit.unit === "percent"
        ? (limit.used ?? (limit.remaining === undefined ? undefined : 100 - limit.remaining))
        : limit.total !== undefined && limit.total > 0
          ? ((limit.used ?? (limit.remaining === undefined ? 0 : limit.total - limit.remaining)) / limit.total) *
            100
          : undefined;
    if (used === undefined || used < 100) {
      continue;
    }
    const until = limit.resetsAt ?? null;
    // The latest reset wins: the account is free only once every exhausted
    // window has reset.
    if (found === undefined || (until && (found === null || until > found))) {
      found = until;
    }
  }
  return found;
}

/** Most of the earlier conversation a handover carries, newest kept. */
const HANDOVER_MESSAGES = 40;
const HANDOVER_CHARACTERS = 48_000;

/**
 * The earlier conversation, written for a tool that has not seen it: the
 * person's turns and the answers, newest last, cut from the oldest end when
 * long. Failed and empty answers and the application's own notices are left
 * out. Null when there is nothing to hand over.
 */
export function buildHandover(earlier: readonly ChatMessage[]): string | null {
  const turns = earlier.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.content.trim().length > 0 &&
      (message.role === "user" || message.status === "complete"),
  );
  if (turns.length === 0) {
    return null;
  }
  const kept: string[] = [];
  let size = 0;
  for (let index = turns.length - 1; index >= 0 && kept.length < HANDOVER_MESSAGES; index -= 1) {
    const message = turns[index];
    if (!message) {
      continue;
    }
    const entry = `[${message.role === "user" ? "person" : "assistant"}]\n${message.content.trim()}`;
    if (size + entry.length > HANDOVER_CHARACTERS && kept.length > 0) {
      break;
    }
    kept.unshift(entry);
    size += entry.length;
  }
  const left = turns.length - kept.length;
  return [
    "<conversation-so-far>",
    "This conversation began earlier without you. Continue it as if you had been part of it; this is what was said so far.",
    ...(left > 0 ? [`(${left} earlier ${left === 1 ? "message is" : "messages are"} not included.)`] : []),
    "",
    kept.join("\n\n"),
    "</conversation-so-far>",
  ].join("\n");
}
