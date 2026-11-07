import { cloneLayoutItem, defaultLayoutItem, LAYOUT_FORMAT_VERSION, offeredValuesOf, withSize } from "./defaultLayout";
import { ownPropertyValue, setOwnProperty } from "./ownProperties";
import { clonePropValue, propAcceptsValue, propValuesEqual } from "./propValues";
import type { Component, Layout, LayoutItem, Manifest, PropValue } from "./schemas.gen";

export interface LayoutChange {
  /**
   * `added`: the component is new in this version and was placed with its defaults.
   * `removed`: something the layout held for a component was dropped for good.
   * `adjusted`: a setting the manifest no longer allows was corrected.
   */
  type: "added" | "removed" | "adjusted";
  id: string;
}

export interface ReconciledLayout {
  layout: Layout;
  changes: LayoutChange[];
}

/**
 * The most components a layout keeps settings for while they are off screen.
 * Nothing else ever drops them: a component a release deleted cannot be told
 * from one that is not showing, and losing what a user set is worse than
 * keeping an entry nobody sees. So without a limit, deleted components would
 * pile up release after release, and a caller sending a different manifest
 * with every change could grow the stored layout without end. It is the most
 * one manifest may list, so a region whose every component is off screen at
 * once still fits. Past it, the ones last in the order are dropped.
 * Must equal the engine's own `MAX_OFF_SCREEN_COMPONENTS`, or the screen and
 * the engine would disagree.
 */
export const MAX_OFF_SCREEN_COMPONENTS = 500;

/**
 * Carries a saved layout over to a manifest, keeping everything the manifest
 * still allows. The result's `order` and `items` always hold exactly the
 * manifest's components.
 *
 * A manifest lists what is on screen now, which may be only part of the region:
 * one tab's content, say. A saved component it does not list is set aside in
 * `offScreen` with its settings and its place, and takes them again when it is
 * listed. It is kept however long it stays away, up to
 * `MAX_OFF_SCREEN_COMPONENTS`, since a component a release deleted looks the
 * same as one that is merely not showing.
 *
 * New components take their defaults and go after the nearest earlier manifest
 * neighbour already in the layout, or first if there is none. They are reported
 * as added only when the version changed: within one version, a component the
 * layout has not met was simply not on screen when it was saved. Settings are
 * corrected only where they break the manifest.
 */
export function reconcileLayout(manifest: Manifest, layout: Layout): ReconciledLayout {
  const onScreenComponentIds = new Set(manifest.components.map((component) => component.id));
  const savedOffScreenItems = layout.offScreen?.items ?? {};
  const changes: LayoutChange[] = [];

  const idsInSavedOrder = new Set(layout.order);
  for (const componentId of idsInSavedOrder) {
    const hasNothingSaved =
      !Object.hasOwn(layout.items, componentId) && !Object.hasOwn(savedOffScreenItems, componentId);
    if (hasNothingSaved && !onScreenComponentIds.has(componentId)) changes.push({ type: "removed", id: componentId });
  }

  let knownOrder = savedOrderOfKnownComponents(layout);
  // A saved item that was never placed, for a component that is not on screen, goes last.
  // Sorted by UTF-16 code unit, as the engine sorts them.
  for (const componentId of Object.keys(layout.items).sort()) {
    if (!idsInSavedOrder.has(componentId) && !onScreenComponentIds.has(componentId)) knownOrder.push(componentId);
  }

  const offScreenItems: NonNullable<Layout["offScreen"]>["items"] = {};
  const offScreenComponentIds: string[] = [];
  for (const componentId of knownOrder) {
    if (onScreenComponentIds.has(componentId)) continue;
    const savedItem = ownPropertyValue(layout.items, componentId) ?? ownPropertyValue(savedOffScreenItems, componentId)!;
    setOwnProperty(offScreenItems, componentId, cloneLayoutItem(savedItem));
    offScreenComponentIds.push(componentId);
  }
  for (const componentId of offScreenComponentIds.splice(MAX_OFF_SCREEN_COMPONENTS)) {
    delete offScreenItems[componentId];
    changes.push({ type: "removed", id: componentId });
  }
  knownOrder = knownOrder.filter(
    (componentId) => onScreenComponentIds.has(componentId) || Object.hasOwn(offScreenItems, componentId),
  );

  const layoutItems: Layout["items"] = {};
  manifest.components.forEach((component, componentIndex) => {
    const savedItem =
      ownPropertyValue(layout.items, component.id) ?? ownPropertyValue(savedOffScreenItems, component.id);
    if (savedItem) {
      const savedItemRepair = repairLayoutItem(manifest.columns, component, savedItem);
      if (savedItemRepair.wasCorrected) changes.push({ type: "adjusted", id: component.id });
      setOwnProperty(layoutItems, component.id, savedItemRepair.repairedItem);
    } else {
      setOwnProperty(layoutItems, component.id, defaultLayoutItem(component));
      if (layout.manifestVersion !== manifest.version) changes.push({ type: "added", id: component.id });
    }
    if (knownOrder.includes(component.id)) return;

    let insertIndex = 0;
    for (let earlierIndex = componentIndex - 1; earlierIndex >= 0; earlierIndex--) {
      const neighbourIndex = knownOrder.indexOf(manifest.components[earlierIndex]!.id);
      if (neighbourIndex >= 0) {
        insertIndex = neighbourIndex + 1;
        break;
      }
    }
    knownOrder.splice(insertIndex, 0, component.id);
  });

  return {
    layout: {
      formatVersion: LAYOUT_FORMAT_VERSION,
      regionId: manifest.regionId,
      manifestVersion: manifest.version,
      order: knownOrder.filter((componentId) => onScreenComponentIds.has(componentId)),
      items: layoutItems,
      ...(offScreenComponentIds.length > 0 && { offScreen: { order: knownOrder, items: offScreenItems } }),
    },
    changes,
  };
}

