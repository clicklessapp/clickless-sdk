// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "@clickless/core";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptBar, useAdaptiveRegion } from "../src/index";
import { createFakeEngine, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(cleanup);

type Tab = "overview" | "analytics";
const RESIZABLE_CAPABILITIES = { resize: { minW: 4, maxW: 12, minH: 2, maxH: 6 } };

/** A dashboard whose tabs unmount their content when they are not open, as most tab components do. */
function TabbedDashboard({ openTab, initialLayout }: { openTab: Tab; initialLayout?: Layout }) {
  return (
    <AdaptiveRegion id="dashboard" version="1" {...(initialLayout && { initialLayout })}>
      {openTab === "overview" && (
        <>
          <Adaptive id="revenue" title="Revenue" capabilities={RESIZABLE_CAPABILITIES} defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="sales" title="Recent sales" defaults={{ w: 6, h: 3 }}>
            sales
          </Adaptive>
        </>
      )}
      {openTab === "analytics" && (
        <>
          <Adaptive id="referrers" title="Referrers" capabilities={RESIZABLE_CAPABILITIES} defaults={{ w: 6, h: 3 }}>
            referrers
          </Adaptive>
          <Adaptive id="devices" title="Devices" defaults={{ w: 6, h: 3 }}>
            devices
          </Adaptive>
        </>
      )}
    </AdaptiveRegion>
  );
}

function renderTabbedDashboard(openTab: Tab, engine?: ReturnType<typeof createFakeEngine>) {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return null;
  }
  const dashboardScreen = (tab: Tab) => (
    <AdaptiveProvider userId="user-1" {...(engine && { engine: engine.engineOptions })}>
      <RegionApiProbe />
      {engine && <PromptBar regionId="dashboard" />}
      <TabbedDashboard openTab={tab} />
    </AdaptiveProvider>
  );
  const renderResult = render(dashboardScreen(openTab));
  return {
    renderResult,
    regionApi: () => regionApiValue,
    openTab: (tab: Tab) => renderResult.rerender(dashboardScreen(tab)),
    itemElement: (componentId: string) =>
      renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`),
  };
}

describe("components that are not on screen", () => {
  it("keep their settings through a change made on another tab, without an engine", async () => {
    const { regionApi, openTab, itemElement } = renderTabbedDashboard("analytics");
    await act(() =>
      regionApi().applyOperations([
        { type: "resize", id: "referrers", w: 12 },
        { type: "move", id: "devices", position: "start" },
      ]),
    );

    openTab("overview");
    expect(itemElement("referrers")).toBeNull();
    expect(regionApi().layout!.order).toEqual(["revenue", "sales"]);
    await act(() => regionApi().applyOperations([{ type: "hide", id: "sales" }]));
    expect(regionApi().layout!.offScreen!.items.referrers!.w).toBe(12);

    openTab("analytics");
    expect(regionApi().layout!.order).toEqual(["devices", "referrers"]);
    expect(itemElement("referrers")!.style.gridColumn).toBe("span 12");
    expect(itemElement("devices")!.style.order).toBe("0");
    expect(regionApi().layout!.offScreen!.items.sales!.hidden).toBe(true);

    openTab("overview");
    expect(itemElement("sales")!.hidden).toBe(true);
  });

  it("are not announced as added or removed when a tab is opened", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi, openTab } = renderTabbedDashboard("analytics", engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(() => regionApi().applyOperations([{ type: "resize", id: "referrers", w: 12 }]));

    openTab("overview");
    expect(regionApi().savedLayoutAdjustments).toEqual([]);
    expect(renderResult.queryByText(/This screen has been updated/)).toBeNull();
  });

  it("are kept by the engine, and left out of what the planner is told is on screen", async () => {
    const engine = createFakeEngine();
    const { regionApi, openTab, itemElement } = renderTabbedDashboard("analytics", engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(() => regionApi().applyOperations([{ type: "resize", id: "referrers", w: 12 }]));

    openTab("overview");
    await act(() => regionApi().applyOperations([{ type: "hide", id: "sales" }]));
    expect(Object.keys(engine.regionState.layout!.items).sort()).toEqual(["revenue", "sales"]);
    expect(engine.regionState.layout!.offScreen!.items.referrers!.w).toBe(12);

    await act(() => regionApi().planFromPrompt("make Referrers narrower"));
    const planCall = engine.receivedCalls.find((engineCall) => engineCall.endpointPath === "plan")!;
    expect(planCall.requestBody.manifest.components.map((component: { id: string }) => component.id)).toEqual([
      "revenue",
      "sales",
    ]);

    openTab("analytics");
    expect(itemElement("referrers")!.style.gridColumn).toBe("span 12");
  });

  it("keep their settings when a change made on another tab is undone", async () => {
    const engine = createFakeEngine();
    const { regionApi, openTab, itemElement } = renderTabbedDashboard("analytics", engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(() => regionApi().applyOperations([{ type: "resize", id: "referrers", w: 12 }]));
    openTab("overview");
    await act(() => regionApi().applyOperations([{ type: "hide", id: "sales" }]));

    openTab("analytics");
    await act(() => regionApi().undoLastChange());
    expect(itemElement("referrers")!.style.gridColumn).toBe("span 12");
    openTab("overview");
    expect(itemElement("sales")!.hidden).toBe(false);

    await act(() => regionApi().undoLastChange());
    openTab("analytics");
    expect(itemElement("referrers")!.style.gridColumn).toBe("span 6");
  });

  it("are drawn with their saved settings and place on the server and the first paint", () => {
    const savedOnOverview: Layout = {
      formatVersion: 1,
      regionId: "dashboard",
      manifestVersion: "1",
      order: ["revenue", "sales"],
      items: {
        revenue: { w: 6, h: 3, hidden: false, props: {} },
        sales: { w: 6, h: 3, hidden: false, props: {} },
      },
      offScreen: {
        order: ["revenue", "sales", "devices", "referrers"],
        items: {
          referrers: { w: 12, h: 4, hidden: false, props: {} },
          devices: { w: 6, h: 3, hidden: false, props: {} },
        },
      },
    };
    const renderedHtml = renderToString(
      <AdaptiveProvider userId="user-1">
        <TabbedDashboard openTab="analytics" initialLayout={savedOnOverview} />
      </AdaptiveProvider>,
    );
    expect(renderedHtml).toMatch(/data-clickless-item="referrers"[^>]*grid-column:span 12[^>]*order:3000/);
    expect(renderedHtml).toMatch(/data-clickless-item="devices"[^>]*order:2000/);
  });

  it("are read back from a saved layout the host stored with fields of its own", () => {
    const storedByHost = {
      formatVersion: 1,
      regionId: "dashboard",
      manifestVersion: "1",
      order: ["revenue", "sales"],
      savedAt: "2026-10-01",
      items: {
        revenue: { w: 6, h: 3, hidden: false, props: {}, offeredValues: null },
        sales: { w: 6, h: 3, hidden: false, props: {} },
      },
      offScreen: {
        order: ["revenue", "sales", "referrers"],
        items: {
          referrers: { w: 12, h: 4, hidden: false, props: {}, offeredValues: null },
        },
      },
    } as unknown as Layout;
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <TabbedDashboard openTab="analytics" initialLayout={storedByHost} />
      </AdaptiveProvider>,
    );
    const referrersElement = renderResult.container.querySelector<HTMLElement>('[data-clickless-item="referrers"]')!;
    expect(referrersElement.style.gridColumn).toBe("span 12");
  });
});
