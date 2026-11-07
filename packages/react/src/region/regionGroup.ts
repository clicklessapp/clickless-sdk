import type { Action, ActionCall, Layout, Manifest, Operation } from "@clickless/core";
import {
  EngineError,
  requireEngine,
  type ConversationTurn,
  type EngineClient,
  type PreviewNotKeptOutcome,
} from "../engine/engineClient";
import type { HistoryPage, RegionLayoutsResponse } from "../engine/engineResponses";
import { PREVIEW_NO_LONGER_FITS_MESSAGE } from "../engine/engineErrorMessages";
import { findChangedComponentIds } from "./changedComponentIds";
import { describePreviewRequests, type PreviewRequest } from "./previewRequests";
import type { RegionSnapshot } from "./regionSnapshot";
import {
  undoResultOf,
  type PlannedPreviewOutcome,
  type RegionStore,
  type SavedLayoutSource,
  type UndoResult,
  type UnsavedChangesFirst,
} from "./regionStore";
import { textDirectionToPlanWith } from "./textDirection";

/** What a prompt bar shows of the regions it speaks for. */
export interface RegionGroupSnapshot {
  /**
   * Each region, in the order they were named. One that is not on the screen
   * has a null manifest, and takes no part in anything until it is.
   */
  regions: readonly { regionId: string; snapshot: RegionSnapshot }[];
  /** True while a proposed change is on the screen, waiting to be kept or discarded. */
  previewing: boolean;
  canUndo: boolean;
  /**
   * The order of the newest change on the screen an undo would take back,
   * among the changes and action runs since the page was loaded, or 0 when it
   * was made before then. See `RegionStoreRegistry.latestActionRunSequence`.
   */
  newestChangeSequence: number;
  /** True while the regions show how they first looked, in place of their layouts. */
  showingOriginal: boolean;
  /** True when any region on the screen differs from how it first looked. */
  differsFromOriginal: boolean;
  /** True while any region's saved layout is being fetched. */
  loading: boolean;
  /** True when any region's saved layout could not be fetched. */
  loadFailed: boolean;
  /**
   * Which point in the history the screen is at, in the same numbering as
   * `HistoryEntry.revision`: for one region, that region's revision; for
   * several, the latest change's own number (its `changeId`), which the
   * engine counts across regions.
   */
  revision: number;
  hasHistory: boolean;
  /** True while any region shows a change of the application's own that is not saved yet. */
  hasUnsavedChanges: boolean;
}

/** What a prompt is planned with besides the regions: what the screen can do, and what was said before. */
export interface PlanContext {
  actions: readonly Action[];
  conversation: readonly ConversationTurn[];
  /** Files the user attached: their names and types only. */
  attachedFiles: readonly { name: string; type: string }[];
  /** What a missed request is recorded under when no region is on the screen. */
  screenId: string;
}

/** What a prompt bar's request came to: the answer for the user, the actions to run, and what became of the preview. */
export interface PlannedRequest {
  message: string;
  actionCalls: ActionCall[];
  previewOutcome: PlannedPreviewOutcome;
}

interface PreviewAcrossRegions {
  /** The requests whose answers make it up, oldest first. */
  requests: readonly PreviewRequest[];
  regionParts: {
    regionStore: RegionStore;
    operations: readonly Operation[];
    previewLayout: Layout;
    /** The version of the region's screen the preview was made on, kept for reporting it. */
    manifestVersion: string;
  }[];
}

/**
 * The regions one prompt bar speaks for, such as a page and the sidebar beside
 * it. A prompt is planned for all of them in one request, and what it changes
 * is previewed, kept, discarded and undone in all of them together, while each
 * region's layout is still stored on its own.
 *
 * A group of one is that region and nothing more: everything is passed
 * straight to its store.
 */
