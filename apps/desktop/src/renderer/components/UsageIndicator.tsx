import { type JSX, useMemo } from "react";
import type { AggregatedUsage, ProviderSummary } from "@ai-workbench/shared";
import { formatRelativeTime, headlineUsage, consumedValue, remainingPercent } from "../lib/format.js";
import { Popover } from "./Popover.js";

interface UsageIndicatorProps {
  readonly usage: AggregatedUsage | null;
  readonly providers: ProviderSummary[];
  readonly activeProviderId: string | null;
}

/**
 * The compact indicator from the product target: "Claude Sonnet 68%"
 * (spec §63, §89). It stays visually secondary, and its popover aggregates every
 * provider that actually reports usage — unknown stays unknown (spec §56, §65).
 */
export function UsageIndicator({
  usage,
  providers,
  activeProviderId,
}: UsageIndicatorProps): JSX.Element {
  const names = useMemo(
    () => new Map(providers.map((provider) => [provider.metadata.id, provider.metadata.displayName])),
    [providers],
  );

  const active = usage?.snapshots.find(
    (snapshot) => snapshot.providerId === activeProviderId,
  );
  const headline = active ? headlineUsage(active) : null;

  return (
    <Popover
      title="Usage"
      triggerClassName="pill"
      trigger={<>{headline ? `${headline.percent}% left` : "Usage unavailable"}</>}
    >
      {usage && usage.snapshots.length > 0 ? (
        <>
          {usage.snapshots.map((snapshot) => (
            <div className="usage-entry" key={snapshot.providerId}>
              <div className="usage-entry__head">
                <span className="usage-entry__name">
                  {names.get(snapshot.providerId) ?? snapshot.providerId}
                </span>
                <span className="usage-entry__state">
                  {snapshot.state === "estimated" ? "Estimated" : null}
                  {snapshot.state === "partial" ? "Partial" : null}
                  {snapshot.state === "unavailable" ? "Unavailable" : null}
                </span>
              </div>

              {snapshot.limits.length === 0 ? (
                <p className="usage-entry__limit">
                  <span>{snapshot.note ?? "Usage unavailable"}</span>
                </p>
              ) : (
                snapshot.limits.map((limit) => {
                  const percent = remainingPercent(limit);
                  const consumed = percent === null ? consumedValue(limit) : null;
                  return (
                    <p className="usage-entry__limit" key={limit.id}>
                      <span>{limit.label}</span>
                      <span>
                        {percent !== null ? `${percent}% remaining` : (consumed ?? "Unknown")}
                      </span>
                    </p>
                  );
                })
              )}
            </div>
          ))}
          <p className="usage-footnote">
            Updated {formatRelativeTime(usage.updatedAt)}
          </p>
        </>
      ) : (
        <p className="usage-entry__limit">
          <span>Usage unavailable</span>
        </p>
      )}
    </Popover>
  );
}
