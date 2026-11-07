import { applyOperations, type Layout, type Manifest, type Operation } from "@clickless/core";

/** A change made with the application's own controls that the engine has not saved yet. */
export interface UnsavedChange {
  operations: readonly Operation[];
  /** The screen it was made on, for saving it after the region has gone. */
  manifest: Manifest;
  /**
   * Counted across the regions of one provider, so the newest change among
   * several can be undone first. Only the order of these numbers means anything.
   */
  sequence: number;
  /**
   * False once it will never be saved: the engine refused it for good, or it
   * clashes with the saved layout read since it was made. It is then kept for
   * this visit only, and gives way to the next change that is saved.
   */
  saveable: boolean;
}

/**
 * A region's changes not saved yet, oldest first, shown on top of its saved
 * layout until the engine has them.
 */
export class UnsavedChangeList {
  private changes: UnsavedChange[] = [];

  constructor(private readonly nextChangeSequence: () => number) {}

  get isEmpty(): boolean {
    return this.changes.length === 0;
  }

  /** True while any of them may still be saved. */
  get hasSaveable(): boolean {
    return this.changes.some((change) => change.saveable);
  }

  /** The `sequence` of the newest, or 0 when there is none. */
  get newestSequence(): number {
    return this.changes.at(-1)?.sequence ?? 0;
  }

  /** The screen the newest was made on, for when the region is no longer mounted. */
  get newestManifest(): Manifest | undefined {
    return this.changes.at(-1)?.manifest;
  }

  /** The oldest the engine may still take. */
  nextToSave(): UnsavedChange | undefined {
    return this.changes.find((change) => change.saveable);
  }

  add(operations: readonly Operation[], manifest: Manifest): void {
    this.changes.push({ operations, manifest, sequence: this.nextChangeSequence(), saveable: true });
  }

  /** Takes back the newest, unless it is `changeBeingSaved`. Returns the one taken back, or null. */
  takeBackNewest(changeBeingSaved: UnsavedChange | null): UnsavedChange | null {
    const newestChange = this.changes.at(-1);
    if (!newestChange || newestChange === changeBeingSaved) return null;
    this.changes.pop();
    return newestChange;
  }

  /**
   * The engine has `change` now. It goes, and so do the changes kept for the
   * visit only that were made before it: changes are saved oldest first, so
   * those are all that come before it, and it is newer than every one of them.
   */
  dropSavedChange(change: UnsavedChange): void {
    this.changes = this.changes.slice(this.changes.indexOf(change) + 1);
  }

  /**
   * Drops the changes kept for the visit only that are older than a change
   * saved by prompt or restore, numbered `laterChangeSequence`, which
   * stands over them. Returns true when there were any.
   */
  giveWayTo(laterChangeSequence: number): boolean {
    const givesWayToLaterChange = (change: UnsavedChange) => !change.saveable && change.sequence < laterChangeSequence;
    if (!this.changes.some(givesWayToLaterChange)) return false;
    this.changes = this.changes.filter((change) => !givesWayToLaterChange(change));
    return true;
  }

  /**
   * After a fresh read of the saved layout, carries the changes from the
   * layout they were made on to it (see `carryOverUnsavedChanges`). Those that
   * cannot be carried are kept for the visit only.
   */
  carryOverToReadLayout(manifest: Manifest, shownLayout: Layout, savedLayout: Layout): void {
    const carriedChanges = carryOverUnsavedChanges(manifest, shownLayout, savedLayout, this.changes);
    for (const change of this.changes) if (!carriedChanges.includes(change)) change.saveable = false;
  }

  /**
   * After a change saved by prompt or restore, numbered
   * `laterChangeSequence`: the older changes are carried over to the layout it
   * made where they can be and dropped where they cannot, since it stands over
   * them. Those made while it was on its way are newer, and stay as they are.
   */
  carryOverToLaterChange(manifest: Manifest, shownLayout: Layout, savedLayout: Layout, laterChangeSequence: number): void {
    const olderChanges = this.changes.filter((change) => change.sequence < laterChangeSequence);
    const carriedChanges = carryOverUnsavedChanges(manifest, shownLayout, savedLayout, olderChanges);
    this.changes = this.changes.filter(
      (change) => change.sequence >= laterChangeSequence || carriedChanges.includes(change),
    );
  }

