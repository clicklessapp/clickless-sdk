import { useSyncExternalStore } from "react";
import { useRegionStoreRegistry } from "../region/regionContext";

const subscribeToNothing = () => () => {};

/**
 * False while the engine cannot be reached, from the first request that finds
 * it so until one gets an answer again. True with no engine, and on the server.
 */
export function useEngineReachable(): boolean {
  const { engine } = useRegionStoreRegistry();
  return useSyncExternalStore(
    engine?.subscribeToReachability ?? subscribeToNothing,
    () => engine?.isReachable ?? true,
    () => true,
  );
}