export class RegionGroup {
  private readonly singleRegionStore: RegionStore | null;
  private pendingPreview: PreviewAcrossRegions | null = null;
  /** The last preview saved, so an answer planned from it is shown on the layouts it became. */
  private lastSavedPreview: PreviewAcrossRegions | null = null;
  private commitInProgress: { preview: PreviewAcrossRegions; commitOutcome: Promise<{ applied: boolean }> } | null = null;
  private snapshotListeners = new Set<() => void>();
  private stopListeningToStores: (() => void) | null = null;
  private cachedSnapshot: RegionGroupSnapshot | null = null;
  private cachedSnapshotInputs: { storeSnapshots: readonly RegionSnapshot[]; previewing: boolean } | null = null;
  private serverSnapshot: RegionGroupSnapshot | null = null;

  constructor(
    private readonly regionStores: readonly RegionStore[],
    private readonly engine: EngineClient | null,
  ) {
    this.singleRegionStore = regionStores.length === 1 ? regionStores[0]! : null;
  }

  subscribe = (snapshotListener: () => void): (() => void) => {
    this.snapshotListeners.add(snapshotListener);
    if (!this.stopListeningToStores) {
      const stopListeningToEachStore = this.regionStores.map((regionStore) =>
        regionStore.subscribe(this.onStoreChange),
      );
      this.stopListeningToStores = () =>
        stopListeningToEachStore.forEach((stopListeningToStore) => stopListeningToStore());
    }
    return () => {
      this.snapshotListeners.delete(snapshotListener);
      this.stopListeningIfUnwatched();
    };
  };

  /**
   * Stops listening to the regions once nothing listens here. While a preview
   * waits it goes on listening, though the prompt bar may be gone, as one in a
   * closed sheet is: if a region then drops its part, as on leaving the page,
   * the preview is still reported as abandoned.
   */
  private stopListeningIfUnwatched(): void {
    if (this.snapshotListeners.size > 0 || this.pendingPreview) return;
    this.stopListeningToStores?.();
    this.stopListeningToStores = null;
  }

  getSnapshot = (): RegionGroupSnapshot => {
    const storeSnapshots = this.regionStores.map((regionStore) => regionStore.getSnapshot());
    const previewing = this.pendingPreview !== null;
    const cachedSnapshotInputs = this.cachedSnapshotInputs;
    if (
      !this.cachedSnapshot ||
      !cachedSnapshotInputs ||
      cachedSnapshotInputs.previewing !== previewing ||
      storeSnapshots.some((storeSnapshot, position) => storeSnapshot !== cachedSnapshotInputs.storeSnapshots[position])
    ) {
      this.cachedSnapshotInputs = { storeSnapshots, previewing };
      this.cachedSnapshot = this.computeSnapshot(storeSnapshots, previewing);
    }
    return this.cachedSnapshot;
  };

  getServerSnapshot = (): RegionGroupSnapshot =>
    (this.serverSnapshot ??= this.computeSnapshot(
      this.regionStores.map((regionStore) => regionStore.getServerSnapshot()),
      false,
    ));