  /** The layout with every change that fits it laid on top. One that does not waits, unshown, until it does. */
  applyTo(manifest: Manifest, layout: Layout): Layout {
    let shownLayout = layout;
    for (const change of this.changes) {
      const applyOutcome = applyOperations(manifest, shownLayout, change.operations);
      if (applyOutcome.applied) shownLayout = applyOutcome.layout;
    }
    return shownLayout;
  }
}

/**
 * The changes that can be carried from the layout they were made on,
 * `shownLayout`, to the saved layout the engine has now given, `savedLayout`.
 * A change is carried only when what it acts on reads the same in both: a
 * setting the user changed while their saved layout could not be read, or
 * that was changed elsewhere meanwhile, is not overwritten with a value worked
 * out from a screen they were not shown. One whose component is not on the
 * screen now is carried as it is when what it acts on reads the same: it is
 * saved with the screen it was made on. Both layouts must be reconciled
 * against `manifest`.
 */
export function carryOverUnsavedChanges(
  manifest: Manifest,
  shownLayout: Layout,
  savedLayout: Layout,
  changes: readonly UnsavedChange[],
): UnsavedChange[] {
  const carriedChanges: UnsavedChange[] = [];
  let layoutAsShown = shownLayout;
  let layoutAsSaved = savedLayout;
  for (const change of changes) {
    const actsOnTheSame = change.operations.every((operation) =>
      readsTheSame(operation, layoutAsShown, layoutAsSaved),
    );
    const savedApplyOutcome = actsOnTheSame ? applyOperations(manifest, layoutAsSaved, change.operations) : null;
    if (savedApplyOutcome?.applied) {
      carriedChanges.push(change);
      layoutAsSaved = savedApplyOutcome.layout;
    } else if (savedApplyOutcome?.errors.every((operationError) => operationError.code === "unknown_component")) {
      carriedChanges.push(change);
    }
    const shownApplyOutcome = applyOperations(manifest, layoutAsShown, change.operations);
    if (shownApplyOutcome.applied) layoutAsShown = shownApplyOutcome.layout;
  }
  return carriedChanges;
}

/** Whether what the operation acts on is the same in both layouts. */
function readsTheSame(operation: Operation, firstLayout: Layout, secondLayout: Layout): boolean {
  // A component off the screen keeps its settings aside, where they are compared too.
  const layoutItemIn = (layout: Layout, componentId: string) => {
    if (Object.hasOwn(layout.items, componentId)) return layout.items[componentId];
    if (layout.offScreen && Object.hasOwn(layout.offScreen.items, componentId)) return layout.offScreen.items[componentId];
    return undefined;
  };
  const readsSameInBoth = (readSetting: (layout: Layout) => unknown) =>
    stableJson(readSetting(firstLayout)) === stableJson(readSetting(secondLayout));
  switch (operation.type) {
    case "setProp":
      return readsSameInBoth((layout) => {
        const itemProps = layoutItemIn(layout, operation.id)?.props;
        return itemProps && Object.hasOwn(itemProps, operation.prop) ? itemProps[operation.prop] : undefined;
      });
    case "hide":
    case "show":
      return readsSameInBoth((layout) => layoutItemIn(layout, operation.id)?.hidden);
    case "resize":
      return readsSameInBoth((layout) => [
        layoutItemIn(layout, operation.id)?.w,
        layoutItemIn(layout, operation.id)?.h,
      ]);
    case "reset":
      return operation.id === undefined
        ? readsSameInBoth((layout) => [
            layout.order,
            layout.order.map((componentId) => layoutItemIn(layout, componentId)),
          ])
        : readsSameInBoth((layout) => layoutItemIn(layout, operation.id!));
    case "move":
    case "reorder":
      return readsSameInBoth((layout) => layout.order);
  }
}

/** JSON with every object's keys in order, so two equal values always read the same. */
function stableJson(jsonValue: unknown): string {
  return JSON.stringify(jsonValue, (_key, nestedValue: unknown) =>
    nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)
      ? Object.fromEntries(
          Object.entries(nestedValue).sort(([firstKey], [secondKey]) => (firstKey < secondKey ? -1 : 1)),
        )
      : nestedValue,
  );
}
