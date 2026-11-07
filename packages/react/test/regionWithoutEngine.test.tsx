// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultLayout, type Layout } from "@clickless/core";
import {
  Adaptive,
  AdaptiveProvider,
  AdaptiveRegion,
  describeHistoryEntry,
  propPresets,
  useAdaptiveRegion,
  usePromptBar,
  type AdaptiveControls,
  type HistoryEntry,
} from "../src/index";

afterEach(cleanup);

type RegionApi = ReturnType<typeof useAdaptiveRegion>;

function renderDashboard(regionProps: { initialLayout?: Layout; onLayoutChange?: (layout: Layout) => void } = {}) {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return null;
  }
  const renderResult = render(
    <StrictMode>
      <AdaptiveProvider userId="user-1">
        <RegionApiProbe />
        <AdaptiveRegion id="dashboard" version="1" {...regionProps}>
          <Adaptive id="balance" kind="stat" locked defaults={{ w: 12, h: 1 }}>
            <span>balance body</span>
          </Adaptive>
          <Adaptive
            id="revenue"
            kind="chart"
            title="Revenue by month"
            capabilities={{ resize: { minW: 4, maxW: 12, minH: 2, maxH: 6 } }}
            presets={{ chartType: propPresets.choice({ values: ["bar", "line"], initial: "bar", means: "the kind of chart" }) }}
            defaults={{ w: 6, h: 3 }}
          >
            {(props, adaptiveControls) => (
              <>
                <span>chart:{String(props.chartType)}</span>
                <button onClick={() => void adaptiveControls.setProp("chartType", "line")}>use line</button>
              </>
            )}
          </Adaptive>
          <Adaptive id="txns" kind="table" defaults={{ w: 6, h: 3 }}>
            <span>txns body</span>
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>
    </StrictMode>,
  );
  const itemElement = (componentId: string) =>
    renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!;
  return { renderResult, itemElement, regionApi: () => regionApiValue };
}

