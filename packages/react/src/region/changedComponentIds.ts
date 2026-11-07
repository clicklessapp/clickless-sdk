import type { Layout } from "@clickless/core";

/**
 * Components whose own settings differ, plus the smallest set that had to move
 * to turn one order into the other. Components that merely shifted because
 * something else moved past them are left out.
 */
export function findChangedComponentIds(previousLayout: Layout, nextLayout: Layout): ReadonlySet<string> {
  const changedIds = new Set<string>();
  for (const componentId of nextLayout.order) {
    if (
      JSON.stringify(previousLayout.items[componentId]) !== JSON.stringify(nextLayout.items[componentId])
    ) {
      changedIds.add(componentId);
    }
  }

  for (const componentId of entriesOutOfOrder(previousLayout.order, nextLayout.order)) changedIds.add(componentId);
  return changedIds;
}

/**
 * The entries of `nextOrder` that are new, or had to move to turn
 * `previousOrder` into it. Entries that merely shifted because something else
 * moved past them are left out.
 */
export function entriesOutOfOrder(previousOrder: readonly string[], nextOrder: readonly string[]): Set<string> {
  // Longest common subsequence of the two orders: everything outside it moved.
  const commonLengths = Array.from({ length: previousOrder.length + 1 }, () =>
    new Array<number>(nextOrder.length + 1).fill(0),
  );
  for (let previousIndex = previousOrder.length - 1; previousIndex >= 0; previousIndex--) {
    for (let nextIndex = nextOrder.length - 1; nextIndex >= 0; nextIndex--) {
      commonLengths[previousIndex]![nextIndex] =
        previousOrder[previousIndex] === nextOrder[nextIndex]
          ? commonLengths[previousIndex + 1]![nextIndex + 1]! + 1
          : Math.max(
              commonLengths[previousIndex + 1]![nextIndex]!,
              commonLengths[previousIndex]![nextIndex + 1]!,
            );
    }
  }
  const unmovedIds = new Set<string>();
  for (
    let previousIndex = 0, nextIndex = 0;
    previousIndex < previousOrder.length && nextIndex < nextOrder.length;

  ) {
    if (previousOrder[previousIndex] === nextOrder[nextIndex]) {
      unmovedIds.add(previousOrder[previousIndex]!);
      previousIndex++;
      nextIndex++;
    } else if (
      commonLengths[previousIndex + 1]![nextIndex]! >= commonLengths[previousIndex]![nextIndex + 1]!
    ) {
      previousIndex++;
    } else nextIndex++;
  }
  return new Set(nextOrder.filter((entry) => !unmovedIds.has(entry)));
}
