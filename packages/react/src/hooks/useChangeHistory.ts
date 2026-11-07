import { useCallback, useEffect, useRef, useState } from "react";
import type { Manifest } from "@clickless/core";
import type { HistoryEntry } from "../engine/engineResponses";
import { useRegionGroup } from "./useRegionGroup";
import { describeError } from "../engine/engineErrorMessages";
import { userFacingTitleOf } from "../region/userFacingTitle";

export interface ChangeHistoryOptions {
  /** How many entries to hold at first, and to load each time. Default 5. */
  pageSize?: number;
  /**
   * `prompts` (the default) lists only changes the user asked for in words,
   * which reads as a conversation. `all` also lists changes made with the
   * application's own controls, undos and restores.
   */
  include?: "prompts" | "all";
}

/**
 * A user's saved changes to a region, oldest first so they read like a
 * conversation. Holds the latest page and loads earlier ones on request.
 *
 * Given several region ids, it is the history of them all as one list. A
 * change that reached more than one region is one entry, whose `revision` is
 * the number of the change as a whole and whose `regions` says what it did in each.
 */
export function useChangeHistory(regionId: string | readonly string[], historyOptions: ChangeHistoryOptions = {}) {
  const { pageSize = 5, include = "prompts" } = historyOptions;
  const { regionGroup, groupSnapshot, regionIdsKey } = useRegionGroup(regionId);
  const { readHistory } = regionGroup;
  const { hasHistory, revision, loading: savedLayoutLoading } = groupSnapshot;
  // A region that comes onto the screen later brings its own changes into the list.
  const regionsOnScreen = groupSnapshot.regions
    .filter((region) => region.snapshot.manifest !== null)
    .map((region) => region.regionId)
    .join("\n");
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Fetching the newest entries and fetching earlier ones go on side by side,
  // so each kind counts its own requests: a newer one replaces only its own kind.
  const newestPageRequestId = useRef(0);
  const earlierPageRequestId = useRef(0);
  const requestsInFlight = useRef(0);
  // Which region's requests `requestsInFlight` is counting.
  const regionGeneration = useRef(0);
  // What `entries` holds, readable by a request that finishes later.
  const loadedEntries = useRef<HistoryEntry[]>([]);

  const fetchHistoryPage = useCallback(
    async (beforeRevision?: number) => {
      const requestCounter = beforeRevision === undefined ? newestPageRequestId : earlierPageRequestId;
      const requestId = ++requestCounter.current;
      const requestGeneration = regionGeneration.current;
      requestsInFlight.current++;
      setLoadingHistory(true);
      try {
        const historyPage = await readHistory({
          limit: pageSize,
          promptedOnly: include === "prompts",
          ...(beforeRevision !== undefined && { before: beforeRevision }),
        });
        if (requestId !== requestCounter.current) return;

        // The page that reaches furthest back is the one that knows whether more lie behind it.
        const earliestLoadedRevision = loadedEntries.current[0]?.revision;
        const oldestRevisionInPage = historyPage.revisions.at(-1)?.revision;
        const pageReachesBack =
          earliestLoadedRevision === undefined ||
          beforeRevision !== undefined ||
          (oldestRevisionInPage !== undefined && oldestRevisionInPage <= earliestLoadedRevision);
        if (pageReachesBack) setHasEarlier(historyPage.hasMore);

        const entriesByRevision = new Map(loadedEntries.current.map((entry) => [entry.revision, entry]));
        for (const entry of historyPage.revisions) entriesByRevision.set(entry.revision, entry);
        loadedEntries.current = [...entriesByRevision.values()].sort(
          (firstEntry, secondEntry) => firstEntry.revision - secondEntry.revision,
        );
        setHistoryEntries(loadedEntries.current);
        setHistoryError(null);
      } catch (fetchError) {
        if (requestId === requestCounter.current) setHistoryError(describeError(fetchError));
      } finally {
        // Every request is counted out, including one a newer request replaced.
        // Those from before the region changed were dropped from the count then.
        if (requestGeneration === regionGeneration.current) {
          requestsInFlight.current--;
          if (requestsInFlight.current === 0) setLoadingHistory(false);
        }
      }
    },
    [readHistory, pageSize, include],
  );

  // Pointed at other regions, start again: their history is a different conversation.
  useEffect(
    () => () => {
      newestPageRequestId.current++;
      earlierPageRequestId.current++;
      regionGeneration.current++;
      requestsInFlight.current = 0;
      loadedEntries.current = [];
      setHistoryEntries([]);
      setHasEarlier(false);
      setHistoryError(null);
      setLoadingHistory(false);
    },
    [regionIdsKey],
  );

  // Every saved change moves `revision`, which is the cue to fetch the newest entries.
  useEffect(() => {
    if (hasHistory && !savedLayoutLoading && revision > 0) void fetchHistoryPage();
  }, [hasHistory, savedLayoutLoading, revision, fetchHistoryPage, regionsOnScreen]);

  const earliestRevision = historyEntries[0]?.revision;
  return {
    entries: historyEntries,
    loading: loadingHistory,
    error: historyError,
    hasEarlier,
    loadEarlier: useCallback(() => {
      if (earliestRevision !== undefined) void fetchHistoryPage(earliestRevision);
    }, [fetchHistoryPage, earliestRevision]),
  };
}

/**
 * A short description of a change made without a prompt, for a history that
 * includes them. An entry in a form it does not know is described in general terms.
 */
export function describeHistoryEntry(entry: Pick<HistoryEntry, "kind" | "operations">, manifest: Manifest | null): string {
  if (entry.kind !== "apply") return "Went back to an earlier version of this screen";
  // From an engine, or written by hand, an operation may lack what its type promises.
  const operations: unknown[] = Array.isArray(entry.operations) ? entry.operations : [];
  const operationFields = operations.filter(
    (operation): operation is Record<string, unknown> => typeof operation === "object" && operation !== null,
  );
  if (operationFields.some((operation) => operation.type === "reset" && operation.id === undefined)) {
    return "Reset the whole screen";
  }
  const changedComponentIds = new Set(
    operationFields.flatMap((operation) => {
      const componentIds = operation.type === "reorder" ? operation.ids : [operation.id];
      return Array.isArray(componentIds)
        ? componentIds.filter((componentId): componentId is string => typeof componentId === "string")
        : [];
    }),
  );
  if (changedComponentIds.size === 0) return "Changed this screen";
  const componentTitles = [...changedComponentIds].flatMap((componentId) => {
    const component = manifest?.components.find((manifestComponent) => manifestComponent.id === componentId);
    return (component && userFacingTitleOf(component)) ?? [];
  });
  // A section that has since been removed, or was never given a title, has
  // only an id that means nothing to the user, so the sections are counted instead.
  if (componentTitles.length < changedComponentIds.size || componentTitles.length > 3) {
    if (changedComponentIds.size > 1) return `Changed ${changedComponentIds.size} sections`;
    const [onlyComponentId] = changedComponentIds;
    return manifest?.components.some((component) => component.id === onlyComponentId)
      ? "Changed a section"
      : "Changed a section that is no longer here";
  }
  const lastComponentTitle = componentTitles.pop()!;
  return `Changed ${componentTitles.length > 0 ? `${componentTitles.join(", ")} and ` : ""}${lastComponentTitle}`;
}
