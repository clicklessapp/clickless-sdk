import {
  applyOperations,
  defaultLayout,
  type Layout,
  reconcileLayout,
  validateOperations,
  type ApplyOperationsOutcome,
  type Component,
  type LayoutChange,
  type Manifest,
  type Operation,
} from "@clickless/core";
import {
  EngineError,
  engineUnreachableError,
  requireEngine,
  type EngineClient,
  type PreviewNotKeptOutcome,
  type PreviewToPlanFrom,
} from "../engine/engineClient";
import type { HistoryPage, LayoutResponse, PlanResponse, UndoneChange } from "../engine/engineResponses";
import { PREVIEW_NO_LONGER_FITS_MESSAGE } from "../engine/engineErrorMessages";
import { findChangedComponentIds } from "./changedComponentIds";
import type { RegionSnapshot } from "./regionSnapshot";
import { describePreviewRequests, type PreviewRequest } from "./previewRequests";
import { parseSavedLayout } from "./savedLayoutParsing";
import { Retrier } from "./retrier";
import { textDirectionToPlanWith } from "./textDirection";
import { UnsavedChangeSaver } from "./unsavedChangeSaver";
import { UnsavedChangeList } from "./unsavedChanges";

/** How an undo went. */
export interface UndoResult {
  /**
   * True when part of the undone change stays in place in a region this undo
   * was not asked about, such as one on another page, because that region
   * changed again since.
   */
  keptElsewhere: boolean;
  /** The change taken back, or null when that is not known, as from an engine that does not say. */
  undoneChange: UndoneChange | null;
}

/** An undo that took back the whole of `undoneChange`. */
const undoneWhole = (undoneChange: UndoneChange | null): UndoResult => ({ keptElsewhere: false, undoneChange });

/**
 * What became of the preview when a planner's answer came: a new one shows,
 * holding that answer only; the answer was added to the one showing; nothing
 * is shown for it, as for a question or a preview taken back whole; or it no
 * longer fits the screen, and any preview showing is left as it was.
 */
export type PlannedPreviewOutcome = "new" | "addedTo" | "none" | "doesNotFit";

/** A preview a prompt is planned from, taken as planning starts. */
export interface PreviewToBuildOn {
  /** Handed back to `showPlannedPreview`, so the answer is added to this preview and no other. */
  readonly handle: PendingPreview;
  /** What the plan request carries of it. */
  readonly planWith: PreviewToPlanFrom;
}

/** A change shown and not saved yet. Only the region's own store reads inside it. */
export interface PendingPreview {
  layout: Layout;
  operations: readonly Operation[];
  /** The requests whose answers make it up, oldest first; none for one that did not come from a prompt. */
  requests: readonly PreviewRequest[];
}

/** What an engine's answer to an undo says about how it went. */
export const undoResultOf = (undoAnswer: { notUndoneIn?: string[]; undone?: unknown }): UndoResult => {
  const { undone } = undoAnswer;
  const undoneIsReadable =
    typeof undone === "object" &&
    undone !== null &&
    "kind" in undone &&
    (undone.kind === "apply" || undone.kind === "restore") &&
    "prompt" in undone &&
    (undone.prompt === null || typeof undone.prompt === "string") &&
    "operations" in undone &&
    Array.isArray(undone.operations);
  return {
    keptElsewhere: (undoAnswer.notUndoneIn?.length ?? 0) > 0,
    undoneChange: undoneIsReadable ? (undone as UndoneChange) : null,
  };
};

export interface RegionConfig {
  regionId: string;
  version: string;
  columns: number;
  title?: string;
  /** Present, as false, only for a region that draws no grid of its own. */
  grid?: false;
}

export type LayoutChangeHandler = (layout: Layout, operations: readonly Operation[]) => void;

/**
 * What a turn to write does first with the changes not saved yet: send them,
 * send them and refuse to go on if any could not be saved, or leave them.
 */
export type UnsavedChangesFirst = "save" | "saveOrRefuse" | "leave";

/**
 * Where a layout the engine gave came from: a fresh read, the saving of a
 * change not saved yet, an undo, or a change saved by prompt or restore, with
 * the `sequence` it took when it began.
 */
export type SavedLayoutSource = "read" | "savedUnsavedChange" | "undo" | { laterChangeSequence: number };

const NO_CHANGED_COMPONENT_IDS: ReadonlySet<string> = new Set();
const NO_LAYOUT_CHANGES: readonly LayoutChange[] = [];
const EMPTY_REGION_SNAPSHOT: RegionSnapshot = {
  manifest: null,
  layout: null,
  preview: null,
  original: null,
  differsFromOriginal: false,
  changedComponentIds: NO_CHANGED_COMPONENT_IDS,
  savedLayoutAdjustments: NO_LAYOUT_CHANGES,
  loading: false,
  loadFailed: false,
  canUndo: false,
  revision: 0,
  hasHistory: false,
  hasUnsavedChanges: false,
};

/**
 * Holds one region's state. With an engine, every committed change is sent to
 * it and its answer is the truth; without one, changes live in memory only.
 *
 * A change made with the application's own controls (one without a prompt)
 * never waits on the engine: it is shown at once and saved behind the scenes.
 * While the engine cannot be reached it is kept for the visit and saved when
 * the engine is back, unless what it changed reads differently in the saved
 * layout by then (see `carryOverUnsavedChanges`). Changes reach the engine in
 * the order they were made: a prompt's change or a restore waits for the
 * older ones to be saved, and is refused if they cannot be. An undo leaves
 * them, since it takes the newest back itself when that is one of them.
 */
