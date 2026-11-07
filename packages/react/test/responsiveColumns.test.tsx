// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, useAdaptiveRegion } from "../src/index";

type RegionApi = ReturnType<typeof useAdaptiveRegion>;

/** A screen whose width the test sets, answering media queries the way a browser does. */
let screenWidth = 1024;
const mediaQueries: { minWidth: number; listeners: Set<() => void> }[] = [];
function resizeScreen(width: number) {
  screenWidth = width;
  for (const mediaQuery of mediaQueries) mediaQuery.listeners.forEach((changeListener) => changeListener());
}
beforeEach(() => {
  screenWidth = 1024;
  mediaQueries.length = 0;
  window.matchMedia = (mediaQueryText: string) => {
    const mediaQuery = { minWidth: Number(/min-width: (\d+)px/.exec(mediaQueryText)![1]), listeners: new Set<() => void>() };
    mediaQueries.push(mediaQuery);
    return {
      get matches() {
        return screenWidth >= mediaQuery.minWidth;
      },
      addEventListener: (_eventType: string, changeListener: () => void) => mediaQuery.listeners.add(changeListener),
      removeEventListener: (_eventType: string, changeListener: () => void) => mediaQuery.listeners.delete(changeListener),
    } as unknown as MediaQueryList;
  };
});
afterEach(cleanup);

function renderDashboard() {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return null;
  }
  const renderResult = render(
    <AdaptiveProvider userId="user-1">
      <RegionApiProbe />
      <AdaptiveRegion id="dashboard" version="1" columns={{ 0: 1, 640: 6, 1024: 12 }}>
        <Adaptive id="revenue" capabilities={{ resize: { minW: 3, maxW: 12, minH: 1, maxH: 6 } }} defaults={{ w: 6, h: 3 }}>
          revenue
        </Adaptive>
        <Adaptive id="sales" defaults={{ w: 4, h: 3 }}>
          sales
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  const spanOf = (itemId: string) =>
    renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${itemId}"]`)!.style.gridColumn;
  const drawnGridColumns = () =>
    renderResult.container.querySelector<HTMLElement>("[data-clickless-region]")!.style.gridTemplateColumns;
  return { regionApi: () => regionApiValue, spanOf, drawnGridColumns };
}

describe("a region with fewer columns on narrow screens", () => {
  it("draws the same layout in the columns of the screen it is on, each item keeping its share", () => {
    const { spanOf, drawnGridColumns } = renderDashboard();
    expect([drawnGridColumns(), spanOf("revenue"), spanOf("sales")]).toEqual([
      "repeat(12, minmax(0, 1fr))",
      "span 6",
      "span 4",
    ]);

    act(() => resizeScreen(800));
    expect([drawnGridColumns(), spanOf("revenue"), spanOf("sales")]).toEqual([
      "repeat(6, minmax(0, 1fr))",
      "span 3",
      "span 2",
    ]);

    act(() => resizeScreen(390));
    expect([drawnGridColumns(), spanOf("revenue"), spanOf("sales")]).toEqual([
      "repeat(1, minmax(0, 1fr))",
      "span 1",
      "span 1",
    ]);
  });

  it("keeps the layout in the widest grid, so a change made on a phone keeps the widths set for wide screens", async () => {
    const { regionApi, spanOf } = renderDashboard();
    act(() => resizeScreen(390));
    expect(regionApi().manifest!.columns).toBe(12);

    await act(() => regionApi().applyOperations([{ type: "resize", id: "revenue", w: 9 }]));
    expect(regionApi().layout!.items.revenue!.w).toBe(9);
    expect(regionApi().layout!.items.sales!.w).toBe(4);

    act(() => resizeScreen(1280));
    expect([spanOf("revenue"), spanOf("sales")]).toEqual(["span 9", "span 4"]);
  });

  it("refuses columns that grow as the screen narrows", () => {
    expect(() =>
      render(
        <AdaptiveProvider userId="user-1">
          <AdaptiveRegion id="dashboard" version="1" columns={{ 0: 12, 768: 6 }}>
            <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
              revenue
            </Adaptive>
          </AdaptiveRegion>
        </AdaptiveProvider>,
      ),
    ).toThrow(/narrower screen cannot have more columns/);
  });
});

describe("a row on a screen with fewer columns", () => {
  it("still holds the items it holds on a wide screen, its spans adding up to the columns drawn", () => {
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <AdaptiveRegion id="kpis" version="1" columns={{ 0: 1, 640: 6, 1024: 12 }}>
          {["a", "b", "c", "d"].map((itemId) => (
            <Adaptive key={itemId} id={itemId} defaults={{ w: 3, h: 1 }}>
              <div>{itemId}</div>
            </Adaptive>
          ))}
          <Adaptive id="chart" defaults={{ w: 7, h: 2 }}>
            <div>chart</div>
          </Adaptive>
          <Adaptive id="recent-orders" defaults={{ w: 5, h: 2 }}>
            <div>recent orders</div>
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    act(() => resizeScreen(800));
    const spanOf = (itemId: string) =>
      Number(
        renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${itemId}"]`)!.style.gridColumn.slice(5),
      );
    expect(["a", "b", "c", "d"].map(spanOf).reduce((total, span) => total + span)).toBe(6);
    expect(spanOf("chart") + spanOf("recent-orders")).toBe(6);
  });
});

describe("an item's content", () => {
  it("fills the item's cell when it is one element and the item has a height, unless the host lays the item out itself", () => {
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <AdaptiveRegion id="page" version="1" grid={false}>
          <Adaptive id="card" defaults={{ w: 6, h: 3 }}>
            <section>card</section>
          </Adaptive>
          <Adaptive id="total" defaults={{ w: 6, h: 3 }}>
            Total: <strong>42</strong>
          </Adaptive>
          <Adaptive id="heading-and-chart" defaults={{ w: 6, h: 3 }}>
            <h2>Chart</h2>
            <div>chart</div>
          </Adaptive>
          <Adaptive id="button">
            <button>button</button>
          </Adaptive>
          <Adaptive id="list" defaults={{ w: 6, h: 3 }} style={{ display: "flex" }}>
            <ul />
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    const displayOf = (itemId: string) =>
      renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${itemId}"]`)!.style.display;
    expect(
      ["card", "total", "heading-and-chart", "button", "list"].map(displayOf),
    ).toEqual(["grid", "", "", "", "flex"]);
  });
});
