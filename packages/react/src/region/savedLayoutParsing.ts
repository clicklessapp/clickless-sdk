import { Layout } from "@clickless/core";

/**
 * The layout if it has the shape of one, else null. A saved layout comes from
 * storage the SDK does not control, and one that is cut short or from another
 * format must fall back to the default instead of breaking the screen.
 */
export function parseSavedLayout(savedLayout: unknown): Layout | null {
  if (savedLayout === null || savedLayout === undefined) return null;
  const layoutParse = Layout.safeParse(keepKnownLayoutFields(savedLayout));
  if (layoutParse.success) return layoutParse.data;
  console.warn("ClickLess: the saved layout could not be read, so the default is shown.");
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A host that keeps the layout in its own storage may hand it back with fields
 * of its own, or with an absent `offeredValues` or `offScreen` written as null.
 * None of that makes the layout unusable, so they are left out before it is checked.
 */
function keepKnownLayoutFields(savedLayout: unknown): unknown {
  if (!isRecord(savedLayout) || !isRecord(savedLayout.items)) return savedLayout;
  const knownItems: Record<string, unknown> = {};
  for (const [componentId, savedItem] of Object.entries(savedLayout.items)) {
    if (!isRecord(savedItem)) return savedLayout;
    knownItems[componentId] = keepKnownItemFields(savedItem);
  }
  const { formatVersion, regionId, manifestVersion, order, offScreen } = savedLayout;
  return {
    formatVersion,
    regionId,
    manifestVersion,
    order,
    items: knownItems,
    ...(offScreen != null && { offScreen: keepKnownOffScreenFields(offScreen) }),
  };
}

function keepKnownItemFields(savedItem: Record<string, unknown>): unknown {
  const { w, h, hidden, props, offeredValues } = savedItem;
  return { w, h, hidden, props, ...(offeredValues != null && { offeredValues }) };
}

function keepKnownOffScreenFields(offScreen: unknown): unknown {
  if (!isRecord(offScreen) || !isRecord(offScreen.items)) return offScreen;
  const knownItems: Record<string, unknown> = {};
  for (const [componentId, savedItem] of Object.entries(offScreen.items)) {
    if (!isRecord(savedItem)) return offScreen;
    knownItems[componentId] = keepKnownItemFields(savedItem);
  }
  return { order: offScreen.order, items: knownItems };
}
