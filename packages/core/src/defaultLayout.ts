import { setOwnProperty } from "./ownProperties";
import { clonePropValue } from "./propValues";
import { Layout, type Component, type LayoutItem, type Manifest } from "./schemas.gen";

/** The layout shape this SDK writes and reads, as the schema states it. */
export const LAYOUT_FORMAT_VERSION = Layout.shape.formatVersion.value;

export function cloneLayoutItem(layoutItem: LayoutItem): LayoutItem {
  const clonedProps: LayoutItem["props"] = {};
  for (const [propName, propValue] of Object.entries(layoutItem.props)) {
    setOwnProperty(clonedProps, propName, clonePropValue(propValue));
  }
  const clonedLayoutItem: LayoutItem = {
    ...withSize(layoutItem.w, layoutItem.h),
    hidden: layoutItem.hidden,
    props: clonedProps,
  };
  if (layoutItem.offeredValues) {
    clonedLayoutItem.offeredValues = {};
    for (const [propName, offeredValues] of Object.entries(layoutItem.offeredValues)) {
      setOwnProperty(clonedLayoutItem.offeredValues, propName, [...offeredValues]);
    }
  }
  return clonedLayoutItem;
}

/** A width and a height for a layout item, leaving out whichever the component does not have. */
export function withSize(width: number | undefined, height: number | undefined): Pick<LayoutItem, "w" | "h"> {
  return { ...(width !== undefined && { w: width }), ...(height !== undefined && { h: height }) };
}

/** The values each of a component's list props offers, to record alongside a saved item. */
export function offeredValuesOf(component: Component): LayoutItem["offeredValues"] {
  const offeredValues: NonNullable<LayoutItem["offeredValues"]> = {};
  for (const [propName, propCapabilities] of Object.entries(component.capabilities.props ?? {})) {
    if ("values" in propCapabilities && propCapabilities.multiple) {
      setOwnProperty(offeredValues, propName, [...propCapabilities.values]);
    }
  }
  return Object.keys(offeredValues).length > 0 ? offeredValues : undefined;
}

export function defaultLayoutItem(component: Component): LayoutItem {
  const { w: width, h: height, hidden, props } = cloneLayoutItem(component.defaults);
  const offeredValues = offeredValuesOf(component);
  return { ...withSize(width, height), hidden, props, ...(offeredValues && { offeredValues }) };
}

export function defaultLayout(manifest: Manifest): Layout {
  const layoutItems: Layout["items"] = {};
  for (const component of manifest.components) {
    setOwnProperty(layoutItems, component.id, defaultLayoutItem(component));
  }
  return {
    formatVersion: LAYOUT_FORMAT_VERSION,
    regionId: manifest.regionId,
    manifestVersion: manifest.version,
    order: manifest.components.map((component) => component.id),
    items: layoutItems,
  };
}

/** True when the layout holds exactly the manifest's components, each once. */
export function layoutMatchesManifest(manifest: Manifest, layout: Layout): boolean {
  const componentIds = manifest.components.map((component) => component.id);
  return (
    layout.regionId === manifest.regionId &&
    layout.order.length === componentIds.length &&
    new Set(layout.order).size === componentIds.length &&
    Object.keys(layout.items).length === componentIds.length &&
    componentIds.every(
      (componentId) => layout.order.includes(componentId) && Object.hasOwn(layout.items, componentId),
    )
  );
}