export class RegionStore {
  onLayoutChange: LayoutChangeHandler | undefined;
  /**
   * The columns this screen draws the layout in, set by the region as the
   * screen's width changes. The planner is told when they are fewer than the
   * layout's, so its replies describe what the user sees.
   */
  drawnColumns: number | null = null;

  private regionConfig: RegionConfig | null = null;
  private registeredComponents = new Map<string, { component: Component; element: Element | null }>();
  private savedLayout: Layout | null = null;
  private pendingPreview: PendingPreview | null = null;
  /** The last preview saved, so an answer planned from it is shown on the layout it became. */
  private lastSavedPreview: PendingPreview | null = null;
  /** True while the region shows how it first looked in place of the layout. */
  private originalShown = false;
  private snapshotListeners = new Set<() => void>();
  private savedLayoutListeners = new Set<() => void>();
  private cachedSnapshot: RegionSnapshot | null = EMPTY_REGION_SNAPSHOT;

  private latestSavedRevision = 0;
  private latestSavedChangeId = 0;
  private savedLayoutLoading = false;
  private loadFailed = false;
  private loadStarted = false;
  private engineAnswered = false;
  private commitInProgress: { preview: PendingPreview; applyOutcome: Promise<ApplyOperationsOutcome> } | null = null;
  private engineCanUndo = false;
  /** Without an engine: the layout before each change, and the change, oldest first. */
  private undoStack: { layout: Layout | null; change: UndoneChange }[] = [];
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** Shown on top of `savedLayout`. Only ever holds anything with an engine. */
  private readonly unsavedChanges: UnsavedChangeList;
  /** The `sequence` of each saved change an undo here could take back, oldest first. */
  private savedChangeSequences: number[] = [];
  private stopListeningToReachability: (() => void) | null = null;
  private readonly loadRetrier = new Retrier(() => {
    if (this.needsLoadRetry) this.startLoading();
  });
  private readonly unsavedChangeSaver = new UnsavedChangeSaver({
    nextChangeToSave: () => this.unsavedChanges.nextToSave(),
    prepareToSave: async () => {
      // Unsaved changes made before the engine ever answered are first carried
      // over to its layout by loading it, which keeps back any that would
      // overwrite what it holds.
      if (this.engineAnswered) return;
      this.loadStarted = true;
      try {
        await this.loadSavedLayout();
      } catch (error) {
        if (!this.engineAnswered) {
          this.loadStarted = false;
          this.loadFailed = true;
          this.loadRetrier.schedule();
        }
        throw error;
      }
    },
    sendChange: (change) => {
      const { manifest } = this.getSnapshot();
      // A change to a component that has since left the screen, as on another
      // tab, is sent with the screen it was made on, which still has it.
      const fitsScreenNow =
        manifest &&
        !validateOperations(manifest, change.operations).some(
          (operationError) => operationError.code === "unknown_component",
        );
      return this.engine!.applyOperations(this.regionId, {
        manifest: fitsScreenNow ? manifest : change.manifest,
        operations: change.operations,
        baseRevision: this.latestSavedRevision,
      });
    },
    reloadSavedLayout: () => this.loadSavedLayout(),
    changeSaved: (change, layoutResponse) => {
      this.unsavedChanges.dropSavedChange(change);
      this.recordSavedChange(change.sequence);
      this.acceptEngineLayout(layoutResponse, "savedUnsavedChange");
      this.notifyListeners();
    },
    queueSaving: () => this.queueSavingUnsavedChanges(),
  });

  /**
   * `nextChangeSequence` numbers changes across the regions of one provider, so the
   * newest among several regions can be told.
   */
  constructor(
    readonly regionId: string,
    private readonly engine: EngineClient | null,
    private readonly nextChangeSequence: () => number,
  ) {
    this.unsavedChanges = new UnsavedChangeList(nextChangeSequence);
    this.listenToReachability();
  }

  /** Anything else getting an answer is a sign the engine is back: what waits to be tried again is tried now. */
  private listenToReachability(): void {
    const engine = this.engine;
    if (!engine || this.stopListeningToReachability) return;
    this.stopListeningToReachability = engine.subscribeToReachability(() => {
      if (!engine.isReachable) return;
      this.unsavedChangeSaver.retryNow();
      this.loadRetrier.retryNow();
    });
  }

  /** The `sequence` of the newest change not saved yet, or 0 when there is none. */
  get newestUnsavedChangeSequence(): number {
    return this.unsavedChanges.newestSequence;
  }

  /** True while a change not saved yet may still be saved, whether or not the region is on the screen. */
  get hasSaveableUnsavedChanges(): boolean {
    return this.unsavedChanges.hasSaveable;
  }

  /**
   * The `sequence` of the newest change here an undo could take back, saved or
   * not, or 0 when there is none from this visit.
   */
  get newestChangeSequence(): number {
    return Math.max(this.newestSavedChangeSequence, this.newestUnsavedChangeSequence);
  }

