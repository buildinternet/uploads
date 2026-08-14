/**
 * Catch a render crash inside a signed-in React island so the rest of the
 * Astro shell (header, nav, rail) stays up. Retry remounts the child; a
 * deterministic throw will just land here again.
 */
import { Component, createElement, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { Callout } from "@uploads/ui";
import "@uploads/ui/styles.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class IslandErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      JSON.stringify({
        event: "island_render_failed",
        message: error.message,
        component: info.componentStack?.slice(0, 500) ?? "",
      }),
    );
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="wft-status-block">
        <Callout tone="error">
          This panel failed to load. The rest of the page is still usable.{" "}
          <button
            type="button"
            className="text-btn"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </Callout>
      </div>
    );
  }
}

/** Wrap an island element so a throw paints the recovery Callout, not a blank mount. */
export function withIslandBoundary(element: ReactElement): ReactElement {
  return createElement(IslandErrorBoundary, null, element);
}
