import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  reconcileLayoutItem,
  type ApplyOperationsOutcome,
  type Capabilities,
  type Component,
  type LayoutItem,
  type PropValue,
} from "@clickless/core";
import { mergePresets } from "../presets/mergePresets";
import { presetsByName, type PresetSet, type PresetValues, type PropPreset } from "../presets/propPresets";
import { entriesOutOfOrder } from "../region/changedComponentIds";
import { drawnSpan } from "../region/responsiveColumns";
import { itemElementId, RegionContext, useIsomorphicLayoutEffect } from "../region/regionContext";

// Themed with CSS custom properties so it needs no stylesheet:
// --clickless-preview-outline (default 2px dashed accent; `none` turns it off),
// --clickless-preview-outline-offset (default 4px).

const UNUSABLE_COMPONENT_OR_PROP_NAME = "__proto__";

export interface AdaptiveProps<Presets extends PresetSet = PresetSet> {
  /**
   * Any name but "__proto__", which a saved layout cannot carry. The same goes
   * for prop names; note that one written as `{ __proto__: … }` is not an entry
   * at all in JavaScript, so that prop simply does not exist.
   */
  id: string;
  /** What the component is, in a word: "chart", "table", "card". Shown to the model. */
  kind?: string;
  /**
   * Human name, as a user would refer to it. Shown to the model, and to the
   * user in what the panel says. Without one the model is given the id, and
   * the user is told of "a section".
   */
  title?: string;
  description?: string;
  /** A locked component cannot be changed by any operation. */
  locked?: boolean;
  /**
   * Names the items that share one container of the page, such as the cards
   * of one tab or the links of one menu. Items are put in order only among
   * those with the same group, and a request to move one to another group is
   * refused with an explanation. Items without one form a group of their own.
   * In a region with `grid={false}`, only items with a group can be moved.
   */
  group?: string;
  /**
   * How users may arrange the component. Anything not declared is refused.
   *
   * - `move`, `hide`: on unless set to false. Moving is off for an item with no
   *   `group` in a region with `grid={false}`.
   * - `resize`: `{ minW, maxW, minH, maxH }`, in columns and rows. Off unless given.
   *
   * Settings users may change, such as a colour or which columns show, are
   * declared in `presets`.
   */
  capabilities?: Partial<Omit<Capabilities, "props">>;
  /**
   * `w` and `h` are the item's width in columns and height in rows. Give both
   * or neither: they are needed in a region's grid, and an item without them,
   * such as a button or a menu, is sized by the page and cannot be resized.
   */
  defaults?: Partial<Pick<LayoutItem, "w" | "h" | "hidden">>;
  /**
   * The settings users may change, from `propPresets`, each under a name of your
   * choosing. Use a built-in one when it fits, such as `{ rows: propPresets.density() }`;
   * otherwise a custom one, such as
   * `{ view: propPresets.choice({ values: ["day", "week"], initial: "week", means: "how much shows at once" }) }`.
   * Each brings its starting value and a sentence telling the model what it means,
   * added after `description`. A render-function child receives each one's current
   * value under the same name, as its third argument: ClickLess stores the value,
   * and what it changes on screen is up to you.
   *
   * @example
   * <Adaptive id="pipeline" title="Sales pipeline" defaults={{ w: 8, h: 4 }}
   *   presets={{ accent: propPresets.accent({ marks: "the deal that is due soonest" }) }}>
   *   {(props, adaptiveControls, presetValues) => <PipelineBoard accentColor={presetValues.accent} />}
   * </Adaptive>
   */
  presets?: Presets;
  className?: string;
  /**
   * Styles for the item's wrapper. `gridColumn` and `gridRow` are set by the
   * layout for an item with a size, `order` for an item in a region's grid or
   * in a group that has been moved, and `display` while the item is hidden,
   * so those are not taken from here.
   */
  style?: CSSProperties;
  /**
   * Set when the component outlines the parts a change reaches itself, with
   * `changeOutline`. Its own outline is then kept for what changes the whole
   * section: hiding, moving or resizing it.
   */
  marksChanges?: boolean;
  /**
   * Pass a function to receive the stored value of every prop the presets
   * declare, under its prop name (the name `setProp` takes), controls for
   * changing them from your own UI, and the current value of each preset in
   * `presets`, under the name given there.
   */
  children:
    | ReactNode
    | ((
        props: Record<string, PropValue>,
        adaptiveControls: AdaptiveControls,
        presetValues: PresetValues<Presets>,
      ) => ReactNode);
}

