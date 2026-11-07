// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, useAdaptiveRegion } from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type RegionApi = ReturnType<typeof useAdaptiveRegion>;

/**
 * A page laid out by its own containers: a header row of tools, a column
 * holding the tab pills next to something the SDK does not manage, and a card
 * grid. One region spans all of them without adding a box of its own.
 */
function renderPage() {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("page");
    return null;
  }
  const renderResult = render(
    <StrictMode>
      <AdaptiveProvider userId="user-1">
        <RegionApiProbe />
        <AdaptiveRegion id="page" version="1" grid={false}>
          <header data-testid="header" style={{ display: "flex" }}>
            <Adaptive id="search" title="Search" group="header">
              search
            </Adaptive>
            <Adaptive id="theme" title="Theme switch" group="header">
              theme
            </Adaptive>
            <Adaptive id="profile" title="Profile menu" group="header" capabilities={{ move: false }}>
              profile
            </Adaptive>
          </header>
          <div data-testid="tabs" style={{ display: "flex", flexDirection: "column" }}>
            <Adaptive id="pills" title="Section tabs">
              pills
            </Adaptive>
            <section>tab contents</section>
          </div>
          <div data-testid="cards" style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)" }}>
            <Adaptive
              id="revenue"
              title="Total Revenue"
              group="overview-cards"
              capabilities={{ resize: { minW: 2, maxW: 12, minH: 1, maxH: 3 } }}
              defaults={{ w: 3, h: 2 }}
            >
              revenue
            </Adaptive>
            <Adaptive id="sales" title="Sales" group="overview-cards" defaults={{ w: 3, h: 2 }}>
              sales
            </Adaptive>
          </div>
        </AdaptiveRegion>
      </AdaptiveProvider>
    </StrictMode>,
  );
  const itemElement = (componentId: string) =>
    renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!;
  return { renderResult, itemElement, regionApi: () => regionApiValue };
}

/** The items a container lists for screen readers, in the order it lists them. */
function listedItemIds(container: HTMLElement): (string | undefined)[] | null {
  return (
    container
      .getAttribute("aria-owns")
      ?.split(" ")
      .map((elementId) => document.getElementById(elementId)?.dataset.clicklessItem) ?? null
  );
}