  /**
   * Asks the engine to turn a request into operations and previews them, in
   * every region they are for. As for one region, a request made while a
   * preview is showing is planned from it, region by region, and its answer
   * is added to it; one made with none showing replaces any that appears
   * meanwhile, as if discarded.
   */
  planFromPrompt = async (prompt: string, viaVoice = false, planContext?: PlanContext): Promise<PlannedRequest> => {
    const offersActions = (planContext?.actions.length ?? 0) > 0;
    const previewRequest: PreviewRequest = { prompt, message: "", viaVoice };
    if (this.singleRegionStore && !offersActions) {
      const { planResponse, previewOutcome } = await this.singleRegionStore.planAndShowPreview(prompt, viaVoice);
      return {
        message: previewOutcome === "doesNotFit" ? PREVIEW_NO_LONGER_FITS_MESSAGE : planResponse.message,
        actionCalls: [],
        previewOutcome,
      };
    }
    const engine = requireEngine(this.engine, "Planning");
    const storesOnScreen = this.storesOnScreen();
    // A region of its own previews by itself; several share the group's preview.
    const singleStorePreview = this.singleRegionStore?.previewToBuildOn() ?? null;
    const groupPreview =
      this.pendingPreview && this.commitInProgress?.preview !== this.pendingPreview ? this.pendingPreview : null;
    const regionManifests = storesOnScreen.map((regionStore) => {
      const previewOperations = singleStorePreview
        ? singleStorePreview.planWith.operations
        : groupPreview?.regionParts.find((regionPart) => regionPart.regionStore === regionStore)?.operations;
      return {
        manifest: regionStore.getSnapshot().manifest!,
        ...regionStore.drawnColumnsToPlanWith(),
        ...(previewOperations && { preview: { operations: previewOperations, baseRevision: regionStore.savedRevision } }),
      };
    });
    // The first region on the screen, the one it is mainly about, speaks for the page; with none, the page's root does.
    const textDirection = storesOnScreen[0]?.textDirectionToPlanWith() ?? textDirectionToPlanWith(null);
    if (regionManifests.length === 0 && !offersActions) {
      throw new Error("No AdaptiveRegion is mounted, so there is nothing to plan");
    }
    const sendPlanRequest = () =>
      this.reloadingOnConflict(storesOnScreen, () =>
        engine.planAcrossRegions({
          regions: regionManifests,
          prompt,
          ...(viaVoice && { viaVoice: true }),
          ...textDirection,
          ...(planContext && {
            actions: planContext.actions,
            conversation: planContext.conversation,
            attachedFiles: planContext.attachedFiles,
            screenId: planContext.screenId,
          }),
        }),
      );
    const planResponse = this.singleRegionStore
      ? await this.singleRegionStore.answeringForPreview(singleStorePreview, sendPlanRequest)
      : await this.answeringForPreview(groupPreview, sendPlanRequest);
    previewRequest.message = planResponse.message;
    const actionCalls = planResponse.actionCalls ?? [];
    const answerThatDoesNotFit: PlannedRequest = {
      message: PREVIEW_NO_LONGER_FITS_MESSAGE,
      actionCalls: [],
      previewOutcome: "doesNotFit",
    };
    if (this.singleRegionStore) {
      const operations =
        planResponse.changes.find((change) => change.regionId === this.singleRegionStore!.regionId)?.operations ?? [];
      const previewOutcome = this.singleRegionStore.getSnapshot().manifest
        ? this.singleRegionStore.showPlannedPreview(operations, previewRequest, singleStorePreview)
        : "none";
      // Half of what was asked is not what was asked for, so no action goes ahead without its change.
      return previewOutcome === "doesNotFit" ? answerThatDoesNotFit : { message: planResponse.message, actionCalls, previewOutcome };
    }
    const operationsByRegion = new Map(
      planResponse.changes
        .filter(({ operations }) => operations.length > 0)
        .map(({ regionId, operations }) => [regionId, operations] as const),
    );
    let previewOutcome: PlannedPreviewOutcome;
    if (groupPreview && groupPreview === this.pendingPreview) {
      previewOutcome = this.addToPreview(groupPreview, operationsByRegion, previewRequest);
    } else if (groupPreview && groupPreview !== this.lastSavedPreview) {
      // The preview it was planned from went while the planner worked, and was
      // not saved, so the answer describes a screen that is no longer there.
      previewOutcome = "doesNotFit";
    } else {
      // One that is being saved is left to finish.
      if (this.pendingPreview && this.commitInProgress?.preview !== this.pendingPreview) this.discardPreview();
      previewOutcome = this.showNewPreview(operationsByRegion, previewRequest);
    }
    return previewOutcome === "doesNotFit" ? answerThatDoesNotFit : { message: planResponse.message, actionCalls, previewOutcome };
  };

