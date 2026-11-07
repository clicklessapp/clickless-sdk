import {
  useEffect,
  useId,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { savedOrderOfKnownComponents, type Layout, type Manifest } from "@clickless/core";
import {
  itemElementId,
  RegionContext,
  useIsomorphicLayoutEffect,
  useRegionStore,
} from "../region/regionContext";
import { FirstPaintOrder } from "../region/firstPaintOrder";
import type { LayoutChangeHandler } from "../region/regionStore";
import { drawnSpans, useResponsiveColumns, type RegionColumns } from "../region/responsiveColumns";
import { parseSavedLayout } from "../region/savedLayoutParsing";
import { useSettleIntoSavedLayout } from "../region/settleIntoSavedLayout";

export interface AdaptiveRegionProps {
  id: string;
  /**
   * Bump when a release changes the set of components or their capabilities.
   * Components that merely come and go while the application runs, such as
   * the content of a tab, need nothing: what the user set on them is kept
   * while they are off screen.
   */
  version: string;
  /**
   * Whether the region lays its items out in a grid of its own, as it does
   * unless told otherwise. With `false` it draws nothing of its own: each item
   * stays in whichever of your containers it is written in, such as a header,
   * a menu or your own card grid, and the region can span all of them. Items
   * that share a container are given the same `group`, and only items with a
   * group can be moved. `className` and `style` are not used then.
   */
  grid?: boolean;
  /**
   * Columns in the region's grid. With `grid={false}`, the columns of your own
   * grids that items with a size sit in, which is as wide as they can be made.
   *
   * For a grid that has fewer columns on narrow screens, give the columns from
   * each screen width up, in pixels, such as `{ 0: 1, 768: 12 }`. Users arrange
   * the widest grid; a narrower screen draws that arrangement in its own
   * columns, each item keeping its share of the width, so a change made on a
   * phone keeps what was set for a wide screen. With `grid={false}`, use the
   * same widths and columns as your own grids.
   */
  columns?: RegionColumns;
  /**
   * What users call this part of the screen, such as "Sidebar". Give one to
   * each region when a prompt bar speaks for several, so that "in the sidebar"
   * is understood and replies can say where a change was made.
   */
  title?: string;
  /**
   * Height of one row of the grid, in pixels, or `"auto"` for rows as tall as
   * their content, such as a table whose height follows its rows.
   */
  rowHeight?: number | "auto";
  /** Gap between items, in pixels. */
  gap?: number;
  /**
   * The user's saved layout. Read once, when the region first mounts. One that
   * cannot be read is ignored and the default is shown. With an engine it is
   * only what shows until the engine's own copy arrives, which then replaces it.
   */
  initialLayout?: Layout;
  /** Called after every committed change. Persist the layout here. */
  onLayoutChange?: LayoutChangeHandler;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function AdaptiveRegion({
  id,
  version,
  grid = true,
  columns = 12,
  title,
  rowHeight = 80,
  gap = 16,
  initialLayout,
  onLayoutChange,
  className,
  style,
  children,
}: AdaptiveRegionProps) {
  const regionStore = useRegionStore(id);
  const { layoutColumns, drawnColumns } = useResponsiveColumns(columns);
  const startingLayout = useMemo(
    () => parseSavedLayout(initialLayout) ?? undefined,
    // initialLayout is deliberately read only when a region first mounts: once per id.
    [id],
  );

  useIsomorphicLayoutEffect(
    () =>
      regionStore.mountRegion(
        {
          regionId: id,
          version,
          columns: layoutColumns,
          ...(title !== undefined && { title }),
          ...(!grid && { grid: false as const }),
        },
        startingLayout,
      ),
    [regionStore, id, version, layoutColumns, title, grid, startingLayout],
  );

  useEffect(() => {
    regionStore.drawnColumns = drawnColumns;
  }, [regionStore, drawnColumns]);

  useEffect(() => {
    regionStore.onLayoutChange = onLayoutChange;
    return () => {
      regionStore.onLayoutChange = undefined;
    };
  }, [regionStore, onLayoutChange]);

  // React wraps the tag in punctuation that differs between versions; its letters
  // and digits are what make it unique.
  const regionTag = useId().replace(/[^A-Za-z0-9]/g, "");

  const { manifest, layout, preview, original } = useSyncExternalStore(
    regionStore.subscribe,
    regionStore.getSnapshot,
    regionStore.getServerSnapshot,
  );
  const shownLayout = preview ?? original ?? layout;
  useSettleIntoSavedLayout(regionStore, shownLayout);
  // On a screen with fewer columns than the layout, each row is redrawn in
  // them as a whole, so items that share a row on a wide screen still do.
  const spansOnThisScreen = useMemo(
    () =>
      manifest && shownLayout && drawnColumns < layoutColumns
        ? drawnSpans(gridsOf(manifest, shownLayout, grid), layoutColumns, drawnColumns)
        : null,
    [manifest, shownLayout, grid, layoutColumns, drawnColumns],
  );
  const regionContextValue = useMemo(
    () => ({
      regionTag,
      regionStore,
      regionDrawsGrid: grid,
      layoutColumns,
      drawnColumns,
      drawnSpans: spansOnThisScreen,
      initialLayout: startingLayout,
      initialOrder: startingLayout ? savedOrderOfKnownComponents(startingLayout) : [],
      firstPaintOrder: new FirstPaintOrder(),
    }),
    [regionTag, regionStore, grid, layoutColumns, drawnColumns, spansOnThisScreen, startingLayout],
  );
  // Items are moved by drawing them in another order, not by moving them in the
  // page, so a screen reader would still meet them in the order they were
  // written. Once that differs from what is shown, the region lists its items
  // in the shown order, which is the order they are then read in.
  const visibleItemElementIds = (itemIds: readonly string[]) =>
    itemIds
      .filter((itemId) => !shownLayout?.items[itemId]?.hidden)
      .map((itemId) => itemElementId(regionTag, itemId))
      .join(" ");
  const orderDiffersFromManifest =
    manifest !== null &&
    shownLayout !== null &&
    shownLayout.order.some((itemId, position) => manifest.components[position]?.id !== itemId);
  const itemElementIdsInShownOrder =
    grid && orderDiffersFromManifest ? visibleItemElementIds(shownLayout.order) : undefined;

  // Without a grid, the items' containers are the page's own, so each group is
  // listed in the shown order on its own container, and only where that
  // container holds nothing but the group's items: listing them would otherwise
  // move the rest of its contents ahead of them for a screen reader.
  useIsomorphicLayoutEffect(() => {
    if (grid || !manifest || !shownLayout) return;
    const restoreContainerAttributes: (() => void)[] = [];
    for (const writtenOrder of itemIdsByGroup(manifest)) {
      const shownOrder = shownLayout.order.filter((itemId) => writtenOrder.includes(itemId));
      if (shownOrder.every((itemId, position) => writtenOrder[position] === itemId)) continue;
      const groupContainer = regionStore.elementOf(writtenOrder[0]!)?.parentElement;
      if (
        !groupContainer ||
        groupContainer.children.length !== writtenOrder.length ||
        writtenOrder.some((itemId) => regionStore.elementOf(itemId)?.parentElement !== groupContainer)
      ) {
        continue;
      }
      const previousAriaOwns = groupContainer.getAttribute("aria-owns");
      groupContainer.setAttribute("aria-owns", visibleItemElementIds(shownOrder));
      restoreContainerAttributes.push(() =>
        previousAriaOwns === null
          ? groupContainer.removeAttribute("aria-owns")
          : groupContainer.setAttribute("aria-owns", previousAriaOwns),
      );
    }
    return () => restoreContainerAttributes.forEach((restoreContainerAttribute) => restoreContainerAttribute());
  }, [grid, manifest, shownLayout, regionStore, regionTag]);

  if (!grid) return <RegionContext.Provider value={regionContextValue}>{children}</RegionContext.Provider>;

  return (
    <RegionContext.Provider value={regionContextValue}>
      <div
        data-clickless-region={id}
        aria-owns={itemElementIdsInShownOrder}
        className={className}
        style={{
          display: "grid",
          // Where the browser supports it, the Tab key and screen readers follow
          // the order items are drawn in. Elsewhere it is ignored.
          ...({ readingFlow: "grid-order" } as CSSProperties),
          gridTemplateColumns: `repeat(${drawnColumns}, minmax(0, 1fr))`,
          gridAutoRows: rowHeight === "auto" ? "auto" : rowHeight,
          gap,
          ...style,
        }}
      >
        {children}
      </div>
    </RegionContext.Provider>
  );
}

/** The ids of each named group's items, in the order they are written. */
function itemIdsByGroup(manifest: Manifest): string[][] {
  const itemIdsByGroupName = new Map<string, string[]>();
  for (const component of manifest.components) {
    if (component.group === undefined) continue;
    const groupItemIds = itemIdsByGroupName.get(component.group) ?? [];
    groupItemIds.push(component.id);
    itemIdsByGroupName.set(component.group, groupItemIds);
  }
  return [...itemIdsByGroupName.values()];
}

/**
 * The items with a size that are drawn, in the order they are drawn, one list
 * for each grid they sit in: the region's own, or without one, each group's
 * container. An item without a group sits in a container of its own.
 */
function gridsOf(
  manifest: Manifest,
  layout: Layout,
  regionDrawsGrid: boolean,
): { id: string; w: number; h: number }[][] {
  const groupByComponentId = new Map(manifest.components.map((component) => [component.id, component.group]));
  const gridItemsByKey = new Map<string, { id: string; w: number; h: number }[]>();
  for (const itemId of layout.order) {
    const layoutItem = Object.hasOwn(layout.items, itemId) ? layout.items[itemId] : undefined;
    if (
      !layoutItem ||
      layoutItem.hidden ||
      layoutItem.w === undefined ||
      layoutItem.h === undefined ||
      !groupByComponentId.has(itemId)
    ) {
      continue;
    }
    const gridKey = regionDrawsGrid ? "" : (groupByComponentId.get(itemId) ?? `item:${itemId}`);
    const gridItems = gridItemsByKey.get(gridKey) ?? [];
    gridItems.push({ id: itemId, w: layoutItem.w, h: layoutItem.h });
    gridItemsByKey.set(gridKey, gridItems);
  }
  return [...gridItemsByKey.values()];
}
