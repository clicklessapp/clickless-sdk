import { Component, type ReactNode } from "react";

interface ClicklessUiErrorBoundaryProps {
  children: ReactNode;
  /** When this changes, a panel or bar that failed to draw is tried again: it now speaks for other regions. */
  resetKey: string;
}

interface ClicklessUiErrorBoundaryState {
  drawingFailed: boolean;
  /** The `resetKey` of the last drawing, failed or not. */
  drawnForKey: string;
}

/**
 * Draws nothing in place of the SDK's own panel or bar if drawing it in the
 * browser fails, so a fault there never takes the host's page down with it.
 * The page, its own controls and its layouts go on working. React reports the
 * fault. Pointing the panel or bar at other regions tries drawing it again.
 */
export class ClicklessUiErrorBoundary extends Component<ClicklessUiErrorBoundaryProps, ClicklessUiErrorBoundaryState> {
  override state: ClicklessUiErrorBoundaryState = { drawingFailed: false, drawnForKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ClicklessUiErrorBoundaryState> {
    return { drawingFailed: true };
  }

  static getDerivedStateFromProps(
    props: ClicklessUiErrorBoundaryProps,
    state: ClicklessUiErrorBoundaryState,
  ): Partial<ClicklessUiErrorBoundaryState> | null {
    if (props.resetKey === state.drawnForKey) return null;
    return { drawingFailed: false, drawnForKey: props.resetKey };
  }

  override render(): ReactNode {
    return this.state.drawingFailed ? null : this.props.children;
  }
}
