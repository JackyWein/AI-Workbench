import type { JSX, ReactNode } from "react";

interface EmptyStateProps {
  readonly title: string;
  /** One or two sentences on what goes here and how to begin. */
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly action?: { label: string; onClick: () => void };
}

/**
 * What a screen shows before there is anything on it: what belongs here, and
 * the one step that starts it.
 */
export function EmptyState({ title, description, icon, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      {icon ? (
        <span className="empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="empty__title">{title}</p>
      {description ? <p className="empty__description">{description}</p> : null}
      {action ? (
        <button type="button" className="primary-button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
