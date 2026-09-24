import { Component, type JSX, type ReactNode } from "react";

interface ErrorBoundaryProps {
  readonly fallbackTitle: string;
  readonly fallbackHint?: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: string | null;
}

/**
 * Isolates one view so a render throw cannot unmount the whole app
 * (grey-screen). Shows a quiet fallback with retry instead of freezing.
 */
export class RendererErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    // Visible in devtools; main-process forwarding is wired in main.tsx.
    console.error(`[view:${this.props.fallbackTitle}]`, error);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): JSX.Element {
    if (this.state.error) {
      return (
        <div className="view">
          <div className="view__inner">
            <header className="view__header">
              <div className="view__heading">
                <h1 className="view__title">{this.props.fallbackTitle} unavailable</h1>
                <p className="view__lede">
                  {this.props.fallbackHint ?? "This view failed to render. The rest of the app keeps running."}
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
    return <>{this.props.children}</>;
  }
}