describe("a region with grid={false}", () => {
  it("adds no element of its own, so each item stays in the page's own container", () => {
    const { renderResult, itemElement } = renderPage();
    expect(renderResult.container.querySelector("[data-clickless-region]")).toBeNull();
    expect(itemElement("search").parentElement).toBe(renderResult.getByTestId("header"));
    expect(itemElement("revenue").parentElement).toBe(renderResult.getByTestId("cards"));
  });

  it("describes groups and sizes in the manifest, and offers moving only to items with a group", () => {
    const { regionApi } = renderPage();
    const componentsById = new Map(regionApi().manifest!.components.map((component) => [component.id, component]));
    expect(componentsById.get("search")).toMatchObject({ group: "header", capabilities: { move: true } });
    expect(componentsById.get("search")!.defaults).toEqual({ hidden: false, props: {} });
    expect(componentsById.get("pills")!.group).toBeUndefined();
    expect(componentsById.get("pills")!.capabilities.move).toBe(false);
    expect(componentsById.get("revenue")!.defaults).toMatchObject({ w: 3, h: 2 });
  });

  it("sizes only the items that have a size, in the page's own grid", () => {
    const { itemElement } = renderPage();
    expect(itemElement("search").style.gridColumn).toBe("");
    expect(itemElement("search").style.gridRow).toBe("");
    expect(itemElement("revenue").style.gridColumn).toBe("span 3");
    expect(itemElement("revenue").style.gridRow).toBe("span 2");
  });

  it("gives places in the order only within a group that has been moved", async () => {
    const { itemElement, regionApi } = renderPage();
    const drawOrders = (itemIds: string[]) => itemIds.map((itemId) => itemElement(itemId).style.order);
    expect(drawOrders(["search", "theme", "profile", "pills", "revenue", "sales"])).toEqual(["", "", "", "", "", ""]);
    await act(() => regionApi().applyOperations([{ type: "move", id: "search", position: "end" }]));
    expect(drawOrders(["theme", "profile", "search"])).toEqual(["0", "1", "2"]);
    expect(drawOrders(["pills", "revenue", "sales"])).toEqual(["", "", ""]);
  });

  it("refuses to move an item into another group, and changes nothing", async () => {
    const { regionApi } = renderPage();
    const layoutBefore = regionApi().layout;
    let applyOutcome!: Awaited<ReturnType<RegionApi["applyOperations"]>>;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations([
        { type: "move", id: "sales", position: "before", targetId: "search" },
      ]);
    });
    expect(applyOutcome.applied).toBe(false);
    expect(applyOutcome.applied ? [] : applyOutcome.errors.map((operationError) => operationError.code)).toEqual(["invalid_target"]);
    expect(regionApi().layout).toBe(layoutBefore);
  });

  it("lists a moved group in its shown order on its own container only", async () => {
    const { renderResult, regionApi } = renderPage();
    const headerElement = renderResult.getByTestId("header");
    expect(headerElement.hasAttribute("aria-owns")).toBe(false);
    await act(() =>
      regionApi().applyOperations([
        { type: "move", id: "search", position: "after", targetId: "theme" },
        { type: "move", id: "sales", position: "start" },
      ]),
    );
    expect(listedItemIds(headerElement)).toEqual(["theme", "search", "profile"]);
    expect(listedItemIds(renderResult.getByTestId("cards"))).toEqual(["sales", "revenue"]);
    expect(renderResult.getByTestId("tabs").hasAttribute("aria-owns")).toBe(false);
    await act(() => regionApi().applyOperations([{ type: "reset" }]));
    expect(headerElement.hasAttribute("aria-owns")).toBe(false);
  });

  it("leaves a container's reading order alone when it also holds things the region does not manage", async () => {
    let regionApiValue!: RegionApi;
    function RegionApiProbe() {
      regionApiValue = useAdaptiveRegion("menu");
      return null;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <RegionApiProbe />
        <AdaptiveRegion id="menu" version="1" grid={false}>
          <ul data-testid="menu">
            <Adaptive id="general" group="menu">
              general
            </Adaptive>
            <Adaptive id="pages" group="menu">
              pages
            </Adaptive>
            <li>help</li>
          </ul>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    await act(() => regionApiValue.applyOperations([{ type: "move", id: "pages", position: "start" }]));
    expect(renderResult.getByTestId("menu").hasAttribute("aria-owns")).toBe(false);
  });
});

describe("rowHeight", () => {
  it('makes rows as tall as their content with "auto"', () => {
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <AdaptiveRegion id="tasks" version="1" rowHeight="auto">
          <Adaptive id="table" defaults={{ w: 12, h: 1 }}>
            table
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    const regionElement = renderResult.container.querySelector<HTMLElement>('[data-clickless-region="tasks"]')!;
    expect(regionElement.style.gridAutoRows).toBe("auto");
    expect(regionElement.style.display).toBe("grid");
  });
});

describe("sizes and groups that cannot work", () => {
  const renderAlone = (misconfiguredRegion: ReactNode) => render(<AdaptiveProvider userId="user-1">{misconfiguredRegion}</AdaptiveProvider>);

  it.each([
    [
      "an item without a size in a grid",
      <AdaptiveRegion id="misconfigured" version="1">
        <Adaptive id="button">button</Adaptive>
      </AdaptiveRegion>,
      /needs defaults.w and defaults.h/,
    ],
    [
      "half a size",
      <AdaptiveRegion id="misconfigured" version="1" grid={false}>
        <Adaptive id="button" defaults={{ w: 2 }}>
          button
        </Adaptive>
      </AdaptiveRegion>,
      /both a width and a height, or neither/,
    ],
    [
      "resizing without a size",
      <AdaptiveRegion id="misconfigured" version="1" grid={false}>
        <Adaptive id="button" capabilities={{ resize: { minW: 1, maxW: 2, minH: 1, maxH: 2 } }}>
          button
        </Adaptive>
      </AdaptiveRegion>,
      /can be resized only with a default size/,
    ],
    [
      "moving without a group in a region with no grid",
      <AdaptiveRegion id="misconfigured" version="1" grid={false}>
        <Adaptive id="button" capabilities={{ move: true }}>
          button
        </Adaptive>
      </AdaptiveRegion>,
      /can be moved only with a group/,
    ],
  ])("refuses %s with an explanation", (_case, misconfiguredRegion, explanation) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderAlone(misconfiguredRegion)).toThrow(explanation);
  });
});
