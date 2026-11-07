// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "@clickless/core";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, EngineError, useAdaptiveRegion } from "../src/index";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(cleanup);

describe("with an engine", () => {
  it("loads the user's saved layout on mount, sending the token", async () => {
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "dashboard",
      manifestVersion: "1",
      order: ["balance", "txns", "revenue"],
      items: {
        balance: { w: 12, h: 1, hidden: false, props: {} },
        revenue: { w: 6, h: 3, hidden: false, props: {} },
        txns: { w: 6, h: 3, hidden: false, props: {} },
      },
    };
    const engine = createFakeEngine({ revision: 4, layout: savedLayout });
    const { drawOrderOf, regionApi } = renderDashboardWithEngine(engine);

    await waitFor(() => expect(regionApi().loading).toBe(false));
    expect(drawOrderOf("txns")).toBe("1");
    expect(regionApi().canUndo).toBe(true);
    expect(engine.receivedCalls[0]).toMatchObject({ method: "GET", endpointPath: "layout", token: "Bearer signed-token" });
  });

  it("sends committed changes to the engine with the revision it last saw", async () => {
    const engine = createFakeEngine();
    const { drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await act(() => regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST));
    await act(() => regionApi().applyOperations([{ type: "hide", id: "revenue" }]));

    const revisionPosts = engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "revisions");
    expect(revisionPosts.map((receivedCall) => receivedCall.requestBody.baseRevision)).toEqual([0, 1]);
    expect(revisionPosts[0]!.requestBody.operations).toEqual(MOVE_TRANSACTIONS_FIRST);
    expect(revisionPosts[0]!.requestBody.manifest.components.map((component: { id: string }) => component.id)).toEqual([
      "balance",
      "revenue",
      "txns",
    ]);
    expect(drawOrderOf("txns")).toBe("1");
    expect(regionApi().layout).toEqual(engine.regionState.layout);
  });

  it("does not call the engine for operations that fail locally", async () => {
    const engine = createFakeEngine();
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    let applyOutcome!: Awaited<ReturnType<RegionApi["applyOperations"]>>;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations([{ type: "hide", id: "balance" }]);
    });
    expect(applyOutcome).toMatchObject({ applied: false, errors: [{ code: "locked" }] });
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.method === "POST")).toEqual([]);
  });

  it("reloads and rejects a prompt's change when the layout was changed elsewhere", async () => {
    const engine = createFakeEngine();
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    engine.failNextRequest(409, { code: "conflict", message: "The layout changed since it was last read" });
    let conflictError: unknown;
    await act(async () => {
      conflictError = await regionApi()
        .applyOperations(MOVE_TRANSACTIONS_FIRST, "transactions first")
        .catch((rejectionReason) => rejectionReason);
    });
    expect(conflictError).toBeInstanceOf(EngineError);
    expect((conflictError as EngineError).code).toBe("conflict");
    expect(engine.receivedCalls.at(-1)).toMatchObject({ method: "GET", endpointPath: "layout" });
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);
  });

  it("carries a change of the application's own over to a layout changed elsewhere, and saves it", async () => {
    const engine = createFakeEngine();
    const { drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    // Revenue was hidden on another device, which this screen has not heard of.
    Object.assign(engine.regionState, {
      revision: 1,
      layout: { ...regionApi().layout!, items: { ...regionApi().layout!.items, revenue: { w: 6, h: 3, hidden: true, props: {} } } },
    });
    engine.failNextRequest(409, { code: "conflict", message: "The layout changed since it was last read" });
    let applyOutcome: unknown;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST);
    });
    expect(applyOutcome).toMatchObject({ applied: true });
    expect(engine.regionState.revision).toBe(2);
    expect(drawOrderOf("txns")).toBe("1");
    expect(regionApi().layout!.items.revenue!.hidden).toBe(true);
  });

  it("drops a change of the application's own whose setting was changed elsewhere meanwhile", async () => {
    const engine = createFakeEngine();
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    // The order was changed on another device.
    Object.assign(engine.regionState, {
      revision: 1,
      layout: { ...regionApi().layout!, order: ["balance", "txns", "revenue"] },
    });
    engine.failNextRequest(409, { code: "conflict", message: "The layout changed since it was last read" });
    await act(() => regionApi().applyOperations([{ type: "move", id: "revenue", position: "end" }]));
    expect(engine.regionState.revision).toBe(1);
    expect(regionApi().layout!.order).toEqual(["balance", "txns", "revenue"]);
    expect(regionApi().hasUnsavedChanges).toBe(false);
  });

  it("undoes through the engine", async () => {
    const engine = createFakeEngine();
    const { drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(() => regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST));
    expect(regionApi().canUndo).toBe(true);

    await act(() => regionApi().undoLastChange());
    expect(drawOrderOf("txns")).toBe("2");
    expect(regionApi().canUndo).toBe(false);
    expect(engine.receivedCalls.at(-1)).toMatchObject({ endpointPath: "undo", requestBody: { baseRevision: 1 } });
  });

  it("takes the engine's word on whether the latest change can be undone", async () => {
    // After restoring the original, the layout is the default and yet it can be undone.
    const engine = createFakeEngine({ revision: 3, layout: null });
    const engineReportingCanUndo = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) => {
          const response = await engine.engineOptions.fetch(requestInput, requestInit);
          return new Response(JSON.stringify({ ...(await response.json()), canUndo: true }), {
            status: response.status,
          });
        }) as typeof fetch,
      },
    };
    const { regionApi } = renderDashboardWithEngine(engineReportingCanUndo);
    await waitFor(() => expect(regionApi().revision).toBe(3));
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);
    expect(regionApi().canUndo).toBe(true);
  });
});