/**
 * Every component the layout has settings and a place for, on screen or off,
 * in one order. `offScreen.order` gives each its slot, but `order` may have
 * been rearranged since it was written, so the slots of the components in
 * `order` are filled in the sequence `order` now gives. Anything with no slot
 * goes last.
 */
export function savedOrderOfKnownComponents(layout: Layout): string[] {
  const savedOffScreenItems = layout.offScreen?.items ?? {};
  const placedComponentIds = [...new Set(layout.order)].filter((componentId) =>
    Object.hasOwn(layout.items, componentId),
  );
  const placedComponentIdSet = new Set(placedComponentIds);
  const isSetAside = (componentId: string) =>
    !Object.hasOwn(layout.items, componentId) && Object.hasOwn(savedOffScreenItems, componentId);

  const knownOrder: string[] = [];
  let placedCount = 0;
  const slotIds = new Set(layout.offScreen?.order);
  for (const slotId of slotIds) {
    if (placedComponentIdSet.has(slotId)) knownOrder.push(placedComponentIds[placedCount++]!);
    else if (isSetAside(slotId)) knownOrder.push(slotId);
  }
  knownOrder.push(...placedComponentIds.slice(placedCount));
  for (const componentId of Object.keys(savedOffScreenItems).sort()) {
    if (isSetAside(componentId) && !slotIds.has(componentId)) knownOrder.push(componentId);
  }
  return knownOrder;
}

/**
 * One component's saved settings, corrected the way `reconcileLayout` corrects them.
 * For showing a saved item before the whole manifest is known.
 */
export function reconcileLayoutItem(component: Component, savedItem: LayoutItem, columnCount: number): LayoutItem {
  return repairLayoutItem(columnCount, component, savedItem).repairedItem;
}

/**
 * `wasCorrected` is true when something the user had set was changed. Filling in
 * a setting they never had, or adding a list entry that did not exist when
 * they saved, is not a correction.
 */
