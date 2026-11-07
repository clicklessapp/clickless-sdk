import { useMemo, useSyncExternalStore } from "react";
import { useRegionStore } from "../region/regionContext";

/**
 * Reads a region's manifest and layout and returns the functions that change it.
 * Works anywhere inside `AdaptiveProvider`, including outside the region itself.
 * Outside the provider it reads the region it sits in, or, outside that
 * region too, an empty one of its own whose changes reach nothing on screen.
 */
export function useAdaptiveRegion(regionId: string) {
  const regionStore = useRegionStore(regionId);
  const regionSnapshot = useSyncExternalStore(
    regionStore.subscribe,
    regionStore.getSnapshot,
    regionStore.getServerSnapshot,
  );
  return useMemo(
    () => ({
      ...regionSnapshot,
      applyOperations: regionStore.applyOperations,
      previewOperations: regionStore.previewOperations,
      commitPreview: regionStore.commitPreview,
      cancelPreview: regionStore.cancelPreview,
      discardPreview: regionStore.discardPreview,
      undoLastChange: regionStore.undoLastChange,
      planFromPrompt: regionStore.planFromPrompt,
      restoreRevision: regionStore.restoreRevision,
      readHistory: regionStore.readHistory,
    }),
    [regionSnapshot, regionStore],
  );
}