describe("changes saved through an engine", () => {
  it("sends changes made in quick succession one after another", async () => {
    const engine = createFakeEngine();
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await act(async () => {
      const { applyOperations: applyToRegion } = regionApi();
      await Promise.all([applyToRegion(MOVE_TRANSACTIONS_FIRST), applyToRegion([{ type: "hide", id: "revenue" }])]);
    });

    const revisionPosts = engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "revisions");
    expect(revisionPosts.map((receivedCall) => receivedCall.requestBody.baseRevision)).toEqual([0, 1]);
    expect(regionApi().revision).toBe(2);
    expect(regionApi().layout!.order).toEqual(["balance", "txns", "revenue"]);
    expect(regionApi().layout!.items.revenue!.hidden).toBe(true);
  });

  it("reloads when an undo finds the layout was changed elsewhere", async () => {
    const engine = createFakeEngine();
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(() => regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST));

    engine.failNextRequest(409, { code: "conflict", message: "The layout changed since it was last read" });
    let conflictError: unknown;
    await act(async () => {
      conflictError = await regionApi().undoLastChange().catch((rejectionReason) => rejectionReason);
    });
    expect((conflictError as EngineError).code).toBe("conflict");
    expect(engine.receivedCalls.at(-1)).toMatchObject({ method: "GET", endpointPath: "layout" });
  });

  it("shows the engine's layout, not initialLayout, once it has loaded", async () => {
    const engine = createFakeEngine();
    let regionApiValue!: RegionApi;
    function RegionApiProbe() {
      regionApiValue = useAdaptiveRegion("dashboard");
      return null;
    }
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "dashboard",
      manifestVersion: "1",
      order: ["txns", "revenue"],
      items: {
        revenue: { w: 6, h: 3, hidden: false, props: {} },
        txns: { w: 6, h: 3, hidden: false, props: {} },
      },
    };
    render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <RegionApiProbe />
        <AdaptiveRegion id="dashboard" version="1" initialLayout={savedLayout}>
          <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="txns" defaults={{ w: 6, h: 3 }}>
            txns
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    expect(regionApiValue.layout!.order).toEqual(["txns", "revenue"]);
    await waitFor(() => expect(regionApiValue.loading).toBe(false));
    expect(regionApiValue.layout!.order).toEqual(["revenue", "txns"]);

    // What is saved is what was on screen plus the change, as the engine sees it too.
    await act(() => regionApiValue.applyOperations([{ type: "hide", id: "revenue" }]));
    expect(regionApiValue.layout).toEqual(engine.regionState.layout);
  });

  it("does not bring initialLayout back when the region is shown again", async () => {
    const engine = createFakeEngine();
    let regionApiValue!: RegionApi;
    function RegionApiProbe() {
      regionApiValue = useAdaptiveRegion("dashboard");
      return null;
    }
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "dashboard",
      manifestVersion: "1",
      order: ["txns", "revenue"],
      items: {
        revenue: { w: 6, h: 3, hidden: false, props: {} },
        txns: { w: 6, h: 3, hidden: false, props: {} },
      },
    };
    function DashboardScreen({ regionShown }: { regionShown: boolean }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <RegionApiProbe />
          {regionShown && (
            <AdaptiveRegion id="dashboard" version="1" initialLayout={savedLayout}>
              <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
                revenue
              </Adaptive>
              <Adaptive id="txns" defaults={{ w: 6, h: 3 }}>
                txns
              </Adaptive>
            </AdaptiveRegion>
          )}
        </AdaptiveProvider>
      );
    }
    const renderResult = render(<DashboardScreen regionShown />);
    await waitFor(() => expect(regionApiValue.layout?.order).toEqual(["revenue", "txns"]));
    renderResult.rerender(<DashboardScreen regionShown={false} />);
    renderResult.rerender(<DashboardScreen regionShown />);
    expect(regionApiValue.layout!.order).toEqual(["revenue", "txns"]);
  });

  it("shows a preloaded region's saved layout the moment it first mounts", async () => {
    const engine = createFakeEngine({
      revision: 3,
      layout: {
        formatVersion: 1,
        regionId: "dashboard",
        manifestVersion: "1",
        order: ["txns", "revenue"],
        items: {
          revenue: { w: 6, h: 3, hidden: false, props: {} },
          txns: { w: 6, h: 3, hidden: false, props: {} },
        },
      },
    });
    let regionApiValue!: RegionApi;
    function RegionApiProbe() {
      regionApiValue = useAdaptiveRegion("dashboard");
      return null;
    }
    const ordersAtEachRender: (string[] | undefined)[] = [];
    function OrderRecorder() {
      ordersAtEachRender.push(useAdaptiveRegion("dashboard").layout?.order);
      return null;
    }
    function DashboardScreen({ regionShown }: { regionShown: boolean }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions} preloadRegions={["dashboard"]}>
          <RegionApiProbe />
          {regionShown && (
            <AdaptiveRegion id="dashboard" version="1">
              <OrderRecorder />
              <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
                revenue
              </Adaptive>
              <Adaptive id="txns" defaults={{ w: 6, h: 3 }}>
                txns
              </Adaptive>
            </AdaptiveRegion>
          )}
        </AdaptiveProvider>
      );
    }
    const renderResult = render(<DashboardScreen regionShown={false} />);
    await waitFor(() =>
      expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "layout")).toHaveLength(1),
    );
    await act(async () => {});

    renderResult.rerender(<DashboardScreen regionShown />);

    await waitFor(() => expect(regionApiValue.layout?.order).toEqual(["txns", "revenue"]));
    // Never the default first. It is read again as it mounts, in case it changed meanwhile.
    expect(ordersAtEachRender.filter(Boolean).every((order) => order![0] === "txns")).toBe(true);
    await waitFor(() =>
      expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "layout")).toHaveLength(2),
    );
  });

  it("reads the layout again when the region is shown again, to see changes made while it was away", async () => {
    const engine = createFakeEngine();
    let regionApiValue!: RegionApi;
    function RegionApiProbe() {
      regionApiValue = useAdaptiveRegion("dashboard");
      return null;
    }
    function DashboardScreen({ regionShown }: { regionShown: boolean }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <RegionApiProbe />
          {regionShown && (
            <AdaptiveRegion id="dashboard" version="1">
              <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
                revenue
              </Adaptive>
              <Adaptive id="txns" defaults={{ w: 6, h: 3 }}>
                txns
              </Adaptive>
            </AdaptiveRegion>
          )}
        </AdaptiveProvider>
      );
    }
    const renderResult = render(<DashboardScreen regionShown />);
    await waitFor(() => expect(regionApiValue.loading).toBe(false));
    renderResult.rerender(<DashboardScreen regionShown={false} />);

    // As an undo on another page does, while this one is not open.
    engine.regionState.revision = 2;
    engine.regionState.layout = {
      formatVersion: 1,
      regionId: "dashboard",
      manifestVersion: "1",
      order: ["txns", "revenue"],
      items: {
        revenue: { w: 6, h: 3, hidden: false, props: {} },
        txns: { w: 6, h: 3, hidden: false, props: {} },
      },
    };
    renderResult.rerender(<DashboardScreen regionShown />);

    await waitFor(() => expect(regionApiValue.layout?.order).toEqual(["txns", "revenue"]));
    const layoutReads = engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "layout");
    expect(layoutReads).toHaveLength(2);
  });

  it("keeps the layout it has when reading it again fails", async () => {
    const engine = createFakeEngine();
    let regionApiValue!: RegionApi;
    function RegionApiProbe() {
      regionApiValue = useAdaptiveRegion("dashboard");
      return null;
    }
    function DashboardScreen({ regionShown }: { regionShown: boolean }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <RegionApiProbe />
          {regionShown && (
            <AdaptiveRegion id="dashboard" version="1">
              <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
                revenue
              </Adaptive>
              <Adaptive id="txns" defaults={{ w: 6, h: 3 }}>
                txns
              </Adaptive>
            </AdaptiveRegion>
          )}
        </AdaptiveProvider>
      );
    }
    const renderResult = render(<DashboardScreen regionShown />);
    await waitFor(() => expect(regionApiValue.loading).toBe(false));
    await act(() => regionApiValue.applyOperations(MOVE_TRANSACTIONS_FIRST));
    renderResult.rerender(<DashboardScreen regionShown={false} />);

    engine.failNextRequest(503, { code: "unavailable", message: "Down for a moment" });
    renderResult.rerender(<DashboardScreen regionShown />);

    await waitFor(() => expect(regionApiValue.loading).toBe(false));
    expect(regionApiValue.layout?.order).toEqual(["txns", "revenue"]);
  });

  it("saves a preview once when asked to keep it twice", async () => {
    const engine = createFakeEngine();
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    act(() => {
      regionApi().previewOperations(MOVE_TRANSACTIONS_FIRST);
    });

    await act(async () => {
      const { commitPreview } = regionApi();
      await Promise.all([commitPreview(), commitPreview()]);
    });
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "revisions")).toHaveLength(1);
    expect(regionApi().revision).toBe(1);
  });

  it("still saves a change when the region leaves the screen before its turn", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    let applyOutcome!: Awaited<ReturnType<RegionApi["applyOperations"]>>;
    await act(async () => {
      const savePromise = regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST);
      renderResult.unmount();
      applyOutcome = await savePromise;
    });
    expect(applyOutcome.applied).toBe(true);
    expect(engine.regionState.revision).toBe(1);
    expect(engine.regionState.layout!.order).toEqual(["balance", "txns", "revenue"]);
  });
});