function repairLayoutItem(
  columnCount: number,
  component: Component,
  savedItem: LayoutItem,
): { repairedItem: LayoutItem; wasCorrected: boolean } {
  const { capabilities, defaults: componentDefaults } = component;
  if (component.locked) {
    const lockedItem = defaultLayoutItem(component);
    const wasCorrected =
      sizeWasCorrected(lockedItem.w, savedItem.w) ||
      sizeWasCorrected(lockedItem.h, savedItem.h) ||
      lockedItem.hidden !== savedItem.hidden ||
      Object.entries(savedItem.props).some(
        ([propName, savedValue]) => !propValuesEqual(ownPropertyValue(lockedItem.props, propName), savedValue),
      );
    return { repairedItem: lockedItem, wasCorrected };
  }

  // A component without a size keeps none, and one that has gained a size starts from its default.
  const resizeLimits = capabilities.resize;
  const width =
    resizeLimits && componentDefaults.w !== undefined && savedItem.w !== undefined
      ? clampNumber(savedItem.w, resizeLimits.minW, Math.min(resizeLimits.maxW, columnCount))
      : componentDefaults.w;
  const height =
    resizeLimits && componentDefaults.h !== undefined && savedItem.h !== undefined
      ? clampNumber(savedItem.h, resizeLimits.minH, resizeLimits.maxH)
      : componentDefaults.h;
  const isHidden = capabilities.hide ? savedItem.hidden : componentDefaults.hidden;
  let wasCorrected =
    sizeWasCorrected(width, savedItem.w) || sizeWasCorrected(height, savedItem.h) || isHidden !== savedItem.hidden;

  /** The saved value if the manifest still allows it, else undefined. Lists are trimmed and topped up. */
  const reconciledPropValue = (propName: string): PropValue | undefined => {
    const propCapabilities = ownPropertyValue(capabilities.props, propName);
    const savedValue = ownPropertyValue(savedItem.props, propName);
    if (!propCapabilities || savedValue === undefined) return undefined;
    if ("type" in propCapabilities && propCapabilities.type === "number" && typeof savedValue === "number") {
      // A range that was tightened moves the value to the nearest limit.
      const nearestAllowedValue = clampNumber(savedValue, propCapabilities.min, propCapabilities.max);
      if (nearestAllowedValue !== savedValue) wasCorrected = true;
      return propAcceptsValue(propCapabilities, nearestAllowedValue) ? nearestAllowedValue : undefined;
    }
    if ("type" in propCapabilities || !propCapabilities.multiple || !Array.isArray(savedValue)) {
      return propAcceptsValue(propCapabilities, savedValue) ? clonePropValue(savedValue) : undefined;
    }

    const keptEntries = [...new Set(savedValue)].filter((listEntry) => propCapabilities.values.includes(listEntry));
    if (!propValuesEqual(keptEntries, savedValue)) wasCorrected = true;

    // Entries that did not exist when the layout was saved, and that the
    // developer shows by default, go in beside their neighbour in the defaults.
    const previouslyOfferedValues = ownPropertyValue(savedItem.offeredValues, propName);
    const defaultEntries = ownPropertyValue(componentDefaults.props, propName);
    const insertBesideDefaultNeighbour = (defaultList: typeof keptEntries, entryIndex: number) => {
      let insertIndex = 0;
      for (let earlierIndex = entryIndex - 1; earlierIndex >= 0; earlierIndex--) {
        const neighbourIndex = keptEntries.indexOf(defaultList[earlierIndex]!);
        if (neighbourIndex >= 0) {
          insertIndex = neighbourIndex + 1;
          break;
        }
      }
      keptEntries.splice(insertIndex, 0, defaultList[entryIndex]!);
    };
    if (previouslyOfferedValues && Array.isArray(defaultEntries)) {
      defaultEntries.forEach((defaultEntry, entryIndex) => {
        if (
          previouslyOfferedValues.includes(defaultEntry) ||
          keptEntries.includes(defaultEntry) ||
          !propCapabilities.values.includes(defaultEntry)
        ) {
          return;
        }
        insertBesideDefaultNeighbour(defaultEntries, entryIndex);
      });
    }

    // An entry the list must hold goes back beside its neighbour in the defaults, or at the end.
    for (const requiredEntry of propCapabilities.required ?? []) {
      if (keptEntries.includes(requiredEntry) || !propCapabilities.values.includes(requiredEntry)) continue;
      const defaultIndex = Array.isArray(defaultEntries) ? defaultEntries.indexOf(requiredEntry) : -1;
      if (Array.isArray(defaultEntries) && defaultIndex >= 0) insertBesideDefaultNeighbour(defaultEntries, defaultIndex);
      else keptEntries.push(requiredEntry);
      wasCorrected = true;
    }
    return propAcceptsValue(propCapabilities, keptEntries) ? keptEntries : undefined;
  };

  const reconciledProps: LayoutItem["props"] = {};
  for (const [propName, defaultValue] of Object.entries(componentDefaults.props)) {
    const reconciledValue = reconciledPropValue(propName);
    if (reconciledValue === undefined && Object.hasOwn(savedItem.props, propName)) wasCorrected = true;
    setOwnProperty(reconciledProps, propName, reconciledValue ?? clonePropValue(defaultValue));
  }
  for (const propName of Object.keys(savedItem.props)) {
    if (Object.hasOwn(componentDefaults.props, propName)) continue;
    const reconciledValue = reconciledPropValue(propName);
    if (reconciledValue === undefined) wasCorrected = true;
    else setOwnProperty(reconciledProps, propName, reconciledValue);
  }

  const offeredValues = offeredValuesOf(component);
  return {
    repairedItem: {
      ...withSize(width, height),
      hidden: isHidden,
      props: reconciledProps,
      ...(offeredValues && { offeredValues }),
    },
    wasCorrected,
  };
}

/**
 * Dropping a size the component no longer has, or giving one it has just
 * gained, changes nothing the user set.
 */
function sizeWasCorrected(repairedSize: number | undefined, savedSize: number | undefined): boolean {
  return repairedSize !== undefined && savedSize !== undefined && repairedSize !== savedSize;
}

function clampNumber(unclampedNumber: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(unclampedNumber, minimum), maximum);
}
