import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  label?: string;
};

type State = {
  error: Error | null;
};

/** Keeps the shell visible when a pane throws (e.g. bad DN / list payload). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(this.props.label ?? "UI error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <p>Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}.</p>
          <pre className="error-block">{this.state.error.message}</pre>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