  /** The highest `sequence` among the saved changes here that an undo could still take back, or 0. */
  get newestSavedChangeSequence(): number {
    return Math.max(0, ...this.savedChangeSequences);
  }

  /** Kept in the order the engine took them, so an undo takes the last off as the engine does. */
  private recordSavedChange(sequence: number): void {
    this.savedChangeSequences.push(sequence);
  }

  /** A `sequence` for a change saved by prompt or restore, taken when it begins. */
  takeChangeSequence = (): number => this.nextChangeSequence();

  /** True when the newest change here is one not saved yet, which only this screen can take back. */
  private newestChangeIsUnsaved(): boolean {
    return this.unsavedChanges.newestSequence > this.newestSavedChangeSequence;
  }

  /** True when the saved layout of a region on the screen could not be read, and no read is under way. */
  private get needsLoadRetry(): boolean {
    return this.loadFailed && !this.loadStarted && this.regionConfig !== null;
  }

  /** The number of the latest saved change, as the engine last gave it. */
  get savedRevision(): number {
    return this.latestSavedRevision;
  }

  /** The number, counted across all the user's regions, of the change that made the latest revision. */
  get latestChangeId(): number {
    return this.latestSavedChangeId;
  }

  subscribe = (snapshotListener: () => void): (() => void) => {
    this.snapshotListeners.add(snapshotListener);
    return () => this.snapshotListeners.delete(snapshotListener);
  };

  getSnapshot = (): RegionSnapshot => (this.cachedSnapshot ??= this.computeSnapshot());

  getServerSnapshot = (): RegionSnapshot => EMPTY_REGION_SNAPSHOT;

  /** A layout set earlier in the session wins over `initialLayout`, so it survives a remount. */
  mountRegion = (mountedRegionConfig: RegionConfig, initialLayout: Layout | undefined): (() => void) => {
    this.regionConfig = mountedRegionConfig;
    // Once the engine has answered, its copy stands, even when that is the default.
    if (!this.engineAnswered) this.savedLayout ??= parseSavedLayout(initialLayout);
    if (this.engine && !this.loadStarted) this.startLoading();
    // Mounted again, as on coming back to a page: the layout may have changed
    // while it was away, by an undo on another page or in another tab.
    // So may one read ahead of time; it keeps showing what was read meanwhile.
    else if (this.engine && this.engineAnswered && !this.savedLayoutLoading) this.refreshSavedLayout();
    this.dropPendingPreview();
    return () => {
      // Read before it goes: the engine is told which version of the screen the preview was on.
      const { manifest } = this.getSnapshot();
      this.regionConfig = null;
      this.dropPendingPreview(manifest);
    };
  };

  /** Reads the saved layout before the region mounts, unless it has been read or is being read. */
  preloadSavedLayout = (): void => {
    if (this.engine && !this.loadStarted) this.startLoading();
  };

  private startLoading(): void {
    this.loadStarted = true;
    this.savedLayoutLoading = true;
    // Changes wait for this, so none is made against a layout the engine does
    // not have. It waits its own turn too: after a failed first try, a change
    // may already be on its way.
    this.writeQueue = this.writeQueue
      .then(() => this.loadSavedLayout())
      .catch(() => {
        // The region keeps the layout it has and says so through `loadFailed`.
        // It tries again a little later, when the engine answers anything, or
        // the next time it mounts.
        this.loadFailed = true;
        this.loadStarted = false;
        this.loadRetrier.schedule();
        this.notifyListeners();
      });
  }

  /** Reads the engine's copy again. If that fails, the region keeps the layout it has. */
  private refreshSavedLayout(): void {
    this.writeQueue = this.writeQueue.then(() => this.loadSavedLayout()).catch(() => {});
  }

  /** The element an item is drawn in, or null if it is not mounted. */
  elementOf = (componentId: string): Element | null =>
    this.registeredComponents.get(componentId)?.element ?? null;

  /** Which way the page reads where this region is drawn, as a plan request carries it. */
  textDirectionToPlanWith = (): ReturnType<typeof textDirectionToPlanWith> => {
    const drawnElement = [...this.registeredComponents.values()].find(({ element }) => element)?.element;
    return textDirectionToPlanWith(drawnElement);
  };

  /** What the planner is told about the screen besides the manifest: only what differs from a wide one. */
  drawnColumnsToPlanWith = (): { drawnColumns?: number } => {
    const layoutColumns = this.regionConfig?.columns;
    return this.drawnColumns !== null && layoutColumns !== undefined && this.drawnColumns < layoutColumns
      ? { drawnColumns: this.drawnColumns }
      : {};
  };

  registerComponent = (component: Component, element: Element | null): (() => void) => {
    this.registeredComponents.set(component.id, { component, element });
    this.dropPendingPreview();
    return () => {
      if (this.registeredComponents.get(component.id)?.component === component) {
        this.registeredComponents.delete(component.id);
        this.dropPendingPreview();
      }
    };
  };

