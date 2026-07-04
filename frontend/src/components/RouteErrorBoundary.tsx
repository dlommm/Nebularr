import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PATHS } from "../routes/paths";
import { Button } from "@/components/ui/button";

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
        <div
          role="alert"
          className="rounded-2xl border border-destructive/40 bg-destructive/10 p-5 backdrop-blur-xl"
        >
          <h2 className="font-heading text-lg font-semibold">Something went wrong</h2>
          <p className="mt-1 text-sm text-muted-foreground">{this.state.error.message}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button variant="secondary" render={<Link to={PATHS.home} />}>
              Go home
            </Button>
            <Button type="button" variant="secondary" onClick={() => this.setState({ error: null })}>
              Dismiss
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
