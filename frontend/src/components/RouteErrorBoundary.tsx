import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PATHS } from "../routes/paths";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Catches render errors in the routed page tree; keeps the shell visible when wrapped outside outlet.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Route error", error, errorInfo);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="card error-card span-12" role="alert">
          <h2>Something went wrong</h2>
          <p className="muted">{this.state.error.message}</p>
          <div className="row mt8">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <Link to={PATHS.home} className="secondary" style={{ display: "inline-block", textDecoration: "none" }}>
              Go home
            </Link>
            <button type="button" className="secondary" onClick={() => this.setState({ error: null })}>
              Dismiss
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