  /**
   * Validates the operations and commits them if all are valid.
   *
   * A change from a prompt is shown once the engine has saved it, and rejects
   * with an `EngineError` if the engine cannot be reached or the layout changed
   * elsewhere. A change without a prompt, as from the application's own
   * controls, is shown and resolves at once, and is saved behind the scenes:
   * later, if the engine cannot be reached.
   */
  applyOperations = (
    operations: readonly Operation[],
    prompt?: string,
    message?: string,
    viaVoice = false,
  ): Promise<ApplyOperationsOutcome> => {
    // The change is for the screen as it is now. If the region has gone by the
    // time its turn comes, it is still made, against the components it had.
    const { manifest: fallbackManifest } = this.getSnapshot();
    if (this.engine && prompt === undefined) return this.applyAtOnce(operations, fallbackManifest);
    return this.oneWriteAtATime(async () => {
      const laterChangeSequence = this.nextChangeSequence();
      const { manifest, applyOutcome } = this.applyToCurrentLayout(operations, fallbackManifest);
      if (!applyOutcome.applied) return applyOutcome;

      let committedLayout = applyOutcome.layout;
      const engine = this.engine;
      if (engine) {
        try {
          const layoutResponse = await this.reloadingOnConflict(() =>
            engine.applyOperations(this.regionId, {
              manifest,
              operations,
              ...(prompt !== undefined && { prompt }),
              ...(message !== undefined && { message }),
              baseRevision: this.latestSavedRevision,
              ...(viaVoice && { viaVoice: true }),
            }),
          );
          this.acceptEngineLayout(layoutResponse, { laterChangeSequence });
          committedLayout = this.savedLayout ?? committedLayout;
        } catch (error) {
          if (error instanceof EngineError && error.code === "invalid_operations" && error.errors) {
            return { applied: false, errors: error.errors };
          }
          throw error;
        }
      } else {
        this.undoStack.push({
          layout: this.savedLayout,
          change: { kind: "apply", prompt: prompt ?? null, operations: [...operations] },
        });
        this.savedLayout = committedLayout;
        this.recordSavedChange(laterChangeSequence);
      }
      this.pendingPreview = null;
      this.notifyListeners();
      this.reportLayoutChange(committedLayout, operations);
      return { applied: true, layout: committedLayout };
    }, "saveOrRefuse");
  };

  /**
   * `applyOperations` for a change that is shown before the engine has it.
   * Async so that a fault, such as a region that is not mounted, rejects as it
   * does for every other change.
   */
  private async applyAtOnce(operations: readonly Operation[], fallbackManifest: Manifest | null): Promise<ApplyOperationsOutcome> {
    const { manifest, applyOutcome } = this.applyToCurrentLayout(operations, fallbackManifest);
    if (!applyOutcome.applied) return applyOutcome;
    this.unsavedChanges.add(operations, manifest);
    const shownLayout = this.showChange(operations) ?? applyOutcome.layout;
    // Nothing waits for it to be saved.
    this.queueSavingUnsavedChanges();
    return { applied: true, layout: shownLayout };
  }

  /**
   * Sends the changes not saved yet to the engine, oldest first. Run at the
   * start of each turn to write but an undo's (see `oneWriteAtATime`), so they
   * reach the engine before anything made after them. Never rejects: what
   * could not be saved is tried again later.
   */
  private async saveUnsavedChanges(): Promise<void> {
    if (!this.engine || !this.unsavedChanges.hasSaveable) return;
    await this.unsavedChangeSaver.save();
    this.notifyListeners();
  }

  /**
   * Drops the changes kept for this visit only that are older than a change
   * saved by prompt or restore in another region of the same prompt box,
   * which did not reach this one. They would otherwise be undone before it.
   */
  giveWayToLaterChange = (laterChangeSequence: number): void => {
    if (this.unsavedChanges.giveWayTo(laterChangeSequence)) this.showChange();
  };

  /**
   * Stops trying the engine again in the background, to save changes or to
   * read the saved layout, for when the provider holding this store has gone.
   */
  dispose = (): void => {
    this.unsavedChangeSaver.stop();
    this.loadRetrier.stop();
    this.stopListeningToReachability?.();
    this.stopListeningToReachability = null;
  };

  /** Takes up what `dispose` stopped, as when React mounts the provider once more. */
  resume = (): void => {
    this.listenToReachability();
    this.unsavedChangeSaver.start();
    this.loadRetrier.start();
    if (this.needsLoadRetry) this.loadRetrier.schedule();
  };

  /** A turn to write with nothing of its own to write: it saves what is not saved yet, in turn. */
  private queueSavingUnsavedChanges(): void {
    void this.oneWriteAtATime(async () => {});
  }

  /** Shows the result of the operations without committing it. */
  previewOperations = (
    operations: readonly Operation[],
    prompt?: string,
    message?: string,
    viaVoice = false,
  ): ApplyOperationsOutcome => {
    const { applyOutcome } = this.applyToCurrentLayout(operations);
    if (applyOutcome.applied) {
      this.showPreview(applyOutcome.layout, operations, prompt === undefined ? [] : [{ prompt, message: message ?? "", viaVoice }]);
    }
    return applyOutcome;
  };

  private showPreview(layout: Layout, operations: readonly Operation[], requests: readonly PreviewRequest[]): void {
    this.originalShown = false;
    this.pendingPreview = { layout, operations, requests };
    this.notifyListeners();
  }