export interface AdaptiveControls {
  /**
   * Changes one of this component's props, as a prompt would: it is validated,
   * saved for the user and can be undone. Use it for controls you build
   * yourself, such as a column picker. Unlike a prompt's change, it takes effect
   * at once, without waiting for the engine, and its promise resolves at once:
   * it is saved behind the scenes, later if the engine cannot be reached.
   * Resolving means the change is shown, not saved: it is kept for the visit
   * only if it clashes with the user's saved layout or the engine refuses it.
   * `hasUnsavedChanges` from `useAdaptiveRegion` says whether any change is
   * still waiting to be saved.
   */
  setProp: (propName: string, propValue: PropValue) => Promise<ApplyOperationsOutcome>;
  /**
   * Whether a preview, or the original while "See original" shows it, draws
   * one of this component's props differently from the user's version. Give
   * the prop's name, or the name of a preset in `presets` for all of its props. With
   * `entry`, whether that entry of a list prop is new there or had to move,
   * such as one column of a table. False when neither is showing.
   */
  isChanged: (propName: string, entry?: string) => boolean;
  /**
   * The outline a changed section gets, for the part of this component that
   * shows `propName`, or one `entry` of it, where `isChanged` says it changed,
   * and nothing elsewhere. Pass it to that part's own `style`, such as
   * `<th style={adaptiveControls.changeOutline("columns", column)}>`, and set
   * `marksChanges` on the component.
   */
  changeOutline: (propName: string, entry?: string) => CSSProperties | undefined;
}

function readPresets<Presets extends PresetSet>(
  presetsWithNames: Record<string, PropPreset>,
  currentProps: Record<string, PropValue>,
): PresetValues<Presets> {
  return Object.fromEntries(
    Object.entries(presetsWithNames).map(([presetName, preset]) => [presetName, preset.read(currentProps)]),
  ) as PresetValues<Presets>;
}