describe("AdaptiveRegion", () => {
  it("builds the manifest from the mounted components, in document order", () => {
    const { regionApi } = renderDashboard();
    const manifest = regionApi().manifest!;
    expect(manifest.regionId).toBe("dashboard");
    expect(manifest.components.map((component) => component.id)).toEqual(["balance", "revenue", "txns"]);
    expect(manifest.components[0]).toMatchObject({ locked: true, capabilities: { move: true, hide: true } });
    expect(manifest.components[1]!.title).toBe("Revenue by month");
    expect(regionApi().layout).toEqual(defaultLayout(manifest));
  });

  it("renders the default layout as grid spans", () => {
    const { itemElement, renderResult } = renderDashboard();
    expect(itemElement("revenue").style.gridColumn).toBe("span 6");
    expect(itemElement("revenue").style.gridRow).toBe("span 3");
    expect(itemElement("revenue").style.order).toBe("1");
    expect(renderResult.getByText("chart:bar")).toBeTruthy();
  });

  it("applies operations and re-renders", async () => {
    const { itemElement, renderResult, regionApi } = renderDashboard();
    let applyOutcome!: Awaited<ReturnType<RegionApi["applyOperations"]>>;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations([
        { type: "move", id: "txns", position: "before", targetId: "revenue" },
        { type: "resize", id: "revenue", w: 12 },
        { type: "setProp", id: "revenue", prop: "chartType", value: "line" },
      ]);
    });
    expect(applyOutcome.applied).toBe(true);
    expect(itemElement("txns").style.order).toBe("1");
    expect(itemElement("revenue").style.order).toBe("2");
    expect(itemElement("revenue").style.gridColumn).toBe("span 12");
    expect(renderResult.getByText("chart:line")).toBeTruthy();
  });

  it("does not render the children of a hidden component", async () => {
    const { itemElement, renderResult, regionApi } = renderDashboard();
    await act(() => regionApi().applyOperations([{ type: "hide", id: "txns" }]));
    expect(itemElement("txns").hidden).toBe(true);
    expect(renderResult.queryByText("txns body")).toBeNull();
    await act(() => regionApi().applyOperations([{ type: "show", id: "txns" }]));
    expect(renderResult.getByText("txns body")).toBeTruthy();
  });

  it("returns errors and changes nothing when an operation is invalid", async () => {
    const onLayoutChange = vi.fn();
    const { regionApi } = renderDashboard({ onLayoutChange });
    const layoutBefore = regionApi().layout;
    let applyOutcome!: Awaited<ReturnType<RegionApi["applyOperations"]>>;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations([
        { type: "hide", id: "txns" },
        { type: "hide", id: "balance" },
      ]);
    });
    expect(applyOutcome).toMatchObject({ applied: false, errors: [{ index: 1, code: "locked" }] });
    expect(regionApi().layout).toBe(layoutBefore);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it("previews without committing, then commits or cancels", async () => {
    const onLayoutChange = vi.fn();
    const { itemElement, regionApi } = renderDashboard({ onLayoutChange });
    const operations = [{ type: "move", id: "txns", position: "start" } as const];

    act(() => void regionApi().previewOperations(operations));
    expect(itemElement("txns").style.order).toBe("0");
    expect(itemElement("txns").dataset.clicklessPreview).toBe("changed");
    // What the preview changes is outlined, in a way the host can restyle or turn off.
    expect(itemElement("txns").getAttribute("style")).toContain("var(--clickless-preview-outline");
    expect(itemElement("revenue").getAttribute("style") ?? "").not.toContain("--clickless-preview-outline");
    expect(itemElement("balance").dataset.clicklessPreview).toBeUndefined();
    expect(itemElement("revenue").dataset.clicklessPreview).toBeUndefined();
    expect([...regionApi().changedComponentIds]).toEqual(["txns"]);
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);
    expect(onLayoutChange).not.toHaveBeenCalled();

    act(() => regionApi().cancelPreview());
    expect(itemElement("txns").style.order).toBe("2");
    expect(itemElement("txns").dataset.clicklessPreview).toBeUndefined();
    expect(itemElement("txns").getAttribute("style") ?? "").not.toContain("--clickless-preview-outline");

    act(() => void regionApi().previewOperations(operations));
    await act(() => regionApi().commitPreview());
    expect(regionApi().preview).toBeNull();
    expect(regionApi().layout!.order).toEqual(["txns", "balance", "revenue"]);
    expect(onLayoutChange).toHaveBeenCalledExactlyOnceWith(regionApi().layout, operations);
  });

  it("lets a component change its own props through the same store", async () => {
    const onLayoutChange = vi.fn();
    const { renderResult, regionApi } = renderDashboard({ onLayoutChange });
    await act(async () => {
      renderResult.getByText("use line").click();
    });
    expect(renderResult.getByText("chart:line")).toBeTruthy();
    expect(regionApi().canUndo).toBe(true);
    expect(onLayoutChange).toHaveBeenCalledExactlyOnceWith(regionApi().layout, [
      { type: "setProp", id: "revenue", prop: "chartType", value: "line" },
    ]);
  });

  it("undoes committed changes one at a time when there is no engine", async () => {
    const { regionApi } = renderDashboard();
    expect(regionApi().canUndo).toBe(false);
    await act(() => regionApi().applyOperations([{ type: "move", id: "txns", position: "start" }]));
    await act(() => regionApi().applyOperations([{ type: "hide", id: "revenue" }]));
    expect(regionApi().canUndo).toBe(true);

    await act(() => regionApi().undoLastChange());
    expect(regionApi().layout!.items.revenue!.hidden).toBe(false);
    expect(regionApi().layout!.order).toEqual(["txns", "balance", "revenue"]);
    await act(() => regionApi().undoLastChange());
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);
    expect(regionApi().canUndo).toBe(false);
  });

  it("starts from a saved layout", () => {
    const { regionApi: firstRegionApi } = renderDashboard();
    const savedLayout: Layout = {
      ...firstRegionApi().layout!,
      order: ["revenue", "balance", "txns"],
      items: {
        ...firstRegionApi().layout!.items,
        revenue: { w: 12, h: 2, hidden: false, props: { chartType: "line" } },
      },
    };
    cleanup();
    const { itemElement, regionApi } = renderDashboard({ initialLayout: savedLayout });
    expect(regionApi().layout).toEqual(savedLayout);
    expect(itemElement("revenue").style.order).toBe("0");
    expect(itemElement("revenue").style.gridColumn).toBe("span 12");
    expect(regionApi().savedLayoutAdjustments).toEqual([]);
  });

  it("carries a saved layout over when it names other components", () => {
    const { regionApi: firstRegionApi } = renderDashboard();
    const staleLayout: Layout = { ...firstRegionApi().layout!, order: ["revenue", "balance", "removed"] };
    cleanup();
    const { regionApi } = renderDashboard({ initialLayout: staleLayout });
    expect(regionApi().layout!.order).toEqual(["revenue", "txns", "balance"]);
    expect(regionApi().savedLayoutAdjustments).toEqual([{ type: "removed", id: "removed" }]);
  });

  it("reads a saved layout that came back with fields of the host's own", () => {
    const { regionApi: firstRegionApi } = renderDashboard();
    const { layout } = firstRegionApi();
    const storedLayout = {
      ...layout!,
      savedAt: "2026-10-01",
      order: ["revenue", "balance", "txns"],
      items: Object.fromEntries(
        Object.entries(layout!.items).map(([componentId, layoutItem]) => [
          componentId,
          { ...layoutItem, offeredValues: null },
        ]),
      ),
    } as unknown as Layout;
    cleanup();
    const { regionApi } = renderDashboard({ initialLayout: storedLayout });
    expect(regionApi().layout!.order).toEqual(["revenue", "balance", "txns"]);
  });

  it("reads each region's own saved layout when the id changes", () => {
    const savedLayout = (regionId: string, order: string[]): Layout => ({
      formatVersion: 1,
      regionId,
      manifestVersion: "1",
      order,
      items: Object.fromEntries(order.map((componentId) => [componentId, { w: 6, h: 2, hidden: false, props: {} }])),
    });
    let regionApiValue!: RegionApi;
    function RegionScreen({ regionId, order }: { regionId: string; order: string[] }) {
      regionApiValue = useAdaptiveRegion(regionId);
      return (
        <AdaptiveRegion id={regionId} version="1" initialLayout={savedLayout(regionId, order)}>
          <Adaptive id="a" defaults={{ w: 6, h: 2 }}>
            a
          </Adaptive>
          <Adaptive id="b" defaults={{ w: 6, h: 2 }}>
            b
          </Adaptive>
        </AdaptiveRegion>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <RegionScreen regionId="first" order={["b", "a"]} />
      </AdaptiveProvider>,
    );
    expect(regionApiValue.layout!.order).toEqual(["b", "a"]);
    renderResult.rerender(
      <AdaptiveProvider userId="user-1">
        <RegionScreen regionId="second" order={["a", "b"]} />
      </AdaptiveProvider>,
    );
    expect(regionApiValue.layout!.order).toEqual(["a", "b"]);
  });
});

