import type { ActionDefinition } from "../actions/actionRegistry";
import { useAdaptiveAction } from "../hooks/useAdaptiveAction";

export type AdaptiveActionProps = ActionDefinition;

/** `useAdaptiveAction` as a component, for offering an action from JSX. Renders nothing. */
export function AdaptiveAction(props: AdaptiveActionProps) {
  useAdaptiveAction(props);
  return null;
}
