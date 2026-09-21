import { type JSX, useCallback, useSyncExternalStore } from "react";
import {
  ACTIVITY_BUCKETS,
  ACTIVITY_BUCKET_MS,
  activityOf,
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
  const subscribe = useCallback(
    (listener: () => void) => (terminalId ? subscribeActivity(terminalId, listener) : () => {}),
    [terminalId],
  );
  // A stable snapshot per notification, so React only re-renders on a beat.
  const snapshot = useSyncExternalStore(subscribe, () => cached(terminalId));

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

const snapshots = new Map<string, { at: number; value: ActivitySnapshot }>();

/** useSyncExternalStore needs the same object until something changed. */
function cached(terminalId: string | null): ActivitySnapshot {
  const key = terminalId ?? "";
  const beat = Math.floor(Date.now() / (ACTIVITY_BUCKET_MS / 2));
  const hit = snapshots.get(key);
  if (hit && hit.at === beat) {
    return hit.value;
  }
  const value = activityOf(terminalId);
  snapshots.set(key, { at: beat, value });
  return value;
}
