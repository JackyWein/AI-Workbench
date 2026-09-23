import type { JSX } from "react";
import type { AggregatedUsage, ProviderSummary } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { formatIn, meterTone, tightestLimit, useNow } from "../lib/usage.js";

interface UsageIndicatorProps {
  readonly usage: AggregatedUsage | null;
  readonly providers: ProviderSummary[];
  readonly activeProviderId: string | null;
}

/**
 * The session's quota at a glance (spec §63, §89): the limit of the active
 * tool closest to running out, as the tool reported it. It opens the full
 * picture in Usage. A tool that reported nothing shows nothing here — the
 * header does not fill space with "unavailable".
 */
export function UsageIndicator({
  usage,
  providers,
  activeProviderId,
}: UsageIndicatorProps): JSX.Element | null {
  const setView = useWorkbench((state) => state.setView);
  const now = useNow(30_000);
  if (!activeProviderId) {
    return null;
  }
  const tightest = tightestLimit(usage, new Set([activeProviderId]), now);
  if (!tightest) {
    return null;
  }
  const name =
    providers.find((entry) => entry.metadata.id === activeProviderId)?.metadata.displayName ??
    activeProviderId;
  const { limit, percentUsed } = tightest;
  return (
    <button
      type="button"
      className="pill usage-pill"
      data-tone={meterTone(percentUsed)}
      onClick={() => setView("usage")}
      title={`${name} · ${limit.label}: ${percentUsed}% used${
        limit.resetsAt ? `, resets ${formatIn(limit.resetsAt, now)}` : ""
      }`}
    >
      <span className="usage-pill__meter" aria-hidden="true">
        <span className="usage-pill__fill" style={{ width: `${percentUsed}%` }} />
      </span>
      {percentUsed}%
    </button>
  );
}
