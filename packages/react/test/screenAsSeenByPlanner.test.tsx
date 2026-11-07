// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptPanel, useAdaptiveRegion } from "../src/index";
import { createFakeEngine, type RegionApi } from "./dashboardWithFakeEngine";

/** A screen whose width the test sets, answering width queries the way a browser does, and no others. */
let screenWidth = 1280;
beforeEach(() => {
  screenWidth = 1280;
  window.matchMedia = (mediaQueryText: string) => {
    const minWidth = /min-width: (\d+)px/.exec(mediaQueryText)?.[1];
    return {
      get matches() {
        return minWidth !== undefined && screenWidth >= Number(minWidth);
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList;
  };
});
afterEach(cleanup);

/** A page with a dashboard, and a sidebar when `regionIds` names it too, in the direction given. */
function renderPage(
  engine: ReturnType<typeof createFakeEngine>,
  { pageDirection = "ltr", regionIds = ["dashboard"] }: { pageDirection?: "ltr" | "rtl"; regionIds?: string[] } = {},
) {
  const regionApis: Record<string, RegionApi> = {};
  function RegionApiProbe({ regionId }: { regionId: string }) {
    regionApis[regionId] = useAdaptiveRegion(regionId);
    return null;
  }
  const renderResult = render(
    <div dir={pageDirection}>
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        {regionIds.map((regionId) => (
          <RegionApiProbe key={regionId} regionId={regionId} />
        ))}
        <PromptPanel regionId={regionIds.length === 1 ? regionIds[0]! : regionIds} defaultOpen />
        {regionIds.includes("sidebar") && (
          <AdaptiveRegion id="sidebar" version="1" columns={1} title="Sidebar">
            <Adaptive id="general" title="General" defaults={{ w: 1, h: 1 }}>
              general
            </Adaptive>
          </AdaptiveRegion>
        )}
        <AdaptiveRegion id="dashboard" version="1" columns={{ 0: 1, 640: 6, 1024: 12 }}>
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
            txns
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>
    </div>,
  );
  return {
    renderResult,
    async sendPrompt(prompt: string) {
      await waitFor(() => expect(regionIds.every((regionId) => regionApis[regionId]?.loading === false)).toBe(true));
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: prompt } });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
      });
    },
    lastRequestTo: (endpointPath: string) =>
      engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === endpointPath).at(-1)!.requestBody,
  };
}

describe("what the planner is told about the screen the user sees", () => {
  it("says nothing extra for a wide page that reads left to right", async () => {
    const engine = createFakeEngine();
    const page = renderPage(engine);
    await page.sendPrompt("put Transactions first");
    const planRequest = page.lastRequestTo("plan");
    expect(planRequest).not.toHaveProperty("textDirection");
    expect(planRequest).not.toHaveProperty("drawnColumns");
  });

  it("sends the page's direction and the columns a phone draws the layout in", async () => {
    screenWidth = 390;
    const engine = createFakeEngine();
    const page = renderPage(engine, { pageDirection: "rtl" });
    await page.sendPrompt("put Transactions on the left of Revenue");
    expect(page.lastRequestTo("plan")).toMatchObject({ textDirection: "rtl", drawnColumns: 1 });
    // The manifest keeps the layout's own columns, which every saved change is made in.
    expect(page.lastRequestTo("plan").manifest.columns).toBe(12);
  });

  it("across regions, sends the direction once and the columns only for a region drawn narrower", async () => {
    screenWidth = 800;
    const engine = createFakeEngine();
    const page = renderPage(engine, { pageDirection: "rtl", regionIds: ["dashboard", "sidebar"] });
    await page.sendPrompt("put Transactions first");
    const planRequest = page.lastRequestTo("v1/plan");
    expect(planRequest.textDirection).toBe("rtl");
    expect(
      planRequest.regions.map((regionPart: { manifest: { regionId: string }; drawnColumns?: number }) => [
        regionPart.manifest.regionId,
        regionPart.drawnColumns,
      ]),
    ).toEqual([
      ["dashboard", 6],
      ["sidebar", undefined],
    ]);
  });
});

describe("the direction of each reply", () => {
  it("follows the reply's own words, not the page", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [], message: "Transactions is already first." });
    const page = renderPage(engine, { pageDirection: "rtl" });
    await page.sendPrompt("put Transactions first");
    const reply = await page.renderResult.findByText("Transactions is already first.");
    expect(reply.getAttribute("dir")).toBe("auto");
    expect(page.renderResult.getByText("put Transactions first").getAttribute("dir")).toBe("auto");
    expect(page.renderResult.getByLabelText("Describe a change to this screen").getAttribute("dir")).toBe("auto");
  });
});