  /**
   * Saves the preview. Resolves to null when there is none. A preview that
   * turns out not to be valid is taken off the screen, since it can never be saved.
   */
  commitPreview = async (): Promise<ApplyOperationsOutcome | null> => {
    const preview = this.pendingPreview;
    if (!preview) return null;
    // Asked twice for the same preview, it is still saved once.
    if (this.commitInProgress?.preview === preview) return this.commitInProgress.applyOutcome;
    const changeDescription = preview.requests.length > 0 ? describePreviewRequests(preview.requests) : null;
    const applyOutcome = this.applyOperations(
      preview.operations,
      changeDescription?.prompt,
      changeDescription?.message,
      changeDescription?.viaVoice ?? false,
    );
    this.commitInProgress = { preview, applyOutcome };
    try {
      const { applied } = await applyOutcome;
      if (applied) this.lastSavedPreview = preview;
      else if (this.pendingPreview === preview) this.cancelPreview();
      return await applyOutcome;
    } finally {
      if (this.commitInProgress?.preview === preview) this.commitInProgress = null;
    }
  };

  /**
   * Shows the region as it first looked, before any change, without saving
   * anything, or goes back to its layout. A preview, or any change to the
   * layout, ends it.
   */
  showOriginal = (shown: boolean): void => {
    if (this.originalShown === shown) return;
    this.originalShown = shown;
    this.notifyListeners();
  };

  /** Takes the preview off the screen without saving it. */
  cancelPreview = (): void => {
    if (!this.pendingPreview) return;
    this.pendingPreview = null;
    this.notifyListeners();
  };

  /**
   * `cancelPreview`, for when the user themselves chose not to keep it. The
   * engine is told, so the application's team can see where a prompt's result
   * was not what its user meant. A preview that did not come from a prompt has
   * nothing to say about that and is only cancelled, as is one that is already
   * being saved.
   */
  discardPreview = (): void => {
    this.reportPreviewNotKept("discarded");
    this.cancelPreview();
  };

  /**
   * Tells the engine the preview from a prompt was not kept. One that is being
   * saved is not reported. Record-keeping only: the user is never made to wait
   * on it or told it failed.
   */
  private reportPreviewNotKept(
    outcome: PreviewNotKeptOutcome,
    manifest: Manifest | null = this.getSnapshot().manifest,
  ): void {
    const preview = this.pendingPreview;
    if (!preview || this.commitInProgress?.preview === preview) return;
    if (!this.engine || !manifest || preview.requests.length === 0) return;
    // A preview built up by follow-ups is reported as the one change it would have saved.
    const { prompt, message, viaVoice } = describePreviewRequests(preview.requests);
    void this.engine
      .reportDiscardedPreview(this.regionId, {
        manifestVersion: manifest.version,
        prompt,
        message,
        operations: preview.operations,
        ...(viaVoice && { viaVoice: true }),
        ...(outcome === "abandoned" && { outcome }),
      })
      .catch(() => {});
  }

  /**
   * Returns to the layout before the last committed change. A change not saved
   * yet is taken back at once, on this screen alone, as the engine never had it.
   */
  undoLastChange = (): Promise<UndoResult> => {
    const unsavedChangeTakenBack = this.takeBackUnsavedChange();
    if (unsavedChangeTakenBack) return Promise.resolve(undoneWhole(unsavedChangeTakenBack));
    // One being saved right now is waited for: if it was saved, it is undone there.
    return this.oneWriteAtATime(async () => {
      const unsavedChangeTakenBackSince = this.takeBackUnsavedChange();
      if (unsavedChangeTakenBackSince) return undoneWhole(unsavedChangeTakenBackSince);
      const engine = this.engine;
      let undoResult: UndoResult;
      if (engine) {
        const undoResponse = await this.reloadingOnConflict(() =>
          engine.undoLastChange(this.regionId, this.latestSavedRevision),
        );
        this.acceptEngineLayout(undoResponse, "undo");
        undoResult = undoResultOf(undoResponse);
      } else {
        const undoneStep = this.undoStack.pop();
        if (!undoneStep) return undoneWhole(null);
        this.savedLayout = undoneStep.layout;
        this.savedChangeSequences.pop();
        undoResult = undoneWhole(undoneStep.change);
      }
      this.showChange();
      return undoResult;
    }, "leave");
  };

  /**
   * Takes back the newest change, if it is one not saved yet and not on its
   * way to the engine. Returns it, or null when there was none to take back.
   */
  private takeBackUnsavedChange(): UndoneChange | null {
    if (!this.newestChangeIsUnsaved()) return null;
    const changeTakenBack = this.unsavedChanges.takeBackNewest(this.unsavedChangeSaver.changeBeingSaved);
    if (!changeTakenBack) return null;
    if (!this.unsavedChanges.hasSaveable) this.unsavedChangeSaver.cancelRetry();
    this.showChange();
    return { kind: "apply", prompt: null, operations: [...changeTakenBack.operations] };
  }

  /**
   * Puts a committed change on the screen: any preview goes, and the host is
   * told. Returns the layout shown, or null when the region is not mounted.
   */
  private showChange(operations: readonly Operation[] = []): Layout | null {
    this.pendingPreview = null;
    this.originalShown = false;
    this.notifyListeners();
    const { layout } = this.getSnapshot();
    if (layout) this.reportLayoutChange(layout, operations);
    return layout;
  }