  /** Previews the operations, in every region they are for, or none of them if any no longer fits. */
  private showNewPreview(
    operationsByRegion: ReadonlyMap<string, readonly Operation[]>,
    previewRequest: PreviewRequest,
  ): PlannedPreviewOutcome {
    const regionParts: PreviewAcrossRegions["regionParts"] = [];
    for (const [regionId, operations] of operationsByRegion) {
      const regionStore = this.regionStores.find((candidateStore) => candidateStore.regionId === regionId);
      if (!regionStore) continue;
      // A region can leave the screen while the planner works.
      const { manifest } = regionStore.getSnapshot();
      // Without the prompt: the group, not each region, reports the preview if it is not kept.
      const previewOutcome = manifest ? regionStore.previewOperations(operations) : null;
      if (!previewOutcome?.applied) {
        // Half a change is not what was asked for, so none of it is shown.
        for (const regionPart of regionParts) regionPart.regionStore.cancelPreview();
        return "doesNotFit";
      }
      regionParts.push({
        regionStore,
        operations,
        previewLayout: previewOutcome.layout,
        manifestVersion: manifest!.version,
      });
    }
    if (regionParts.length === 0) return "none";
    this.pendingPreview = { requests: [previewRequest], regionParts };
    this.notifyListeners();
    return "new";
  }

  /**
   * Adds a follow-up's operations to the preview it was planned from: each
   * region's after its part of the preview, in a region the preview had not
   * changed as its first part. Nothing changes if any region no longer fits.
   * A follow-up that takes the whole preview back leaves nothing to keep, so
   * the preview counts as discarded.
   */
  private addToPreview(
    preview: PreviewAcrossRegions,
    operationsByRegion: ReadonlyMap<string, readonly Operation[]>,
    previewRequest: PreviewRequest,
  ): PlannedPreviewOutcome {
    if (operationsByRegion.size === 0) return "none";
    const requests = [...preview.requests, previewRequest];
    const combinedParts: { regionStore: RegionStore; operations: readonly Operation[]; manifest: Manifest; changesScreen: boolean }[] = [];
    const regionIds = new Set([
      ...preview.regionParts.map((regionPart) => regionPart.regionStore.regionId),
      ...operationsByRegion.keys(),
    ]);
    for (const regionId of regionIds) {
      const regionStore = this.regionStores.find((candidateStore) => candidateStore.regionId === regionId);
      if (!regionStore) continue;
      const operations = [
        ...(preview.regionParts.find((regionPart) => regionPart.regionStore === regionStore)?.operations ?? []),
        ...(operationsByRegion.get(regionId) ?? []),
      ];
      const { manifest, layout } = regionStore.getSnapshot();
      if (!manifest || !layout) return "doesNotFit";
      const { applyOutcome } = regionStore.applyToCurrentLayout(operations);
      if (!applyOutcome.applied) return "doesNotFit";
      combinedParts.push({
        regionStore,
        operations,
        manifest,
        changesScreen: findChangedComponentIds(layout, applyOutcome.layout).size > 0,
      });
    }
    if (!combinedParts.some((combinedPart) => combinedPart.changesScreen)) {
      // Reported with the request that took it back, which is what turned it down.
      this.pendingPreview = { ...preview, requests };
      this.discardPreview();
      return "none";
    }
    // Taken off first, so the regions' previews changing under it does not count as leaving the screen.
    this.pendingPreview = null;
    const regionParts: PreviewAcrossRegions["regionParts"] = [];
    for (const { regionStore, operations, manifest } of combinedParts) {
      // Checked just above, against the same layout, so it applies.
      const previewOutcome = regionStore.previewOperations(operations);
      if (previewOutcome.applied) {
        regionParts.push({ regionStore, operations, previewLayout: previewOutcome.layout, manifestVersion: manifest.version });
      }
    }
    this.pendingPreview = { requests, regionParts };
    this.notifyListeners();
    return "addedTo";
  }