describe("a layout saved before the screen changed", () => {
  const olderLayout: Layout = {
    formatVersion: 1,
    regionId: "dashboard",
    manifestVersion: "0",
    order: ["txns", "balance"],
    items: {
      balance: { w: 12, h: 1, hidden: false, props: {} },
      txns: { w: 6, h: 3, hidden: false, props: {} },
    },
    // Off screen when this was saved: kept, never reported as removed.
    offScreen: {
      order: ["txns", "balance", "legacy"],
      items: { legacy: { w: 6, h: 3, hidden: false, props: {} } },
    },
  };

  it("keeps the user's order, places the new component, and tells them", async () => {
    const engine = createFakeEngine({ revision: 2, layout: olderLayout });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    expect(regionApi().layout!.order).toEqual(["txns", "balance", "revenue"]);
    expect(drawOrderOf("txns")).toBe("0");
    expect(regionApi().savedLayoutAdjustments).toEqual([{ type: "added", id: "revenue" }]);

    const noticeText =
      "This screen has been updated since you arranged it: Revenue was added.";
    expect(renderResult.getByText(noticeText)).toBeTruthy();
    fireEvent.click(renderResult.getByRole("button", { name: "OK" }));
    expect(renderResult.queryByText(noticeText)).toBeNull();
  });

  it("stops reporting once the user saves a change", async () => {
    const engine = createFakeEngine({ revision: 2, layout: olderLayout });
    const { regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await act(() => regionApi().applyOperations([{ type: "hide", id: "revenue" }]));
    expect(regionApi().savedLayoutAdjustments).toEqual([]);
    expect(regionApi().layout!.order).toEqual(["txns", "balance", "revenue"]);
  });
});