describe("a host's own style on an item", () => {
  it("cannot show a hidden item or change where it sits", () => {
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="first" defaults={{ w: 6, h: 2 }}>
            first
          </Adaptive>
          <Adaptive
            id="second"
            defaults={{ w: 6, h: 2, hidden: true }}
            style={{ display: "flex", order: 9, minWidth: 120 }}
          >
            second
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    const secondItem = renderResult.container.querySelector<HTMLElement>('[data-clickless-item="second"]')!;
    expect(secondItem.style.display).toBe("none");
    expect(secondItem.style.order).toBe("1");
    // What the layout does not decide is still the host's to set.
    expect(secondItem.style.minWidth).toBe("120px");
  });
});

describe("describeHistoryEntry", () => {
  const { manifest } = (() => {
    const { regionApi } = renderDashboard();
    const regionSnapshot = regionApi();
    cleanup();
    return regionSnapshot;
  })();
  const historyEntryOf = (kind: HistoryEntry["kind"], operations: HistoryEntry["operations"]): HistoryEntry => ({
    revision: 1,
    kind,
    prompt: null,
    message: null,
    operations,
    createdAt: "2026-10-01T09:00:00Z",
  });

  it("names up to three sections by their titles", () => {
    expect(describeHistoryEntry(historyEntryOf("apply", [{ type: "hide", id: "revenue" }]), manifest)).toBe(
      "Changed Revenue by month",
    );
  });

  it("says when the whole screen was reset or an earlier one brought back", () => {
    expect(describeHistoryEntry(historyEntryOf("apply", [{ type: "reset" }]), manifest)).toBe(
      "Reset the whole screen",
    );
    expect(describeHistoryEntry(historyEntryOf("undo", []), manifest)).toBe("Went back to an earlier version of this screen");
    expect(describeHistoryEntry(historyEntryOf("apply", []), manifest)).toBe("Changed this screen");
  });

  it("counts sections instead of showing an id the user never saw", () => {
    expect(describeHistoryEntry(historyEntryOf("apply", [{ type: "hide", id: "saved-views" }]), manifest)).toBe(
      "Changed a section that is no longer here",
    );
    expect(
      describeHistoryEntry(historyEntryOf("apply", [{ type: "reorder", ids: ["revenue", "saved-views"] }]), manifest),
    ).toBe("Changed 2 sections");
    expect(describeHistoryEntry(historyEntryOf("apply", [{ type: "hide", id: "revenue" }]), null)).toBe(
      "Changed a section that is no longer here",
    );
  });

  it("does not show the id of a section that was given no title", () => {
    expect(describeHistoryEntry(historyEntryOf("apply", [{ type: "hide", id: "txns" }]), manifest)).toBe(
      "Changed a section",
    );
    expect(
      describeHistoryEntry(historyEntryOf("apply", [{ type: "reorder", ids: ["revenue", "txns"] }]), manifest),
    ).toBe("Changed 2 sections");
  });

  it("describes an entry in a form it does not know without throwing", () => {
    const malformedOperations = [null, "hide", { type: "reorder", ids: "revenue" }, { type: "hide", id: { name: "x" } }];
    expect(
      describeHistoryEntry(historyEntryOf("apply", malformedOperations as unknown as HistoryEntry["operations"]), manifest),
    ).toBe("Changed this screen");
    expect(
      describeHistoryEntry({ ...historyEntryOf("apply", []), operations: undefined } as unknown as HistoryEntry, manifest),
    ).toBe("Changed this screen");
  });
});

