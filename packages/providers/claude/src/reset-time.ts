/**
 * Turns the reset time Claude Code prints — "Sep 22, 12:40am (Europe/Berlin)"
 * — into an instant, or gives up.
 *
 * The tool writes a wall-clock time in a named zone and leaves out the year.
 * Both can be resolved without guessing: the zone is an IANA name the runtime
 * knows, and a reset always lies ahead, so the year is the one that puts the
 * time next after now. When the zone is missing or unknown, or the text has
 * another shape, nothing is returned and the caller keeps the text as the tool
 * wrote it (spec §56).
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/*
 * How far in the past a parsed time may lie and still count as this
 * occurrence rather than the next one. The text is parsed right after the tool
 * printed it, so a reset that passed moments ago must not jump a whole year
 * (or day) ahead.
 */
const YEAR_GRACE_MS = 24 * 60 * 60 * 1000;
const DAY_GRACE_MS = 60 * 60 * 1000;

interface WallTime {
  readonly hour: number;
  readonly minute: number;
}

export function parseResetTime(text: string, now: Date = new Date()): Date | undefined {
  const trimmed = text.trim();

  const relative = parseRelative(trimmed, now);
  if (relative) {
    return relative;
  }

  const zoneMatch = /\(([^()]+)\)\s*$/.exec(trimmed);
  const zone = zoneMatch?.[1]?.trim();
  if (!zone || !isKnownZone(zone)) {
    return undefined;
  }

  let rest = trimmed.slice(0, zoneMatch?.index ?? trimmed.length).trim().replace(/,$/, "");

  let date: { month: number; day: number; year?: number } | null = null;
  const dateMatch = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/.exec(rest);
  if (dateMatch) {
    const month = MONTHS.indexOf((dateMatch[1] ?? "").slice(0, 3).toLowerCase());
    if (month === -1) {
      return undefined;
    }
    date = {
      month,
      day: Number(dateMatch[2]),
      ...(dateMatch[3] ? { year: Number(dateMatch[3]) } : {}),
    };
    rest = rest.slice(dateMatch[0].length);
  }

  rest = rest.replace(/^[,\s]+/, "").replace(/^at\s+/i, "").trim();
  if (rest === "") {
    // A date without a time of day would need a guess at the hour.
    return undefined;
  }
  const time = parseWallTime(rest);
  if (!time) {
    return undefined;
  }

  if (date) {
    if (date.year !== undefined) {
      return zonedInstant(date.year, date.month, date.day, time, zone);
    }
    const year = new Date(now.getTime()).getUTCFullYear();
    return earliestFrom(
      [year - 1, year, year + 1].map((candidate) =>
        zonedInstant(candidate, date.month, date.day, time, zone),
      ),
      now.getTime() - YEAR_GRACE_MS,
    );
  }

  // Only a time of day: the next time the zone's clock shows it.
  const today = zonedParts(now.getTime(), zone);
  return earliestFrom(
    [-1, 0, 1, 2].map((offset) => {
      const day = new Date(Date.UTC(today.year, today.month, today.day + offset));
      return zonedInstant(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), time, zone);
    }),
    now.getTime() - DAY_GRACE_MS,
  );
}

/** "in 3h 20m", "in 45m", "in 2d 4h": relative to now, so no zone is needed. */
function parseRelative(text: string, now: Date): Date | undefined {
  const match = /^in\s+((?:\d+\s*(?:d|h|m|min|mins|minutes?|hours?|days?)\s*)+)$/i.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  let minutes = 0;
  for (const part of match[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
    const amount = Number(part[1]);
    const unit = (part[2] ?? "").toLowerCase();
    minutes += unit.startsWith("d") ? amount * 1440 : unit.startsWith("h") ? amount * 60 : amount;
  }
  return new Date(now.getTime() + minutes * 60_000);
}

/** "12:40am", "12pm", "3:05 PM" or a 24-hour "15:00". */
function parseWallTime(text: string): WallTime | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(text);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) {
      return null;
    }
    const pm = (match[3] ?? "").toLowerCase() === "p";
    return { hour: (hour % 12) + (pm ? 12 : 0), minute };
  }

  // Without am/pm only an unambiguous 24-hour time with minutes is accepted.
  const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }
  return null;
}

function earliestFrom(candidates: Array<Date | undefined>, notBefore: number): Date | undefined {
  let best: Date | undefined;
  for (const candidate of candidates) {
    if (candidate && candidate.getTime() >= notBefore && (!best || candidate < best)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * The instant at which the zone's clock shows the given wall time. The zone's
 * offset is read at a first estimate and read again at the result, which
 * settles on the right side of a daylight saving change.
 */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  time: WallTime,
  zone: string,
): Date | undefined {
  const wall = Date.UTC(year, month, day, time.hour, time.minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) {
    // "Feb 30" rolled over into March: not a real date.
    return undefined;
  }

  let instant = wall - offsetAt(wall, zone);
  const corrected = wall - offsetAt(instant, zone);
  if (corrected !== instant) {
    instant = corrected;
  }
  return new Date(instant);
}

/** Milliseconds the zone's clock is ahead of UTC at an instant. */
function offsetAt(instant: number, zone: string): number {
  const parts = zonedParts(instant, zone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

interface ZonedParts {
  readonly year: number;
  /** 0-based, like Date. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function zonedParts(instant: number, zone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values["year"] ?? 1970,
    month: (values["month"] ?? 1) - 1,
    day: values["day"] ?? 1,
    // Some runtimes still write midnight as 24 with h23.
    hour: (values["hour"] ?? 0) % 24,
    minute: values["minute"] ?? 0,
    second: values["second"] ?? 0,
  };
}

function isKnownZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}