  /**
   * Returns the screen to how it was after the given saved change; 0 is the
   * original layout. Later changes stay in the history. Resolves to the number
   * of the saved change the restore itself made.
   */
  restoreRevision = (revision: number): Promise<number> =>
    this.oneWriteAtATime(async () => {
      const engine = requireEngine(this.engine, "Restoring an earlier layout");
      const laterChangeSequence = this.nextChangeSequence();
      this.acceptEngineLayout(
        await this.reloadingOnConflict(() => engine.restoreRevision(this.regionId, revision, this.latestSavedRevision)),
        { laterChangeSequence },
      );
      this.showChange();
      return this.latestSavedRevision;
    }, "saveOrRefuse");

  /**
   * Saved changes, newest first, `limit` at a time. Pass `before` to read older
   * ones, and `promptedOnly` to leave out changes that were not made by prompt.
   */
  readHistory = (options: {
    limit: number;
    before?: number;
    promptedOnly?: boolean;
  }): Promise<HistoryPage> =>
    requireEngine(this.engine, "Reading the history").readHistory(this.regionId, options);

  /**
   * Asks the engine to turn a request into operations and previews them.
   * The returned message is written for the user.
   *
   * A request made while a preview is showing is planned from that preview,
   * so a follow-up such as "bigger again" builds on what the user is looking
   * at: the operations answered are what it changes from there, and are added
   * to the preview, which is then kept or discarded as one change. An answer
   * with nothing to change, such as a question, leaves the preview as it is.
   * If the saved layout changed elsewhere since the preview was made, it is
   * fetched again, which takes the preview off, and this rejects with an
   * `EngineError` whose code is "conflict". If no answer comes, the preview
   * stays, and can still be kept.
   */
  planFromPrompt = async (prompt: string, viaVoice = false): Promise<PlanResponse> => {
    const { planResponse, previewOutcome } = await this.planAndShowPreview(prompt, viaVoice);
    return previewOutcome === "doesNotFit" ? { operations: [], message: PREVIEW_NO_LONGER_FITS_MESSAGE } : planResponse;
  };

  /** `planFromPrompt`, saying what became of the preview. */
  planAndShowPreview = async (
    prompt: string,
    viaVoice = false,
  ): Promise<{ planResponse: PlanResponse; previewOutcome: PlannedPreviewOutcome }> => {
    const engine = requireEngine(this.engine, "Planning");
    const { manifest } = this.getSnapshot();
    if (!manifest) throw new Error("AdaptiveRegion is not mounted, so there is nothing to plan");
    const previewToBuildOn = this.previewToBuildOn();
    const planResponse = await this.answeringForPreview(previewToBuildOn, () =>
      this.reloadingOnConflict(() =>
        engine.planFromPrompt(this.regionId, {
          manifest,
          prompt,
          ...(viaVoice && { viaVoice: true }),
          ...this.textDirectionToPlanWith(),
          ...this.drawnColumnsToPlanWith(),
          ...(previewToBuildOn && { preview: previewToBuildOn.planWith }),
        }),
      ),
    );
    const previewOutcome = this.showPlannedPreview(
      planResponse.operations,
      { prompt, message: planResponse.message, viaVoice },
      previewToBuildOn,
    );
    return { planResponse, previewOutcome };
  };

  /**
   * The preview a prompt typed now is planned from, or null when there is
   * none. One being saved is not built on: it is about to be the saved layout.
   */
  previewToBuildOn = (): PreviewToBuildOn | null => {
    const preview = this.pendingPreview;
    if (!preview || this.commitInProgress?.preview === preview) return null;
    return { handle: preview, planWith: { operations: preview.operations, baseRevision: this.latestSavedRevision } };
  };

