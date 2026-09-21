import { type JSX, useEffect, useState } from "react";
import {
  ACTIVITY_BUCKETS,
  ACTIVITY_BUCKET_MS,
  activityOf,
  startActivityTracking,
  subscribeActivity,
  type ActivitySnapshot,
} from "../lib/terminal-activity.js";

interface ActivityTraceProps {
  readonly terminalId: string | null;
  /** Keeps the trace readable next to text of a given size. */
  readonly width?: number;
  readonly height?: number;
}

/**
 * The last minute of a terminal agent's output as a small trace: tall where it
 * printed a lot, flat where it was quiet. It shows that an agent is busy
 * without claiming to know what it is doing (spec §103).
 */
export function ActivityTrace({
  terminalId,
  width = 60,
  height = 14,
}: ActivityTraceProps): JSX.Element {
  // Plain state refreshed on a steady beat: the snapshot is wall-clock
  // derived, so an external store could hand back a different object without
  // a notification (tearing). Re-reading on an interval cannot tear.
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(() => activityOf(terminalId));

  useEffect(() => {
    const stop = startActivityTracking();
    setSnapshot(activityOf(terminalId));
    if (!terminalId) {
      return stop;
    }
    const unsubscribe = subscribeActivity(terminalId, () => {
      setSnapshot(activityOf(terminalId));
    });
    const ticker = setInterval(() => {
      setSnapshot(activityOf(terminalId));
    }, ACTIVITY_BUCKET_MS / 2);
    return () => {
      clearInterval(ticker);
      unsubscribe();
      stop();
    };
  }, [terminalId]);

  const gap = 1;
  const barWidth = (width - gap * (ACTIVITY_BUCKETS - 1)) / ACTIVITY_BUCKETS;
  // Output volume spans orders of magnitude; a log scale keeps a quiet
  // agent's trickle visible next to a burst of rendering.
  const peak = Math.max(1, ...snapshot.buckets.map((value) => Math.log1p(value)));
  const seconds = Math.round((ACTIVITY_BUCKETS * ACTIVITY_BUCKET_MS) / 1000);

  return (
    <svg
      className="activity-trace"
      data-active={snapshot.active}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={
        snapshot.active ? `Printing output now; last ${seconds} seconds shown` : `Quiet; last ${seconds} seconds shown`
      }
    >
      {snapshot.buckets.map((value, index) => {
        const scaled = value > 0 ? Math.max(2, (Math.log1p(value) / peak) * height) : 1;
        return (
          <rect
            key={index}
            x={index * (barWidth + gap)}
            y={height - scaled}
            width={barWidth}
            height={scaled}
            rx={Math.min(1, barWidth / 2)}
            data-empty={value === 0}
          />
        );
      })}
    </svg>
  );
}