  /**
   * Sends a plan request made from `preview`. When the engine says the preview
   * no longer applies to the saved layouts it was made on, it can never be
   * saved, so it is taken off, as one that left the screen.
   */
  private async answeringForPreview<T>(preview: PreviewAcrossRegions | null, sendRequest: () => Promise<T>): Promise<T> {
    try {
      return await sendRequest();
    } catch (error) {
      if (preview && this.pendingPreview === preview && error instanceof EngineError && error.code === "invalid_operations") {
        this.abandonPreview();
      }
      throw error;
    }
  }

  /**
   * Saves the preview: every region's part, or none. Resolves to null when
   * there is no preview. One that no longer fits is taken off the screen.
   */
  commitPreview = async (): Promise<{ applied: boolean } | null> => {
    if (this.singleRegionStore) return this.singleRegionStore.commitPreview();
    const preview = this.pendingPreview;
    if (!preview) return null;
    // Asked twice for the same preview, it is still saved once.
    if (this.commitInProgress?.preview === preview) return this.commitInProgress.commitOutcome;
    const commitOutcome = this.savePreview(preview);
    this.commitInProgress = { preview, commitOutcome };
    try {
      const commitResult = await commitOutcome;
      if (commitResult.applied) this.lastSavedPreview = preview;
      else if (this.pendingPreview === preview) this.cancelPreview();
      return commitResult;
    } finally {
      if (this.commitInProgress?.preview === preview) this.commitInProgress = null;
      // A save that failed because a region changed elsewhere fetched that
      // region again, which took its part of the preview off the screen.
      if (this.pendingPreview === preview && !this.isStillShowing(preview)) this.cancelPreview();
    }
  };

  /** Takes the preview off the screen, in every region, without saving it. */
  cancelPreview = (): void => {
    if (this.singleRegionStore) return this.singleRegionStore.cancelPreview();
    const preview = this.pendingPreview;
    if (!preview) return this.stopListeningIfUnwatched();
    this.pendingPreview = null;
    for (const regionPart of preview.regionParts) {
      if (regionPart.regionStore.getSnapshot().preview === regionPart.previewLayout) {
        regionPart.regionStore.cancelPreview();
      }
    }
    this.notifyListeners();
    this.stopListeningIfUnwatched();
  };

  /** `cancelPreview`, for when the user chose not to keep it. The engine is told, once. */
  discardPreview = (): void => {
    if (this.singleRegionStore) return this.singleRegionStore.discardPreview();
    this.reportPreviewNotKept("discarded");
    this.cancelPreview();
  };

  /**
   * `cancelPreview`, for when the preview leaves the screen before the user
   * chose, because a region it changed dropped its part. The engine is told, once.
   */
  private abandonPreview(): void {
    this.reportPreviewNotKept("abandoned");
    this.cancelPreview();
  }

  /** Record-keeping only: the user is never made to wait on it or told it failed. One being saved is not reported. */
  private reportPreviewNotKept(outcome: PreviewNotKeptOutcome): void {
    const preview = this.pendingPreview;
    if (!preview || !this.engine || this.commitInProgress?.preview === preview) return;
    // A preview built up by follow-ups is reported as the one change it would have saved.
    const { prompt, message, viaVoice } = describePreviewRequests(preview.requests);
    void this.engine
      .reportDiscardedAcrossRegions({
        prompt,
        message,
        ...(viaVoice && { viaVoice: true }),
        ...(outcome === "abandoned" && { outcome }),
        regions: preview.regionParts.map((regionPart) => ({
          regionId: regionPart.regionStore.regionId,
          manifestVersion: regionPart.manifestVersion,
          operations: regionPart.operations,
        })),
      })
      .catch(() => {});
  }

