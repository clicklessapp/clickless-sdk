import {
  cloneLayoutItem,
  defaultLayout,
  defaultLayoutItem,
  LAYOUT_FORMAT_VERSION,
  layoutMatchesManifest,
} from "./defaultLayout";
import { setOwnProperty } from "./ownProperties";
import { clonePropValue } from "./propValues";
import type { Component, Layout, Manifest, Operation } from "./schemas.gen";
import { validateOperations, type OperationError } from "./validateOperations";

export type ApplyOperationsOutcome = { applied: true; layout: Layout } | { applied: false; errors: OperationError[] };

/**
 * Validates the whole list, then applies it in order. Nothing is applied if any
 * operation is invalid, or if the result would leave nothing showing in a
 * region that showed something (see `findEmptyRegionFailure`). The input
 * layout is never mutated.
 *
 * Throws if the layout's `order` and `items` do not hold exactly the manifest's
 * components, which means it was not reconciled against this manifest. What
 * the layout keeps in `offScreen` is carried through untouched, except that
 * resetting the whole region drops it.
 */
export function applyOperations(manifest: Manifest, layout: Layout, operations: readonly Operation[]): ApplyOperationsOutcome {
  if (!layoutMatchesManifest(manifest, layout)) {
    throw new Error(`layout does not match manifest "${manifest.regionId}"`);
  }
  const operationErrors = validateOperations(manifest, operations);
  if (operationErrors.length > 0) return { applied: false, errors: operationErrors };

  const componentsById = new Map(manifest.components.map((component) => [component.id, component]));
  let componentOrder = [...layout.order];
  let layoutItems: Layout["items"] = {};
  let offScreen = layout.offScreen;
  for (const [componentId, layoutItem] of Object.entries(layout.items)) {
    setOwnProperty(layoutItems, componentId, cloneLayoutItem(layoutItem));
  }

  for (const operation of operations) {
    switch (operation.type) {
      case "move": {
        const startingIndex = componentOrder.indexOf(operation.id);
        componentOrder = componentOrder.filter((componentId) => componentId !== operation.id);
        if (operation.position === "start" || operation.position === "end") {
          // The start and end of the component's own group, which is all that its place is compared with.
          const { group: movedComponentGroup } = componentsById.get(operation.id)!;
          const groupIndexes = componentOrder.flatMap((componentId, orderIndex) =>
            componentsById.get(componentId)!.group === movedComponentGroup ? [orderIndex] : [],
          );
          const insertIndex =
            groupIndexes.length === 0
              ? startingIndex
              : operation.position === "start"
                ? groupIndexes[0]!
                : groupIndexes[groupIndexes.length - 1]! + 1;
          componentOrder.splice(insertIndex, 0, operation.id);
        } else {
          const targetIndex = componentOrder.indexOf(operation.targetId!);
          componentOrder.splice(operation.position === "before" ? targetIndex : targetIndex + 1, 0, operation.id);
        }
        break;
      }
      case "reorder": {
        const reorderedIds = new Set(operation.ids);
        const insertIndex = componentOrder.findIndex((componentId) => reorderedIds.has(componentId));
        componentOrder = componentOrder.filter((componentId) => !reorderedIds.has(componentId));
        componentOrder.splice(insertIndex, 0, ...operation.ids);
        break;
      }
      case "resize": {
        const resizedItem = layoutItems[operation.id]!;
        if (operation.w !== undefined) resizedItem.w = operation.w;
        if (operation.h !== undefined) resizedItem.h = operation.h;
        break;
      }
      case "hide":
        layoutItems[operation.id]!.hidden = true;
        break;
      case "show":
        layoutItems[operation.id]!.hidden = false;
        break;
      case "setProp":
        setOwnProperty(layoutItems[operation.id]!.props, operation.prop, clonePropValue(operation.value));
        break;
      case "reset": {
        if (operation.id === undefined) {
          ({ order: componentOrder, items: layoutItems } = defaultLayout(manifest));
          // The whole region goes back, not only the part that is on screen.
          offScreen = undefined;
        } else {
          setOwnProperty(layoutItems, operation.id, defaultLayoutItem(componentsById.get(operation.id)!));
        }
        break;
      }
    }
  }

  const resultingLayout: Layout = {
    formatVersion: LAYOUT_FORMAT_VERSION,
    regionId: layout.regionId,
    manifestVersion: manifest.version,
    order: componentOrder,
    items: layoutItems,
    ...(offScreen && { offScreen: structuredClone(offScreen) }),
  };
  const emptyRegionError = findEmptyRegionFailure(manifest, layout, resultingLayout, operations);
  if (emptyRegionError) return { applied: false, errors: [emptyRegionError] };
  return { applied: true, layout: resultingLayout };
}

/**
 * A change may not hide the last component showing in a region, so a page is
 * never emptied by accident or by a slip of the planner. Where the region has
 * components with a size, one of those must stay: buttons, menus and tabs,
 * which the page sizes itself, do not keep a page of cards and charts from
 * looking empty. Whatever the sizes, the last component of any kind stays too.
 * Only what is on screen counts, and only the result: a list may hide
 * everything and then show something again. Each check leaves alone a region
 * where it found nothing showing already, or nothing showing by default, so a
 * region that starts empty can be returned to how it started. The error points
 * at the last operation that hides something.
 */
function findEmptyRegionFailure(
  manifest: Manifest,
  startingLayout: Layout,
  resultingLayout: Layout,
  operations: readonly Operation[],
): OperationError | undefined {
  const leftEmpty = (components: readonly Component[]) => {
    const showsNothing = (layout: Layout) => components.every((component) => layout.items[component.id]!.hidden);
    return (
      showsNothing(resultingLayout) &&
      !showsNothing(startingLayout) &&
      !components.every((component) => component.defaults.hidden)
    );
  };
  if (!leftEmpty(componentsThatKeepRegionFromEmpty(manifest)) && !leftEmpty(manifest.components)) return undefined;
  const lastHidingIndex = operations.reduce(
    (foundIndex, operation, operationIndex) =>
      operation.type === "hide" || operation.type === "reset" ? operationIndex : foundIndex,
    -1,
  );
  return {
    index: lastHidingIndex,
    code: "empty_region",
    message: "this would leave nothing showing in this region; at least one component must stay showing",
  };
}

/** The components of which one must stay showing: those with a size, or every one if none has a size. */
function componentsThatKeepRegionFromEmpty(manifest: Manifest): Component[] {
  const sizedComponents = manifest.components.filter((component) => component.defaults.w !== undefined);
  return sizedComponents.length > 0 ? sizedComponents : manifest.components;
}