export function Adaptive<Presets extends PresetSet = PresetSet>({
  id,
  kind = "component",
  title = id,
  description: ownDescription,
  locked = false,
  group,
  capabilities: ownCapabilities,
  defaults: ownDefaults = {},
  presets,
  className,
  style,
  marksChanges = false,
  children,
}: AdaptiveProps<Presets>) {
  const regionContext = useContext(RegionContext);
  if (!regionContext) throw new Error(`<Adaptive id="${id}"> must be rendered inside <AdaptiveRegion>`);
  if (
    (ownCapabilities && Object.hasOwn(ownCapabilities, "props")) ||
    Object.hasOwn(ownDefaults, "props")
  ) {
    throw new Error(
      `<Adaptive id="${id}">: settings users may change are declared in presets, ` +
        'such as presets={{ view: propPresets.choice({ values: ["day", "week"], initial: "week", means: "…" }) }}, ' +
        "not in capabilities.props or defaults.props.",
    );
  }
  if (Array.isArray(presets)) {
    throw new Error(
      `<Adaptive id="${id}">: give presets as an object, each under a name, ` +
        "such as presets={{ rows: propPresets.density() }}.",
    );
  }
  const presetsWithNames = presetsByName(presets ?? {});
  const { description, capabilities, defaults } = mergePresets(
    id,
    { description: ownDescription, capabilities: ownCapabilities, defaults: ownDefaults },
    Object.values(presetsWithNames),
  );
  // A saved layout is read back as JSON-like data, where an entry of this name
  // is lost. It is the one name that cannot be used; the engine refuses it too.
  if (
    id === UNUSABLE_COMPONENT_OR_PROP_NAME ||
    (capabilities?.props && Object.hasOwn(capabilities.props, UNUSABLE_COMPONENT_OR_PROP_NAME)) ||
    (defaults.props && Object.hasOwn(defaults.props, UNUSABLE_COMPONENT_OR_PROP_NAME))
  ) {
    throw new Error(
      `<Adaptive id="${id}">: no component or prop may be named "${UNUSABLE_COMPONENT_OR_PROP_NAME}". Choose another name.`,
    );
  }
  const {
    regionTag,
    regionStore,
    regionDrawsGrid,
    layoutColumns,
    drawnColumns,
    drawnSpans,
    initialLayout,
    initialOrder,
    firstPaintOrder,
  } = regionContext;
  const hasSize = defaults.w !== undefined;
  if (hasSize !== (defaults.h !== undefined)) {
    throw new Error(`<Adaptive id="${id}">: give defaults both a width and a height, or neither.`);
  }
  if (regionDrawsGrid && !hasSize) {
    throw new Error(
      `<Adaptive id="${id}"> needs defaults.w and defaults.h, because its region lays items out in a grid. ` +
        "If the page's own containers place it, give the region grid={false}.",
    );
  }
  if (capabilities?.resize && !hasSize) {
    throw new Error(`<Adaptive id="${id}"> can be resized only with a default size: give defaults.w and defaults.h.`);
  }
  if (!regionDrawsGrid && group === undefined && capabilities?.move) {
    throw new Error(
      `<Adaptive id="${id}"> can be moved only with a group, because its region has grid={false}. ` +
        "Give the items that share its container the same group.",
    );
  }

  // Callers pass object literals, so identity changes every render; compare by value.
  const componentDescriptorKey = JSON.stringify([
    id,
    kind,
    title,
    description,
    locked,
    group,
    regionDrawsGrid,
    capabilities,
    defaults,
  ]);
  const component = useMemo<Component>(
    () => ({
      id,
      kind,
      title,
      ...(description !== undefined && { description }),
      ...(locked && { locked }),
      ...(group !== undefined && { group }),
      capabilities: {
        // Without a grid, an item in no group has nothing it is known to share a container with.
        move: capabilities?.move ?? (regionDrawsGrid || group !== undefined),
        hide: capabilities?.hide ?? true,
        ...(capabilities?.resize && { resize: capabilities.resize }),
        ...(capabilities?.props && { props: capabilities.props }),
      },
      defaults: {
        ...(defaults.w !== undefined && { w: defaults.w }),
        ...(defaults.h !== undefined && { h: defaults.h }),
        hidden: defaults.hidden ?? false,
        props: defaults.props ?? {},
      },
    }),
    // componentDescriptorKey stands in for id, kind, title, description, locked, group, regionDrawsGrid,
    // capabilities and defaults, compared by value.
    [componentDescriptorKey],
  );

  const itemElement = useRef<HTMLDivElement>(null);
  useIsomorphicLayoutEffect(
    () => regionStore.registerComponent(component, itemElement.current),
    [regionStore, component],
  );

  const { manifest, layout, preview, original, changedComponentIds } = useSyncExternalStore(
    regionStore.subscribe,
    regionStore.getSnapshot,
    regionStore.getServerSnapshot,
  );

  // Until the region has mounted (the first render, and on the server) there is
  // only the saved layout as it was stored, perhaps for an older version of this
  // component, so its settings are corrected here the way the store corrects
  // them later, and it is drawn where the store will put it.
  // Asked for by name, so that an id such as "constructor" finds only an entry that is there.
  // A component that was off screen when the layout was saved has its settings set aside.
  const savedItem = !initialLayout
    ? undefined
    : Object.hasOwn(initialLayout.items, id)
      ? initialLayout.items[id]
      : initialLayout.offScreen && Object.hasOwn(initialLayout.offScreen.items, id)
        ? initialLayout.offScreen.items[id]
        : undefined;
  const startingItem = useMemo(
    () => (savedItem ? reconcileLayoutItem(component, savedItem, layoutColumns) : component.defaults),
    [component, savedItem, layoutColumns],
  );
  const shownLayout = preview ?? original ?? layout;
  const shownItem = shownLayout
    ? ((Object.hasOwn(shownLayout.items, id) ? shownLayout.items[id] : undefined) ?? component.defaults)
    : startingItem;
  // A preview or the original is drawn in place of the user's version, which it is compared with.
  const comparedLayout = shownLayout !== layout ? layout : null;
  const comparedItem =
    comparedLayout && Object.hasOwn(comparedLayout.items, id) ? comparedLayout.items[id] : undefined;
  const sectionChanged = changedComponentIds.has(id);
  // What is compared, as text, and only while this section changed, so the
  // controls stay the same object through changes that do not reach it.
  const changeKey = sectionChanged ? JSON.stringify([shownItem.props, comparedItem?.props ?? null]) : "";
  // Each preset's props, by its name, as text, so the controls change only when they do.
  const presetPropNames = JSON.stringify(
    Object.entries(presetsWithNames).map(([presetName, preset]) => [presetName, Object.keys(preset.capabilities)]),
  );
  const setProp = useCallback<AdaptiveControls["setProp"]>(
    (propName, propValue) => regionStore.applyOperations([{ type: "setProp", id, prop: propName, value: propValue }]),
    [regionStore, id],
  );
  const adaptiveControls = useMemo<AdaptiveControls>(() => {
    const propsOfPreset = new Map<string, string[]>(JSON.parse(presetPropNames));
    const [shownProps, comparedProps] = changeKey
      ? (JSON.parse(changeKey) as [Record<string, PropValue>, Record<string, PropValue> | null])
      : [{}, null];
    const isChanged = (propName: string, entry?: string): boolean => {
      if (!changeKey) return false;
      // A preset's name stands for every prop it declares, such as a highlight's amount and colour.
      const presetProps = Object.hasOwn(shownProps, propName) ? undefined : propsOfPreset.get(propName);
      if (presetProps) return presetProps.some((presetProp) => isChanged(presetProp, entry));
      const shownValue = Object.hasOwn(shownProps, propName) ? shownProps[propName] : undefined;
      const comparedValue = comparedProps && Object.hasOwn(comparedProps, propName) ? comparedProps[propName] : undefined;
      if (entry === undefined) return JSON.stringify(shownValue) !== JSON.stringify(comparedValue);
      if (!Array.isArray(shownValue)) return false;
      const listedEntries = (listValue: unknown) => (Array.isArray(listValue) ? listValue.map(String) : []);
      return entriesOutOfOrder(listedEntries(comparedValue), listedEntries(shownValue)).has(entry);
    };
    return {
      setProp,
      isChanged,
      changeOutline: (propName, entry) => (isChanged(propName, entry) ? CHANGE_OUTLINE : undefined),
    };
  }, [setProp, changeKey, presetPropNames]);
  // A component that marks its own changed parts is outlined whole only for
  // what changes the section itself.
  const outlinesSection =
    sectionChanged &&
    (!marksChanges ||
      !comparedItem ||
      shownItem.hidden !== comparedItem.hidden ||
      shownItem.w !== comparedItem.w ||
      shownItem.h !== comparedItem.h ||
      (comparedLayout !== null && shownLayout !== null && entriesOutOfOrder(comparedLayout.order, shownLayout.order).has(id)));
  const orderPosition = shownLayout
    ? shownLayout.order.indexOf(id)
    : initialLayout
      ? firstPaintOrder.placeItem(id, savedItem ? initialOrder.indexOf(id) : -1)
      : -1;
  // In the region's own grid every item is placed, as only items share it.
  // Without a grid the containers are the host's, so an item is given a place
  // only while its group is drawn in an order other than the one written, and
  // that place counts within the group: elements of the host's own beside a
  // group that has never moved, or that cannot, are left where they are.
  let drawOrder: number | undefined;
  if (regionDrawsGrid) {
    if (shownLayout ? orderPosition >= 0 : initialLayout !== undefined) drawOrder = orderPosition;
  } else if (group !== undefined && manifest && shownLayout) {
    const writtenGroupOrder = manifest.components
      .filter((siblingComponent) => siblingComponent.group === group)
      .map((siblingComponent) => siblingComponent.id);
    const shownGroupOrder = shownLayout.order.filter((itemId) => writtenGroupOrder.includes(itemId));
    if (shownGroupOrder.some((itemId, position) => writtenGroupOrder[position] !== itemId)) {
      drawOrder = shownGroupOrder.indexOf(id);
    }
  }

  const itemContent = shownItem.hidden
    ? null
    : typeof children === "function"
      ? children(shownItem.props, adaptiveControls, readPresets<Presets>(presetsWithNames, shownItem.props))
      : children;

  return (
    <div
      ref={itemElement}
      id={itemElementId(regionTag, id)}
      data-clickless-item={id}
      data-clickless-preview={outlinesSection ? "changed" : undefined}
      hidden={shownItem.hidden}
      className={className}
      // What places, orders and hides the item comes after the host's own
      // style, so a `display` or `order` set there cannot undo the layout.
      style={{
        minWidth: 0,
        // An item with a height is a cell of the grid. When its content is one
        // element, such as a card or a chart, that element fills the cell, so it
        // grows and shrinks as the item is resized without being told to be 100%
        // tall. Other content flows as written. Content with a height of its own
        // in pixels keeps it. A `display` in the host's style wins.
        ...(shownItem.h !== undefined &&
          isSingleElement(itemContent) && { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }),
        // A changed section is outlined, unless it marks its own changed parts,
        // so users see what Keep will save. A host `style` comes after it, so
        // one section can restyle it.
        ...(outlinesSection && CHANGE_OUTLINE),
        ...style,
        ...(shownItem.w !== undefined && {
          gridColumn: `span ${drawnSpans?.get(id) ?? drawnSpan(shownItem.w, layoutColumns, drawnColumns)}`,
        }),
        ...(shownItem.h !== undefined && { gridRow: `span ${shownItem.h}` }),
        ...(drawOrder !== undefined && { order: drawOrder }),
        ...(shownItem.hidden && { display: "none" }),
      }}
    >
      {itemContent}
    </div>
  );
}

const PREVIEW_OUTLINE =
  "var(--clickless-preview-outline, 2px dashed var(--clickless-accent, var(--clickless-built-in-accent, #1c5cab)))";
const PREVIEW_OUTLINE_OFFSET = "var(--clickless-preview-outline-offset, 4px)";
const CHANGE_OUTLINE: CSSProperties = { outline: PREVIEW_OUTLINE, outlineOffset: PREVIEW_OUTLINE_OFFSET };

/** One element, not a list, a fragment or text, so it can be stretched to fill a cell alone. */
function isSingleElement(itemContent: ReactNode): boolean {
  const contentNodes = Children.toArray(itemContent);
  return contentNodes.length === 1 && isValidElement(contentNodes[0]) && contentNodes[0].type !== Fragment;
}