  /**
   * Takes back the latest change among the regions on the screen, in each of
   * them it reached, on the screen or not: a prompt that changed two is undone
   * in both. The result says when part of it stays in place elsewhere.
   */
  undoLastChange = (): Promise<UndoResult> => {
    if (this.singleRegionStore) return this.singleRegionStore.undoLastChange();
    const regionStores = this.storesOnScreen();
    // A change not saved yet is known only to its own region, which takes it
    // back itself when it is the newest change among them all.
    const storeWithNewestUnsavedChange = regionStores.reduce<RegionStore | null>(
      (newestSoFar, regionStore) =>
        regionStore.newestUnsavedChangeSequence > (newestSoFar?.newestUnsavedChangeSequence ?? 0)
          ? regionStore
          : newestSoFar,
      null,
    );
    const newestSavedChangeSequence = Math.max(
      0,
      ...regionStores.map((regionStore) => regionStore.newestSavedChangeSequence),
    );
    if (
      storeWithNewestUnsavedChange &&
      storeWithNewestUnsavedChange.newestUnsavedChangeSequence > newestSavedChangeSequence
    ) {
      return storeWithNewestUnsavedChange.undoLastChange();
    }
    return this.oneWriteAtATime(
      regionStores,
      async () => {
        const engine = requireEngine(this.engine, "Undoing a change to several regions");
        const undoResponse = await this.reloadingOnConflict(regionStores, () =>
          engine.undoAcrossRegions(regionStores.map(regionAsLastSeen)),
        );
        this.acceptAnswer(regionStores, undoResponse, "undo");
        return undoResultOf(undoResponse);
      },
      "leave",
    );
  };

  /**
   * Shows every region as it first looked, before any change, without saving
   * anything, or goes back to their layouts. A preview, or any change, ends it.
   */
  showOriginal = (shown: boolean): void => {
    for (const regionStore of this.regionStores) regionStore.showOriginal(shown);
  };

  /**
   * Returns the screen to how it was after the given saved change; 0 is as it
   * was before any. Resolves to the number of the latest saved change afterwards.
   */
  restoreRevision = (revision: number): Promise<number> => {
    if (this.singleRegionStore) return this.singleRegionStore.restoreRevision(revision);
    const regionStores = this.storesOnScreen();
    return this.oneWriteAtATime(
      this.withUnsavedChanges(regionStores),
      async (laterChangeSequence) => {
        const engine = requireEngine(this.engine, "Restoring an earlier layout");
        this.acceptAnswer(
          regionStores,
          await this.reloadingOnConflict(regionStores, () =>
            engine.restoreAcrossRegions(revision, regionStores.map(regionAsLastSeen)),
          ),
          { laterChangeSequence },
        );
        return this.getSnapshot().revision;
      },
      "saveOrRefuse",
    );
  };

  /** Saved changes, newest first. For several regions each entry is one change, whichever regions it reached. */
  readHistory = (options: { limit: number; before?: number; promptedOnly?: boolean }): Promise<HistoryPage> => {
    if (this.singleRegionStore) return this.singleRegionStore.readHistory(options);
    return requireEngine(this.engine, "Reading the history").readChanges(
      this.storesOnScreen().map((regionStore) => regionStore.regionId),
      options,
    );
  };

  private savePreview(preview: PreviewAcrossRegions): Promise<{ applied: boolean }> {
    const regionStores = preview.regionParts.map((regionPart) => regionPart.regionStore);
    const { prompt, message, viaVoice } = describePreviewRequests(preview.requests);
    return this.oneWriteAtATime(this.withUnsavedChanges(regionStores), async (laterChangeSequence) => {
      const engine = requireEngine(this.engine, "Saving a change to several regions");
      const regionChanges: Parameters<EngineClient["saveChangeAcrossRegions"]>[0]["regions"] = [];
      for (const regionPart of preview.regionParts) {
        // The preview was worked out before its turn came, so it is checked again.
        if (!regionPart.regionStore.getSnapshot().manifest) return { applied: false };
        const { manifest, applyOutcome } = regionPart.regionStore.applyToCurrentLayout(regionPart.operations);
        if (!applyOutcome.applied) return { applied: false };
        regionChanges.push({
          manifest,
          operations: regionPart.operations,
          baseRevision: regionPart.regionStore.savedRevision,
        });
      }
      let savedLayouts: RegionLayoutsResponse;
      try {
        savedLayouts = await this.reloadingOnConflict(regionStores, () =>
          engine.saveChangeAcrossRegions({
            regions: regionChanges,
            prompt,
            message,
            ...(viaVoice && { viaVoice: true }),
          }),
        );
      } catch (error) {
        if (error instanceof EngineError && error.code === "invalid_operations") return { applied: false };
        throw error;
      }
      if (this.pendingPreview === preview) this.pendingPreview = null;
      this.acceptAnswer(regionStores, savedLayouts, { laterChangeSequence }, (regionStore) =>
        preview.regionParts.find((regionPart) => regionPart.regionStore === regionStore)!.operations,
      );
      return { applied: true };
    }, "saveOrRefuse");
  }

