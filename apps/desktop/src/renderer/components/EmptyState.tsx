import type { JSX } from "react";
interface EmptyStateProps {
  readonly title: string;
  readonly action?: { label: string; onClick: () => void } | undefined;
}

/** Minimal empty state, no illustrations (spec §84). */
export function EmptyState({ title, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {action ? (
        <button type="button" className="ghost-button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
