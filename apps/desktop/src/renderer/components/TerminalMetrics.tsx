import type { JSX } from "react";
import type { AgentTerminal, TerminalMetrics } from "@ai-workbench/shared";
import { compactNumber, formatUsd } from "../lib/format.js";
import { formatClock, formatIn, hasReset, meterTone, usedPercent } from "../lib/usage.js";

interface TerminalMetricsStripProps {
  readonly terminal: AgentTerminal;
  readonly now: number;
  /** A single line for lists; the tile footer shows every item. */
  readonly compact?: boolean;
}

/**
 * What an agent's tool reported about its session, as one quiet line: time,
 * tokens, cost, context and the tightest account limit. Items the tool did
 * not report are left out rather than shown as zero (spec §56).
 */
export function TerminalMetricsStrip({
  terminal,
  now,
  compact = false,
}: TerminalMetricsStripProps): JSX.Element {
  const metrics = terminal.metrics;
  const elapsed =
    terminal.state === "running" && terminal.startedAt
      ? now - terminal.startedAt.getTime()
      : (metrics?.activeMs ?? null);

  return (
    <span
      className={compact ? "tmetrics tmetrics--compact" : "tmetrics"}
      title={metrics ? `From ${metrics.source}` : undefined}
    >
      {elapsed !== null ? (
        <span className="tmetrics__item" title="Session time">
          <span className="tmetrics__value">{formatClock(elapsed)}</span>
        </span>
      ) : null}
      {terminal.attention && terminal.state === "running" ? (
        <span
          className="tmetrics__item tmetrics__item--waiting"
          title={[terminal.attention.summary, terminal.attention.context].filter(Boolean).join("\n")}
        >
          Waiting for you · {terminal.attention.summary}
        </span>
      ) : null}
      {metrics ? <MetricItems metrics={metrics} now={now} /> : null}
      {!metrics && !terminal.attention && terminal.state === "running" && !compact ? (
        <span className="tmetrics__item tmetrics__item--muted">No numbers from this tool yet</span>
      ) : null}
    </span>
  );
}

function MetricItems({
  metrics,
  now,
}: {
  readonly metrics: TerminalMetrics;
  readonly now: number;
}): JSX.Element {
  const tokens = metrics.tokens;
  const context = metrics.context;
  const contextPercent =
    context?.windowTokens !== undefined
      ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))
      : null;
  const limit = tightest(metrics, now);

  return (
    <>
      {tokens ? (
        <span
          className="tmetrics__item"
          title={[
            `${tokens.input.toLocaleString()} input`,
            `${tokens.output.toLocaleString()} output`,
            tokens.cacheRead ? `${tokens.cacheRead.toLocaleString()} read from cache` : null,
            tokens.cacheWrite ? `${tokens.cacheWrite.toLocaleString()} written to cache` : null,
            tokens.reasoning ? `${tokens.reasoning.toLocaleString()} reasoning` : null,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          <span className="tmetrics__value">
            {compactNumber(tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0))}
          </span>
          <span className="tmetrics__unit">in</span>
          <span className="tmetrics__value">{compactNumber(tokens.output)}</span>
          <span className="tmetrics__unit">out</span>
        </span>
      ) : null}
      {metrics.costUsd !== undefined ? (
        <span
          className="tmetrics__item"
          title={
            metrics.costEstimated
              ? "Computed by the tool at list prices; your bill may differ"
              : "Cost reported by the tool"
          }
        >
          <span className="tmetrics__value">
            {metrics.costEstimated ? "≈" : ""}
            {formatUsd(metrics.costUsd)}
          </span>
        </span>
      ) : null}
      {contextPercent !== null && context ? (
        <span
          className="tmetrics__item"
          data-tone={meterTone(contextPercent)}
          title={`${context.usedTokens.toLocaleString()} of ${context.windowTokens?.toLocaleString() ?? "?"} tokens in context`}
        >
          <span className="tmetrics__unit">ctx</span>
          <span className="mini-meter" aria-hidden="true">
            <span className="mini-meter__fill" style={{ width: `${contextPercent}%` }} />
          </span>
          <span className="tmetrics__value">{contextPercent}%</span>
        </span>
      ) : null}
      {limit ? (
        <span
          className="tmetrics__item"
          data-tone={meterTone(limit.percent)}
          title={`${limit.label}: ${limit.percent}% used${
            limit.resetsAt ? `, resets ${formatIn(limit.resetsAt, now)}` : ""
          }`}
        >
          <span className="tmetrics__unit">{shortLabel(limit.label)}</span>
          <span className="tmetrics__value">{limit.percent}%</span>
        </span>
      ) : null}
    </>
  );
}

function tightest(
  metrics: TerminalMetrics,
  now: number,
): { label: string; percent: number; resetsAt: Date | undefined } | null {
  let best: { label: string; percent: number; resetsAt: Date | undefined } | null = null;
  for (const limit of metrics.limits) {
    const percent = usedPercent(limit);
    if (percent === null || hasReset(limit, now)) {
      continue;
    }
    if (!best || percent > best.percent) {
      best = { label: limit.label, percent, resetsAt: limit.resetsAt };
    }
  }
  return best;
}

/** "5-hour window" → "5h", "Weekly" → "week"; anything else as written. */
function shortLabel(label: string): string {
  const hours = /^(\d+)[ -]hour/i.exec(label);
  if (hours) {
    return `${hours[1]}h`;
  }
  if (/weekly/i.test(label)) {
    return "week";
  }
  return label.toLowerCase();
}
