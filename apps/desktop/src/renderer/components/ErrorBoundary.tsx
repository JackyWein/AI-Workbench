import { Component, type ErrorInfo, type JSX, type ReactNode } from "react";
import { reportRendererError } from "../lib/error-reporting.js";

interface ErrorBoundaryProps {
  readonly fallbackTitle: string;
  readonly fallbackHint?: string;
  /**
   * A panel rather than a whole view — the sidebar, the context panel, a
   * terminal grid: the fallback stays small and keeps the layout standing.
   */
  readonly compact?: boolean;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: string | null;
}

/**
 * Isolates one part of the interface so a render throw cannot unmount the
 * whole app (a blank window). What failed is kept in the application log and
 * a crash report, and the part offers to try again; everything else keeps
 * running.
 */
export class RendererErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[view:${this.props.fallbackTitle}]`, error);
    reportRendererError(`view:${this.props.fallbackTitle}`, error, info.componentStack ?? undefined);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): JSX.Element {
    if (!this.state.error) {
      return <>{this.props.children}</>;
    }
    if (this.props.compact) {
      return (
        <div className="error-fallback error-fallback--compact" role="alert">
          <p className="error-fallback__title">{this.props.fallbackTitle} could not be shown</p>
          <p className="error-fallback__detail">{this.state.error}</p>
          <button type="button" className="ghost-button" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="view">
        <div className="view__inner">
          <header className="view__header">
            <div className="view__heading">
              <h1 className="view__title">{this.props.fallbackTitle} unavailable</h1>
              <p className="view__lede">
                {this.props.fallbackHint ??
                  "This view failed to render. The rest of the app keeps running, and the error was saved to the log."}
              </p>
            </div>
            <button type="button" className="ghost-button" onClick={this.reset}>
              Try again
            </button>
          </header>
          <p className="field__description" role="alert">
            {this.state.error}
          </p>
        </div>
      </div>
    );
  }
}

interface AppBoundaryState {
  readonly error: string | null;
}

/**
 * The last line of defence around the whole interface. Nothing the app runs
 * lives here — sessions, teams and terminals are in the main process — so a
 * reload brings everything back exactly as it was.
 */
export class AppCrashBoundary extends Component<{ readonly children: ReactNode }, AppBoundaryState> {
  constructor(props: { readonly children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): AppBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[app]", error);
    reportRendererError("app", error, info.componentStack ?? undefined);
  }

  private readonly reload = (): void => {
    window.location.reload();
  };

  private readonly openReports = (): void => {
    void window.workbench.invoke("app.openCrashReports", undefined).catch(() => undefined);
  };

  override render(): JSX.Element {
    if (!this.state.error) {
      return <>{this.props.children}</>;
    }
    return (
      <div className="app-crash" role="alert">
        <div className="app-crash__inner">
          <h1 className="app-crash__title">The window ran into a problem</h1>
          <p className="app-crash__lede">
            Your sessions, team runs and terminals keep running in the background. Reloading the
            window brings them back as they are.
          </p>
          <p className="app-crash__detail">{this.state.error}</p>
          <div className="app-crash__actions">
            <button type="button" className="primary-button" onClick={this.reload}>
              Reload window
            </button>
            <button type="button" className="ghost-button" onClick={this.openReports}>
              Open crash reports
            </button>
          </div>
        </div>
      </div>
    );
  }
}
