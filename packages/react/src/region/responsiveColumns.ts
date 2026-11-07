import { useCallback, useMemo, useSyncExternalStore } from "react";

/** A region's columns: one number, or the columns to draw from each screen width up, in pixels. */
export type RegionColumns = number | Readonly<Record<number, number>>;

interface ColumnBreakpoint {
  minWidth: number;
  columns: number;
}

/**
 * The columns a region's layout is kept in, and the columns it is drawn in on
 * this screen.
 *
 * With breakpoints, the layout is kept in the widest one's columns whatever the
 * screen, so the planner, the saved layout and every check see one grid, and a
 * change made on a phone does not narrow what the user set for a wide screen.
 * A narrower screen draws the same layout in fewer columns (see `drawnSpans`).
 * The server, and the first paint in the browser, draw the widest.
 */
export function useResponsiveColumns(columns: RegionColumns): { layoutColumns: number; drawnColumns: number } {
  const breakpointsKey = typeof columns === "number" ? String(columns) : JSON.stringify(columns);
  // Keyed by value, not identity, so an object literal written in the props is
  // read once rather than on every render.
  const breakpoints = useMemo(() => columnBreakpoints(columns), [breakpointsKey]);
  const layoutColumns = breakpoints.at(-1)!.columns;

  const mediaQueries = useMemo(
    () =>
      typeof window === "undefined" || typeof window.matchMedia !== "function"
        ? []
        : breakpoints.map(({ minWidth }) => window.matchMedia(`(min-width: ${minWidth}px)`)),
    [breakpoints],
  );
  const subscribeToBreakpoints = useCallback(
    (onBreakpointChange: () => void) => {
      mediaQueries.forEach((mediaQuery) => mediaQuery.addEventListener("change", onBreakpointChange));
      return () => mediaQueries.forEach((mediaQuery) => mediaQuery.removeEventListener("change", onBreakpointChange));
    },
    [mediaQueries],
  );
  const drawnColumns = useSyncExternalStore(
    subscribeToBreakpoints,
    () => {
      if (mediaQueries.length === 0) return layoutColumns;
      // The narrowest breakpoint also applies below its own width.
      let matchingBreakpoint = breakpoints[0]!;
      breakpoints.forEach((breakpoint, index) => {
        if (mediaQueries[index]!.matches) matchingBreakpoint = breakpoint;
      });
      return matchingBreakpoint.columns;
    },
    () => layoutColumns,
  );
  return { layoutColumns, drawnColumns };
}

/**
 * How many drawn columns an item `w` columns wide in the layout spans, on its
 * own: its share of the width, rounded. Used only before the region has
 * mounted; after that `drawnSpans` places whole rows.
 */
export function drawnSpan(width: number, layoutColumns: number, drawnColumns: number): number {
  if (drawnColumns >= layoutColumns) return Math.min(width, drawnColumns);
  return Math.min(drawnColumns, Math.max(1, Math.round((width * drawnColumns) / layoutColumns)));
}

/**
 * How many drawn columns each item spans, worked out a row at a time so the
 * rows stay as they are on a wide screen: an item covering columns `start` to
 * `end` of the wide grid covers the same share of the narrow one, rounded at
 * its edges, so the spans of one row add up to the drawn columns. Items are
 * given in the order they are drawn, with their width and height, and each
 * list is one grid.
 */
export function drawnSpans(
  grids: readonly (readonly { id: string; w: number; h: number }[])[],
  layoutColumns: number,
  drawnColumns: number,
): ReadonlyMap<string, number> {
  const spansByItemId = new Map<string, number>();
  for (const gridItems of grids) {
    for (const { id: itemId, start, width } of placeInGrid(gridItems, layoutColumns)) {
      const drawnStart = Math.round((start * drawnColumns) / layoutColumns);
      const drawnEnd = Math.round(((start + width) * drawnColumns) / layoutColumns);
      spansByItemId.set(itemId, Math.min(drawnColumns, Math.max(1, drawnEnd - drawnStart)));
    }
  }
  return spansByItemId;
}

/**
 * Where CSS grid's auto-placement puts each item: at the first place after the
 * one before it where its whole span is free, moving to the start of the next
 * row when it does not fit. The engine works out rows for the planner the same way.
 */
function placeInGrid(
  gridItems: readonly { id: string; w: number; h: number }[],
  columnCount: number,
): { id: string; start: number; width: number }[] {
  const occupiedCells = new Set<string>();
  const placements: { id: string; start: number; width: number }[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;
  for (const { id: itemId, w, h } of gridItems) {
    const width = Math.min(w, columnCount);
    let row = cursorRow;
    let column = cursorColumn;
    const spanIsFree = () => {
      for (let cellRow = row; cellRow < row + h; cellRow++) {
        for (let cellColumn = column; cellColumn < column + width; cellColumn++) {
          if (occupiedCells.has(`${cellRow},${cellColumn}`)) return false;
        }
      }
      return true;
    };
    while (column + width > columnCount || !spanIsFree()) {
      if (column + width > columnCount) {
        row += 1;
        column = 0;
      } else column += 1;
    }
    for (let cellRow = row; cellRow < row + h; cellRow++) {
      for (let cellColumn = column; cellColumn < column + width; cellColumn++) {
        occupiedCells.add(`${cellRow},${cellColumn}`);
      }
    }
    placements.push({ id: itemId, start: column, width });
    cursorRow = row;
    cursorColumn = column + width;
  }
  return placements;
}

function columnBreakpoints(columns: RegionColumns): ColumnBreakpoint[] {
  const breakpointEntries = typeof columns === "number" ? [[0, columns] as const] : Object.entries(columns);
  const breakpoints = breakpointEntries
    .map(([minWidth, columnCount]) => ({ minWidth: Number(minWidth), columns: columnCount }))
    .sort((firstBreakpoint, secondBreakpoint) => firstBreakpoint.minWidth - secondBreakpoint.minWidth);
  if (
    breakpoints.length === 0 ||
    breakpoints.some(
      ({ minWidth, columns: columnCount }) =>
        !(minWidth >= 0) || !Number.isInteger(columnCount) || columnCount < 1,
    )
  ) {
    throw new Error(
      "AdaptiveRegion's `columns` is a whole number of columns, or an object from screen widths in pixels to whole numbers of columns, such as { 0: 1, 768: 12 }.",
    );
  }
  if (breakpoints.some(({ columns: columnCount }) => columnCount > breakpoints.at(-1)!.columns)) {
    throw new Error("AdaptiveRegion's `columns`: a narrower screen cannot have more columns than a wider one.");
  }
  return breakpoints;
}
