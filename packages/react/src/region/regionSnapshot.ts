import type { Layout, LayoutChange, Manifest } from "@clickless/core";

export interface RegionSnapshot {
  /** Built from the mounted `Adaptive` components. Null until the region has mounted. */
  manifest: Manifest | null;
  /**
   * The committed layout. `order` and `items` hold the components on screen;
   * `offScreen` holds what is kept for the ones that are not.
   */
  layout: Layout | null;
  /** A proposed layout awaiting `commitPreview`, `discardPreview` or `cancelPreview`. */
  preview: Layout | null;
  /**
   * How the region first looked, before any change, while it is shown in place
   * of the layout. Null otherwise, and always while there is a preview.
   */
  original: Layout | null;
  /** True when what is on the screen differs from how it first looked. */
  differsFromOriginal: boolean;
  /**
   * Ids of the components the preview, or the original while it is shown,
   * draws differently from the layout. Empty when neither is showing.
   */
  changedComponentIds: ReadonlySet<string>;
  /**
   * How the saved layout had to change to fit the components now on screen:
   * components new in this version, settings the manifest no longer allows,
   * and what was dropped for good (components past the limit kept off screen,
   * or entries with nothing saved). Empty when it fits. Components that are
   * only off screen for now, such as another tab's, are not changes.
   */
  savedLayoutAdjustments: readonly LayoutChange[];
  /** True while the saved layout is being fetched from the engine. */
  loading: boolean;
  /**
   * True when the saved layout could not be fetched, so the screen may not
   * show it. It is fetched again on its own, a few seconds later and then less
   * often, and at once when the engine answers again after being out of
   * reach; false once it has been.
   */
  loadFailed: boolean;
  canUndo: boolean;
  /** Number of the latest saved change. 0 when there is none, or no engine. */
  revision: number;
  /** True when changes are stored by the engine, so there is a history to read. */
  hasHistory: boolean;
  /**
   * True while a change made with the application's own controls is shown but
   * not saved yet, as when the engine cannot be reached. It is saved when the
   * engine is back.
   */
  hasUnsavedChanges: boolean;
}