describe("the order a screen reader meets the items in", () => {
  const regionElement = (renderResult: ReturnType<typeof renderDashboard>["renderResult"]) =>
    renderResult.container.querySelector<HTMLElement>('[data-clickless-region="dashboard"]')!;

  it("is left to the page while nothing has been moved", () => {
    const { renderResult } = renderDashboard();
    expect(regionElement(renderResult).hasAttribute("aria-owns")).toBe(false);
  });

  /** The components the region's list points at, in the order it lists them. */
  const listedItemIds = (renderResult: ReturnType<typeof renderDashboard>["renderResult"]) =>
    regionElement(renderResult)
      .getAttribute("aria-owns")!
      .split(" ")
      .map((elementId) => document.getElementById(elementId)?.dataset.clicklessItem);

  it("follows what is shown once something is moved, leaving out what is hidden", async () => {
    const { renderResult, regionApi } = renderDashboard();
    await act(() =>
      regionApi().applyOperations([
        { type: "move", id: "txns", position: "before", targetId: "revenue" },
        { type: "hide", id: "revenue" },
      ]),
    );
    expect(listedItemIds(renderResult)).toEqual(["balance", "txns"]);
  });

  it("follows a preview while it is showing", () => {
    const { renderResult, regionApi } = renderDashboard();
    act(() => {
      regionApi().previewOperations([{ type: "move", id: "txns", position: "before", targetId: "revenue" }]);
    });
    expect(listedItemIds(renderResult)).toEqual(["balance", "txns", "revenue"]);
    act(() => regionApi().cancelPreview());
    expect(regionElement(renderResult).hasAttribute("aria-owns")).toBe(false);
  });

  it("names items so that no two on a page match, even in regions of the same name", () => {
    const sameRegionTwice = (
      <AdaptiveRegion id="sales 2026" version="1">
        <Adaptive id="by region/q1" defaults={{ w: 6, h: 2 }}>
          sales
        </Adaptive>
      </AdaptiveRegion>
    );
    const renderResult = render(
      <>
        <AdaptiveProvider userId="user-1">{sameRegionTwice}</AdaptiveProvider>
        <AdaptiveProvider userId="user-1">{sameRegionTwice}</AdaptiveProvider>
      </>,
    );
    const elementIds = [...renderResult.container.querySelectorAll("[data-clickless-item]")].map((itemElement) => itemElement.id);
    expect(new Set(elementIds).size).toBe(2);
    // Each can be listed among others: no spaces, and nothing but letters, digits, - and _.
    for (const elementId of elementIds) expect(elementId).toMatch(/^clickless-[A-Za-z0-9_-]+$/);
  });
});