  /**
   * Shows what the engine answered, in each of `regionStores` whose layout it
   * changed, with the operations that changed it. Every other region, one off
   * the screen as well, gives way to it, unless it is an undo, which is no new
   * change. A preview no longer describes the screen.
   */
  private acceptAnswer(
    regionStores: readonly RegionStore[],
    regionLayouts: RegionLayoutsResponse,
    layoutSource: Exclude<SavedLayoutSource, "read" | "savedUnsavedChange">,
    operationsFor: (regionStore: RegionStore) => readonly Operation[] = () => [],
  ): void {
    this.cancelPreview();
    for (const regionStore of this.regionStores) {
      const layoutResponse = regionStores.includes(regionStore)
        ? regionLayouts.regions.find((region) => region.regionId === regionStore.regionId)
        : undefined;
      if (layoutResponse && layoutResponse.revision !== regionStore.savedRevision) {
        regionStore.acceptSavedLayout(layoutResponse, operationsFor(regionStore), layoutSource);
      } else if (layoutSource !== "undo") {
        regionStore.giveWayToLaterChange(layoutSource.laterChangeSequence);
      }
    }
    this.notifyListeners();
  }

  /** `regionStores` and every other region of the group holding changes not saved yet, which go first. */
  private withUnsavedChanges(regionStores: readonly RegionStore[]): RegionStore[] {
    return this.regionStores.filter(
      (regionStore) => regionStores.includes(regionStore) || regionStore.hasSaveableUnsavedChanges,
    );
  }

