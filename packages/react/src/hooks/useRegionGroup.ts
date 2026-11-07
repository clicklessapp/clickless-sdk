import { useMemo, useSyncExternalStore } from "react";
import { useRegionStoreRegistry } from "../region/regionContext";

/**
 * The regions a prompt bar speaks for: one id, or several for a screen made of
 * more than one region. `regionIdsKey` names the set, for anything that must start
 * again when the bar is pointed at other regions.
 */
export function useRegionGroup(regionId: string | readonly string[]) {
  const storeRegistry = useRegionStoreRegistry();
  const regionIdsKey = regionIdsKeyOf(regionId);
  const regionGroup = useMemo(
    () => storeRegistry.groupFor(JSON.parse(regionIdsKey) as string[]),
    [storeRegistry, regionIdsKey],
  );
  const groupSnapshot = useSyncExternalStore(
    regionGroup.subscribe,
    regionGroup.getSnapshot,
    regionGroup.getServerSnapshot,
  );
  return { regionGroup, groupSnapshot, regionIdsKey };
}

/**
 * One string naming a set of region ids. An array written in JSX is a new one
 * on every render, so the ids are compared by value through this.
 */
export function regionIdsKeyOf(regionId: string | readonly string[]): string {
  return JSON.stringify(typeof regionId === "string" ? [regionId] : [...new Set(regionId)]);
}