describe("the one name that cannot be used", () => {
  const renderingInRegion = (regionChild: ReactNode) => () =>
    render(
      <AdaptiveProvider userId="user-1">
        <AdaptiveRegion id="dashboard" version="1">
          {regionChild}
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
  // Written as `{ __proto__: … }` the key would not become an entry at all.
  const recordNamedProto = <T,>(entryValue: T): Record<string, T> => Object.fromEntries([["__proto__", entryValue]]);

  it("is refused as a component id and as a prop name, with a message saying so", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const expectedErrorMessage = /no component or prop may be named "__proto__"/;
      expect(
        renderingInRegion(
          <Adaptive id="__proto__" defaults={{ w: 6, h: 2 }}>
            x
          </Adaptive>,
        ),
      ).toThrow(expectedErrorMessage);
      expect(
        renderingInRegion(
          <Adaptive
            id="card"
            presets={recordNamedProto(propPresets.choice({ values: ["a"], initial: "a", means: "a setting" }))}
            defaults={{ w: 6, h: 2 }}
          >
            x
          </Adaptive>,
        ),
      ).toThrow(expectedErrorMessage);
      expect(
        renderingInRegion(
          <Adaptive
            id="card"
            presets={{ shown: propPresets.toggle({ shows: "a part" }).named("__proto__") }}
            defaults={{ w: 6, h: 2 }}
          >
            x
          </Adaptive>,
        ),
      ).toThrow(expectedErrorMessage);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("leaves every other name alone", () => {
    const renderResult = renderingInRegion(
      <Adaptive
        id="constructor"
        presets={{ toString: propPresets.choice({ values: ["a"], initial: "a", means: "a setting" }) }}
        defaults={{ w: 6, h: 2 }}
      >
        {(props) => `shows ${String(props.toString)}`}
      </Adaptive>,
    )();
    expect(renderResult.getByText("shows a")).toBeTruthy();
  });
});

describe("a component that marks its own changes", () => {
  function renderTable() {
    let regionApiValue!: RegionApi;
    let promptBarValue!: ReturnType<typeof usePromptBar>;
    const notesControls: AdaptiveControls[] = [];
    function Probes() {
      regionApiValue = useAdaptiveRegion("dashboard");
      promptBarValue = usePromptBar("dashboard");
      return null;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <Probes />
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive
            id="txns"
            kind="table"
            marksChanges
            capabilities={{ resize: { minW: 4, maxW: 12, minH: 2, maxH: 6 } }}
            defaults={{ w: 6, h: 3 }}
            presets={{
              columns: propPresets.visibleList({ values: ["date", "payee", "amount", "notes"], means: "the columns" }),
              rows: propPresets.density(),
            }}
          >
            {(_props, adaptiveControls, presetValues) => (
              <table style={adaptiveControls.changeOutline("rows")}>
                <thead>
                  <tr>
                    {presetValues.columns.map((column) => (
                      <th key={column} style={adaptiveControls.changeOutline("columns", column)}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
              </table>
            )}
          </Adaptive>
          <Adaptive id="notes" kind="text" defaults={{ w: 6, h: 1 }}>
            {(_props, adaptiveControls) => {
              notesControls.push(adaptiveControls);
              return <p>notes</p>;
            }}
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    const outlinedColumns = () =>
      [...renderResult.container.querySelectorAll("th")]
        .filter((header) => header.getAttribute("style")?.includes("--clickless-preview-outline"))
        .map((header) => header.textContent);
    const isOutlined = (element: Element | null) =>
      element?.getAttribute("style")?.includes("--clickless-preview-outline") ?? false;
    const section = () => renderResult.container.querySelector('[data-clickless-item="txns"]');
    return {
      renderResult,
      outlinedColumns,
      isOutlined,
      section,
      notesControls,
      regionApi: () => regionApiValue,
      promptBar: () => promptBarValue,
    };
  }

  it("outlines only the column a preview moves, and not the whole section", () => {
    const { renderResult, outlinedColumns, isOutlined, section, regionApi } = renderTable();
    act(() => void regionApi().previewOperations([{ type: "setProp", id: "txns", prop: "columns", value: ["date", "amount", "payee", "notes"] }]));
    expect(outlinedColumns()).toHaveLength(1);
    expect(outlinedColumns()[0]).toMatch(/^(payee|amount)$/);
    expect(isOutlined(renderResult.container.querySelector("table"))).toBe(false);
    expect(isOutlined(section())).toBe(false);
    expect(section()!.getAttribute("data-clickless-preview")).toBeNull();

    act(() => regionApi().cancelPreview());
    expect(outlinedColumns()).toEqual([]);
  });

  it("outlines a setting's own part, and the section for what changes the section", () => {
    const { renderResult, outlinedColumns, isOutlined, section, regionApi } = renderTable();
    act(() => void regionApi().previewOperations([{ type: "setProp", id: "txns", prop: "density", value: "compact" }]));
    expect(isOutlined(renderResult.container.querySelector("table"))).toBe(true);
    expect(outlinedColumns()).toEqual([]);
    expect(isOutlined(section())).toBe(false);
    act(() => regionApi().cancelPreview());

    act(() => void regionApi().previewOperations([{ type: "resize", id: "txns", w: 8, h: 3 }]));
    expect(isOutlined(section())).toBe(true);
    expect(section()!.getAttribute("data-clickless-preview")).toBe("changed");
  });

  it("keeps the same controls for a section a change does not reach", async () => {
    const { notesControls, regionApi } = renderTable();
    const controlsBefore = notesControls.at(-1);
    await act(() => regionApi().applyOperations([{ type: "setProp", id: "txns", prop: "density", value: "compact" }]));
    act(() => void regionApi().previewOperations([{ type: "setProp", id: "txns", prop: "density", value: "comfortable" }]));
    expect(notesControls.at(-1)).toBe(controlsBefore);
  });

  it("outlines a column the user removed while the original is shown", async () => {
    const { outlinedColumns, regionApi, promptBar } = renderTable();
    await act(() => regionApi().applyOperations([{ type: "setProp", id: "txns", prop: "columns", value: ["date", "payee", "amount"] }]));
    expect(outlinedColumns()).toEqual([]);

    act(() => promptBar().showOriginal(true));
    expect(outlinedColumns()).toEqual(["notes"]);
    act(() => promptBar().showOriginal(false));
    expect(outlinedColumns()).toEqual([]);
  });
});