  /**
   * When the engine says a region changed elsewhere, nothing was saved in any
   * of them. The ones it names are fetched again before failing, which takes
   * the preview off the screen.
   */
  private async reloadingOnConflict<T>(
    regionStores: readonly RegionStore[],
    sendRequest: () => Promise<T>,
  ): Promise<T> {
    try {
      return await sendRequest();
    } catch (error) {
      if (error instanceof EngineError && error.code === "conflict") {
        const changedStores = regionStores.filter(
          (regionStore) => error.regionIds?.includes(regionStore.regionId) ?? true,
        );
        await Promise.all(
          (changedStores.length > 0 ? changedStores : regionStores).map((regionStore) =>
            regionStore.loadSavedLayout().catch(() => {}),
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Waits its turn in every one of the regions, so a change to several does
   * not cross one made to any of them alone. Turns are always taken in the
   * same order, so two groups that share regions cannot wait on each other.
   * `writeChange` is given the change's `sequence`, taken once the first turn has
   * begun: a change made in any of the regions while it waits for the others
   * is newer than it.
   */
  private oneWriteAtATime<T>(
    regionStores: readonly RegionStore[],
    writeChange: (laterChangeSequence: number) => Promise<T>,
    unsavedChangesFirst: UnsavedChangesFirst,
  ): Promise<T> {
    const turnOrder = [...regionStores].sort((firstStore, secondStore) =>
      firstStore.regionId < secondStore.regionId ? -1 : 1,
    );
    let laterChangeSequence = 0;
    const takeTurns = turnOrder.reduceRight<() => Promise<T>>(
      (takeRemainingTurns, regionStore, position) => () =>
        regionStore.oneWriteAtATime(
          position === 0
            ? () => {
                // They all share one count.
                laterChangeSequence = regionStore.takeChangeSequence();
                return takeRemainingTurns();
              }
            : takeRemainingTurns,
          unsavedChangesFirst,
        ),
      () => writeChange(laterChangeSequence),
    );
    return takeTurns();
  }

  private storesOnScreen(): RegionStore[] {
    return this.regionStores.filter((regionStore) => regionStore.getSnapshot().manifest !== null);
  }

  private onStoreChange = (): void => {
    // A region drops its preview when its components change or its layout is
    // fetched again. The rest of the change then goes with it.
    const preview = this.pendingPreview;
    if (preview && this.commitInProgress?.preview !== preview && !this.isStillShowing(preview)) {
      this.abandonPreview();
      return;
    }
    this.notifyListeners();
  };

  private isStillShowing(preview: PreviewAcrossRegions): boolean {
    return preview.regionParts.every(
      (regionPart) => regionPart.regionStore.getSnapshot().preview === regionPart.previewLayout,
    );
  }

  private notifyListeners(): void {
    for (const snapshotListener of [...this.snapshotListeners]) snapshotListener();
  }

  private computeSnapshot(storeSnapshots: readonly RegionSnapshot[], previewing: boolean): RegionGroupSnapshot {
    const regionSnapshots = this.regionStores.map((regionStore, position) => ({
      regionId: regionStore.regionId,
      snapshot: storeSnapshots[position]!,
    }));
    if (this.singleRegionStore) {
      const [singleRegionSnapshot] = storeSnapshots as [RegionSnapshot];
      return {
        regions: regionSnapshots,
        previewing: singleRegionSnapshot.preview !== null,
        showingOriginal: singleRegionSnapshot.original !== null,
        differsFromOriginal: singleRegionSnapshot.differsFromOriginal,
        canUndo: singleRegionSnapshot.canUndo,
        newestChangeSequence: this.singleRegionStore.newestChangeSequence,
        loading: singleRegionSnapshot.loading,
        loadFailed: singleRegionSnapshot.loadFailed,
        revision: singleRegionSnapshot.revision,
        hasHistory: singleRegionSnapshot.hasHistory,
        hasUnsavedChanges: singleRegionSnapshot.hasUnsavedChanges,
      };
    }
    const snapshotsOnScreen = storeSnapshots.filter((storeSnapshot) => storeSnapshot.manifest !== null);
    const storesOnScreen = this.regionStores.filter((_, position) => storeSnapshots[position]!.manifest !== null);
    return {
      regions: regionSnapshots,
      previewing,
      showingOriginal: snapshotsOnScreen.some((storeSnapshot) => storeSnapshot.original !== null),
      differsFromOriginal: snapshotsOnScreen.some((storeSnapshot) => storeSnapshot.differsFromOriginal),
      // Which region was changed last is something only the engine knows.
      canUndo: this.engine !== null && snapshotsOnScreen.some((storeSnapshot) => storeSnapshot.canUndo),
      newestChangeSequence: Math.max(0, ...storesOnScreen.map((regionStore) => regionStore.newestChangeSequence)),
      loading: snapshotsOnScreen.some((storeSnapshot) => storeSnapshot.loading),
      loadFailed: snapshotsOnScreen.some((storeSnapshot) => storeSnapshot.loadFailed),
      revision: Math.max(0, ...storesOnScreen.map((regionStore) => regionStore.latestChangeId)),
      hasHistory: this.engine !== null,
      hasUnsavedChanges: snapshotsOnScreen.some((storeSnapshot) => storeSnapshot.hasUnsavedChanges),
    };
  }
}

function regionAsLastSeen(regionStore: RegionStore) {
  return { regionId: regionStore.regionId, baseRevision: regionStore.savedRevision };
}
