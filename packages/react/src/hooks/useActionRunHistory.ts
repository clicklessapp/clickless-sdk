import { useEffect, useState } from "react";
import type { ActionRunEntry } from "../engine/engineResponses";
import { useRegionStoreRegistry } from "../region/regionContext";

/**
 * For the prompt panel: the signed-in user's latest action runs on a screen, newest first, read from
 * the engine: what they did, never with what values. Read again whenever
 * `refreshKey` changes, such as after a run is recorded. Empty without an
 * engine, or when it cannot be read: a past list is never worth an error.
 */
export function useActionRunHistory(
  screenId: string,
  { enabled = true, limit = 10, refreshKey = 0 }: { enabled?: boolean; limit?: number; refreshKey?: number } = {},
): readonly ActionRunEntry[] {
  const { engine } = useRegionStoreRegistry();
  const [actionRuns, setActionRuns] = useState<readonly ActionRunEntry[]>([]);
  useEffect(() => {
    // Another screen's runs, or ones read while it was on, are not this one's to show.
    setActionRuns([]);
    if (!engine || !enabled) return;
    let answerIsCurrent = true;
    engine.readActionRuns(screenId, { limit }).then(
      (actionRunsPage) => {
        if (answerIsCurrent) setActionRuns(actionRunsPage.runs);
      },
      () => {},
    );
    return () => {
      answerIsCurrent = false;
    };
  }, [engine, screenId, enabled, limit]);
  // Read again after a run is recorded, keeping what is shown until the answer comes.
  useEffect(() => {
    if (!engine || !enabled || refreshKey === 0) return;
    let answerIsCurrent = true;
    engine.readActionRuns(screenId, { limit }).then(
      (actionRunsPage) => {
        if (answerIsCurrent) setActionRuns(actionRunsPage.runs);
      },
      () => {},
    );
    return () => {
      answerIsCurrent = false;
    };
  }, [engine, screenId, enabled, limit, refreshKey]);
  return actionRuns;
}
