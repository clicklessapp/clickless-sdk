import { useRef } from "react";
import { declarationOf, type ActionDefinition } from "../actions/actionRegistry";
import { useIsomorphicLayoutEffect, useRegionStoreRegistryOrStandIn } from "../region/regionContext";

/**
 * Offers an action while the calling component is mounted: something the
 * application can do for its user when they ask, such as changing their name
 * or opening a customer's record. The prompt panel then asks the planner for it
 * when a request calls for it, asks the user to confirm a `write`, and calls
 * `run`, which makes the request with the user's own sign-in.
 *
 * `run` and `confirm` may be new functions on every render: the latest are used.
 */
export function useAdaptiveAction(definition: ActionDefinition): void {
  const { actions } = useRegionStoreRegistryOrStandIn();
  const latestDefinition = useRef(definition);
  useIsomorphicLayoutEffect(() => {
    latestDefinition.current = definition;
  });
  // What the planner is told only changes when the declaration does, compared by value.
  const declarationKey = JSON.stringify(declarationOf(definition));
  useIsomorphicLayoutEffect(
    () =>
      actions.register({
        declaration: declarationOf(latestDefinition.current),
        definition: () => latestDefinition.current,
      }),
    [actions, declarationKey],
  );
}