  /**
   * Sends a plan request made with `previewToBuildOn`. When the engine says the
   * preview no longer applies to the saved layout it was made on, the preview
   * can never be saved, so it is taken off, as one that left the screen.
   */
  answeringForPreview = async <T>(
    previewToBuildOn: PreviewToBuildOn | null,
    sendRequest: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await sendRequest();
    } catch (error) {
      if (
        previewToBuildOn &&
        this.pendingPreview === previewToBuildOn.handle &&
        error instanceof EngineError &&
        error.code === "invalid_operations"
      ) {
        this.dropPendingPreview();
      }
      throw error;
    }
  };

  /**
   * Shows what the planner proposed for a prompt. Planned from the preview in
   * `previewBuiltOn`, it is added to that preview while it still shows; one
   * that takes the whole preview back leaves nothing to keep, so the preview
   * counts as discarded. Planned from the saved layout, it replaces any
   * preview that was showing, which counts as discarded.
   */
  showPlannedPreview = (
    operations: readonly Operation[],
    previewRequest: PreviewRequest,
    previewBuiltOn: PreviewToBuildOn | null,
  ): PlannedPreviewOutcome => {
    const previewPlannedFrom = previewBuiltOn?.handle;
    if (previewPlannedFrom && previewPlannedFrom === this.pendingPreview) {
      if (operations.length === 0) return "none";
      const combinedOperations = [...previewPlannedFrom.operations, ...operations];
      const { applyOutcome } = this.applyToCurrentLayout(combinedOperations);
      if (!applyOutcome.applied) return "doesNotFit";
      const requests = [...previewPlannedFrom.requests, previewRequest];
      const { layout } = this.getSnapshot();
      if (layout && findChangedComponentIds(layout, applyOutcome.layout).size === 0) {
        // Reported with the request that took it back, which is what turned it down.
        this.pendingPreview = { ...previewPlannedFrom, requests };
        this.discardPreview();
        return "none";
      }
      this.showPreview(applyOutcome.layout, combinedOperations, requests);
      return "addedTo";
    }
    // The preview it was planned from went while the planner worked, and was
    // not saved, so the answer describes a screen that is no longer there.
    if (previewPlannedFrom && previewPlannedFrom !== this.lastSavedPreview) return "doesNotFit";
    // One that is being saved is left to finish.
    if (this.pendingPreview && this.commitInProgress?.preview !== this.pendingPreview) this.discardPreview();
    if (operations.length === 0) return "none";
    return this.previewOperations(operations, previewRequest.prompt, previewRequest.message, previewRequest.viaVoice)
      .applied
      ? "new"
      : "doesNotFit";
  };

  /**
   * Shows a layout the engine stored for this region in a change it made to
   * several at once, as `applyOperations` does for a change to this one.
   */
  acceptSavedLayout = (
    layoutResponse: LayoutResponse,
    operations: readonly Operation[],
    layoutSource: Exclude<SavedLayoutSource, "read" | "savedUnsavedChange">,
  ): void => {
    this.acceptEngineLayout(layoutResponse, layoutSource);
    this.showChange(operations);
  };

  /**
   * Runs one saved change at a time. Each is checked against, and sent with the
   * number of, the change before it, so two made in quick succession do not
   * both claim to follow the same one. Without an engine nothing waits.
   * `unsavedChangesFirst` says what happens first to the changes not saved yet: an
   * undo leaves them, since it takes the newest back itself; a prompt's change
   * or a restore is refused when they cannot be saved, so it never reaches the
   * engine ahead of an older one.
   */
  oneWriteAtATime = <T>(
    writeChange: () => Promise<T>,
    unsavedChangesFirst: UnsavedChangesFirst = "save",
  ): Promise<T> => {
    if (!this.engine) return writeChange();
    const takeTurn = async () => {
      if (unsavedChangesFirst !== "leave") await this.saveUnsavedChanges();
      if (unsavedChangesFirst === "saveOrRefuse") this.refuseWhileUnsaved();
      return writeChange();
    };
    const writeResult = this.writeQueue.then(takeTurn, takeTurn);
    this.writeQueue = writeResult.catch(() => {});
    return writeResult;
  };

  /** Throws why the changes not saved yet could not be saved, if any still wait. */
  private refuseWhileUnsaved(): void {
    if (!this.unsavedChanges.hasSaveable) return;
    const saveFailure = this.unsavedChangeSaver.lastFailure;
    throw saveFailure instanceof EngineError ? saveFailure : engineUnreachableError(saveFailure);
  }

  /** When the engine says the layout changed elsewhere, fetches it before failing. */
  private async reloadingOnConflict<T>(sendRequest: () => Promise<T>): Promise<T> {
    try {
      return await sendRequest();
    } catch (error) {
      if (error instanceof EngineError && error.code === "conflict") {
        await this.loadSavedLayout().catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Fetches the engine's copy of the layout, which replaces the one shown and
   * takes any preview off: on every mount, and after the engine said this
   * region changed elsewhere.
   */
  loadSavedLayout = async (): Promise<void> => {
    this.savedLayoutLoading = true;
    this.notifyListeners();
    try {
      this.acceptEngineLayout(await this.engine!.readLayout(this.regionId), "read");
    } finally {
      this.savedLayoutLoading = false;
      this.pendingPreview = null;
      // The screen still shows what it showed while loading.
      for (const savedLayoutListener of [...this.savedLayoutListeners]) savedLayoutListener();
      this.notifyListeners();
    }
  };

  /**
   * Calls `savedLayoutListener` when the engine has answered for the saved layout, just
   * before the screen is told, while it still shows what it showed before.
   */
  beforeSavedLayoutIsShown = (savedLayoutListener: () => void): (() => void) => {
    this.savedLayoutListeners.add(savedLayoutListener);
    return () => this.savedLayoutListeners.delete(savedLayoutListener);
  };

  /**
   * Takes the engine's copy as the saved layout. Changes not saved yet stay on
   * top of it. After a fresh read or an undo, those that cannot be carried
   * over to it are still shown for the rest of the visit, so nothing changes
   * under the user, but are never saved. A change saved by prompt or restore
   * stands over the older ones: those kept for the visit only, and those that
   * cannot be carried over to it, go.
   */
  private acceptEngineLayout(layoutResponse: LayoutResponse, layoutSource: SavedLayoutSource): void {
    const nextSavedLayout = parseSavedLayout(layoutResponse.layout);
    // An undo takes back the newest saved change, which is not a new change
    // for the older ones to give way to: to them it is like a fresh read.
    if (layoutSource === "undo") this.savedChangeSequences.pop();
    else if (typeof layoutSource === "object") {
      this.unsavedChanges.giveWayTo(layoutSource.laterChangeSequence);
      this.recordSavedChange(layoutSource.laterChangeSequence);
    }
    // Not after saving one of them: the rest were made on top of it, so they already fit the engine's copy.
    if (!this.unsavedChanges.isEmpty && layoutSource !== "savedUnsavedChange") {
      const manifest = this.getSnapshot().manifest ?? this.unsavedChanges.newestManifest!;
      const fittedToManifest = (layout: Layout | null) =>
        layout ? reconcileLayout(manifest, layout).layout : defaultLayout(manifest);
      if (layoutSource === "read" || layoutSource === "undo") {
        this.unsavedChanges.carryOverToReadLayout(
          manifest,
          fittedToManifest(this.savedLayout),
          fittedToManifest(nextSavedLayout),
        );
      } else {
        this.unsavedChanges.carryOverToLaterChange(
          manifest,
          fittedToManifest(this.savedLayout),
          fittedToManifest(nextSavedLayout),
          layoutSource.laterChangeSequence,
        );
      }
      if (!this.unsavedChanges.hasSaveable) this.unsavedChangeSaver.cancelRetry();
    }
    // The engine applies every change to its own copy, so its copy is the one
    // shown. Keeping `initialLayout` here would preview changes on a layout the
    // engine has never seen, and saving would then silently drop it.
    this.savedLayout = nextSavedLayout;
    this.engineAnswered = true;
    this.loadFailed = false;
    this.loadRetrier.succeeded();
    this.latestSavedRevision = layoutResponse.revision;
    this.latestSavedChangeId = layoutResponse.changeId ?? 0;
    // An engine that does not say is assumed able to undo anything but the default.
    this.engineCanUndo = layoutResponse.canUndo ?? layoutResponse.layout !== null;
  }

  /** Tells the host. A fault in its handler is reported, and does not stop the SDK keeping its own state right. */
  private reportLayoutChange(layout: Layout, operations: readonly Operation[]): void {
    try {
      this.onLayoutChange?.(layout, operations);
    } catch (error) {
      if (typeof reportError === "function") reportError(error);
      else setTimeout(() => { throw error; });
    }
  }

  /**
   * What the operations would do to the saved layout, without doing it.
   * `fallbackManifest` stands in for the manifest when the region is no longer mounted.
   */
  applyToCurrentLayout = (
    operations: readonly Operation[],
    fallbackManifest: Manifest | null = null,
  ): { manifest: Manifest; applyOutcome: ApplyOperationsOutcome } => {
    const currentSnapshot = this.getSnapshot();
    const manifest = currentSnapshot.manifest ?? fallbackManifest;
    if (!manifest) {
      throw new Error("AdaptiveRegion is not mounted, so there is no layout to change");
    }
    const layout =
      currentSnapshot.layout ??
      (this.savedLayout ? reconcileLayout(manifest, this.savedLayout).layout : defaultLayout(manifest));
    return { manifest, applyOutcome: applyOperations(manifest, layout, operations) };
  };

  /**
   * The screen changed under the preview, as on leaving the page, so it no
   * longer describes it: it is taken off and reported as abandoned.
   */
  private dropPendingPreview(manifest: Manifest | null = this.getSnapshot().manifest): void {
    this.reportPreviewNotKept("abandoned", manifest);
    this.pendingPreview = null;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    this.cachedSnapshot = null;
    for (const snapshotListener of [...this.snapshotListeners]) snapshotListener();
  }

  private computeSnapshot(): RegionSnapshot {
    if (!this.regionConfig) return EMPTY_REGION_SNAPSHOT;
    const manifest: Manifest = {
      ...this.regionConfig,
      // Document order is the developer's default order. It stays stable because
      // moves are done with CSS `order`, never by re-parenting.
      components: [...this.registeredComponents.values()]
        .sort((firstRegistered, secondRegistered) =>
          compareDocumentOrder(firstRegistered.element, secondRegistered.element),
        )
        .map((registeredComponent) => registeredComponent.component),
    };
    const reconcileResult = this.savedLayout ? reconcileLayout(manifest, this.savedLayout) : null;
    const layout = this.unsavedChanges.applyTo(manifest, reconcileResult?.layout ?? defaultLayout(manifest));
    const preview = this.pendingPreview?.layout ?? null;
    const originalLayout = defaultLayout(manifest);
    const original = this.originalShown && !preview ? originalLayout : null;
    const differingLayout = preview ?? original;
    return {
      manifest,
      layout,
      preview,
      original,
      differsFromOriginal: findChangedComponentIds(layout, originalLayout).size > 0,
      changedComponentIds: differingLayout ? findChangedComponentIds(layout, differingLayout) : NO_CHANGED_COMPONENT_IDS,
      savedLayoutAdjustments: reconcileResult?.changes.length ? reconcileResult.changes : NO_LAYOUT_CHANGES,
      loading: this.savedLayoutLoading,
      loadFailed: this.loadFailed,
      canUndo: this.engine ? !this.unsavedChanges.isEmpty || this.engineCanUndo : this.undoStack.length > 0,
      revision: this.latestSavedRevision,
      hasHistory: this.engine !== null,
      hasUnsavedChanges: this.unsavedChanges.hasSaveable,
    };
  }
}

function compareDocumentOrder(firstElement: Element | null, secondElement: Element | null): number {
  if (!firstElement || !secondElement || firstElement === secondElement) return 0;
  return firstElement.compareDocumentPosition(secondElement) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}
