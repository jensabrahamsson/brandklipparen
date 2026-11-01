// App-level error boundary (D-2): a hook-order crash or any other
// render failure on the token page must never leave a blank screen
// during a live demo. One quiet card in Nielsen #9 wording, no stack,
// with a Reload action that gives the boundary a fresh attempt.
import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly hasError: boolean }
> {
  state: { readonly hasError: boolean } = { hasError: false };

  static getDerivedStateFromError(): { readonly hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(): void {
    // Deliberately silent: no error reporting endpoint exists, and the
    // card below already tells the visitor what to do next.
  }

  private readonly retry = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="card error-boundary" role="alert" aria-label="Page error">
          <p className="error-boundary-title">Something broke on this page.</p>
          <p className="quiet">The score and evidence below are unchanged; only this view failed to render.</p>
          <p>
            <button type="button" className="button" onClick={this.retry}>
              Reload
            </button>
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
