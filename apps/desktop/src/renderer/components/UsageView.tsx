import { type JSX, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  AgentTerminal,
  ProviderSummary,
  ProviderUsageSnapshot,
  UsageLimit,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import {
  amountOf,
  formatAge,
  formatIn,
  formatWhen,
  hasReset,
  meterTone,
  snapshotOf,
  usageProviders,
  useNow,
  usedPercent,
} from "../lib/usage.js";
import { Logo } from "./Logo.js";
import { TerminalMetricsStrip } from "./TerminalMetrics.js";

/**
 * Every account's usage in one place (spec §55, §56, §65): the quotas a tool
 * reported with their reset times, what it counted as consumed, and how old
 * each report is. Nothing is estimated here; what a tool did not say is shown
 * as not reported.
 */
export function UsageView(): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const usage = useWorkbench((state) => state.usage);
  const developerMode = useWorkbench((state) => state.settings.developerMode);
  const refreshUsage = useWorkbench((state) => state.refreshUsage);
  const agentTerminals = useWorkbench((state) => state.agentTerminals);
  const now = useNow(1000);
  const [refreshing, setRefreshing] = useState(false);

  const shown = useMemo(() => usageProviders(providers, developerMode), [providers, developerMode]);
  const running = useMemo(
    () =>
      Object.values(agentTerminals)
        .flat()
        .filter((terminal) => terminal.purpose === "agent" && terminal.state === "running"),
    [agentTerminals],
  );

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshUsage();
    } finally {
      setRefreshing(false);
    }
  };

  // Refresh on open + every 60s while open + on focus (no aggressive polling).
  useEffect(() => {
    void refreshUsage();
    const timer = setInterval(() => void refreshUsage(), 60_000);
    const onFocus = (): void => {
      void refreshUsage();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="view">
      <div className="view__inner">
        <header className="view__header">
          <div className="view__heading">
            <h1 className="view__title">Usage</h1>
            <p className="view__lede">What each tool last reported about its account.</p>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
              className={refreshing ? "spin" : undefined}
            />
            {refreshing ? "Asking the tools…" : "Refresh"}
          </button>
        </header>

        {shown.length === 0 ? (
          <p className="view__empty">
            No installed tool reports usage. Install one under Providers.
          </p>
        ) : (
          <div className="usage-grid">
            {shown.map((provider) => (
              <UsageCard
                key={provider.metadata.id}
                provider={provider}
                snapshot={snapshotOf(usage, provider.metadata.id)}
                now={now}
              />
            ))}
          </div>
        )}

        {running.length > 0 ? (
          <section>
            <p className="section__label">Running now</p>
            <div className="run-list">
              {running.map((terminal) => (
                <RunningAgent
                  key={terminal.id}
                  terminal={terminal}
                  provider={providers.find((entry) => entry.metadata.id === terminal.providerId)}
                  now={now}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function UsageCard({
  provider,
  snapshot,
  now,
}: {
  readonly provider: ProviderSummary;
  readonly snapshot: ProviderUsageSnapshot | null;
  readonly now: number;
}): JSX.Element {
  const limits = snapshot?.state === "unavailable" ? [] : (snapshot?.limits ?? []);
  const quotas = limits.filter((limit) => usedPercent(limit) !== null);
  const amounts = limits.filter((limit) => usedPercent(limit) === null && amountOf(limit) !== null);
  const plan = snapshot?.plan ?? provider.auth.plan;
  const account = provider.metadata.account?.label;

  return (
    <article className="usage-card" aria-label={`${provider.metadata.displayName} usage`}>
      <header className="usage-card__head">
        <span className="logo-well" aria-hidden="true">
          <Logo name={provider.metadata.icon} label={provider.metadata.displayName} size={16} />
        </span>
        <span className="usage-card__title">
          <span className="usage-card__name">
            {provider.metadata.displayName}
            {account ? <span className="usage-card__account"> · {account}</span> : null}
          </span>
          {plan ? <span className="usage-card__plan">{capitalize(plan)}</span> : null}
        </span>
        {snapshot ? (
          <time
            className="usage-card__age"
            dateTime={snapshot.updatedAt.toISOString()}
            title={`Reported ${snapshot.updatedAt.toLocaleString()}`}
          >
            {formatAge(snapshot.updatedAt, now)}
          </time>
        ) : null}
      </header>

      {quotas.length > 0 ? (
        <div className="quota-list">
          {quotas.map((limit) => (
            <Quota key={limit.id} limit={limit} now={now} />
          ))}
        </div>
      ) : null}

      {amounts.length > 0 ? (
        <>
          {quotas.length === 0 ? (
            <p className="usage-card__note">No quota — consumed amounts.</p>
          ) : null}
          <dl className="amounts">
            {amounts.map((limit) => (
              <div className="amounts__item" key={limit.id}>
                <dt>{limit.label}</dt>
                <dd>{amountOf(limit)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {limits.length === 0 ? (
        <p className="usage-card__empty">{snapshot?.note ?? "Not reported yet."}</p>
      ) : snapshot?.note ? (
        <p className="usage-card__note">{snapshot.note}</p>
      ) : null}
    </article>
  );
}

/** One quota: how much is used, and when it starts over. */
function Quota({ limit, now }: { readonly limit: UsageLimit; readonly now: number }): JSX.Element {
  const percent = usedPercent(limit) ?? 0;
  const reset = hasReset(limit, now);
  const tone = reset ? "stale" : meterTone(percent);
  const noResetInfo = !limit.resetsAt && !limit.resetsText;
  return (
    <div className="quota" data-tone={tone}>
      <div className="quota__row">
        <span className="quota__label">{limit.label}</span>
        <span className="quota__value">{reset ? "—" : `${percent}%`}</span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label={limit.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={reset ? 0 : percent}
      >
        <span className="meter__fill" style={{ width: `${reset ? 0 : percent}%` }} />
      </div>
      <p className="quota__foot">
        {limit.resetsAt
          ? reset
            ? `Reset at ${formatWhen(limit.resetsAt, now)} · not reported since`
            : `Resets ${formatIn(limit.resetsAt, now)} · ${formatWhen(limit.resetsAt, now)}`
          : (limit.resetsText ?? "Reset time not reported")}
        {percent >= 100 && !reset && noResetInfo ? " · limit may still apply" : null}
      </p>
    </div>
  );
}

function RunningAgent({
  terminal,
  provider,
  now,
}: {
  readonly terminal: AgentTerminal;
  readonly provider: ProviderSummary | undefined;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="run-row">
      <span className="logo-well logo-well--sm" aria-hidden="true">
        <Logo name={provider?.metadata.icon} label={terminal.label} size={13} />
      </span>
      <span className="run-row__name">{terminal.label}</span>
      <TerminalMetricsStrip terminal={terminal} now={now} compact />
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
