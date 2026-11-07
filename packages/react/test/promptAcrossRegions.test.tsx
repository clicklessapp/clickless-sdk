// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Operation } from "@clickless/core";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptBar, PromptPanel, useAdaptiveRegion } from "../src/index";
import { createFakeEngine, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(cleanup);

const HIDE_REVENUE: Operation[] = [{ type: "hide", id: "revenue" }];
const HIDE_CHATS: Operation[] = [{ type: "hide", id: "chats" }];
const PAGES_FIRST: Operation[] = [{ type: "move", id: "pages", position: "start" }];
const BOTH_REGIONS = ["dashboard", "sidebar"] as const;

/**
 * An application with a sidebar every page shares, which is a region of its
 * own, and a page that is another. One prompt box speaks for both.
 */
function renderPageWithSidebar(
  engine: ReturnType<typeof createFakeEngine>,
  { promptControl = <PromptPanel regionId={BOTH_REGIONS} defaultOpen />, showChats = true, showSidebar = true } = {},
) {
  const regionApis: Record<string, RegionApi> = {};
  function RegionApiProbe({ regionId }: { regionId: string }) {
    regionApis[regionId] = useAdaptiveRegion(regionId);
    return null;
  }
  const applicationTree = (chatsShown: boolean) => (
    <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
      <RegionApiProbe regionId="dashboard" />
      <RegionApiProbe regionId="sidebar" />
      {promptControl}
      {showSidebar && (
        <AdaptiveRegion id="sidebar" version="1" columns={1} title="Sidebar">
          <Adaptive id="general" title="General" defaults={{ w: 1, h: 1 }}>
            general
          </Adaptive>
          <Adaptive id="pages" title="Pages" defaults={{ w: 1, h: 1 }}>
            pages
          </Adaptive>
          {chatsShown && (
            <Adaptive id="chats" title="Chats" defaults={{ w: 1, h: 1 }}>
              chats
            </Adaptive>
          )}
        </AdaptiveRegion>
      )}
      <AdaptiveRegion id="dashboard" version="1">
        <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
          revenue
        </Adaptive>
        <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
          txns
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>
  );
  const renderResult = render(applicationTree(showChats));
  const itemElement = (regionId: string, componentId: string) =>
    renderResult.container.querySelector<HTMLElement>(
      `[data-clickless-region="${regionId}"] [data-clickless-item="${componentId}"]`,
    );
  const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement;
  return {
    renderResult,
    regionApi: (regionId: string) => regionApis[regionId]!,
    isHidden: (regionId: string, componentId: string) => itemElement(regionId, componentId)?.hidden ?? null,
    drawOrderOf: (regionId: string, componentId: string) => itemElement(regionId, componentId)!.style.order,
    rerenderWithoutChats: () => renderResult.rerender(applicationTree(false)),
    engineCallsTo: (endpointPath: string) =>
      engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === endpointPath),
    waitUntilLoaded: () =>
      waitFor(() => {
        expect(regionApis.dashboard!.loading).toBe(false);
        if (showSidebar) expect(regionApis.sidebar!.manifest && !regionApis.sidebar!.loading).toBe(true);
      }),
    async sendPrompt(prompt: string) {
      fireEvent.change(promptInput(), { target: { value: prompt } });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
      });
    },
    async pressButton(buttonName: string) {
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: buttonName }));
      });
    },
  };
}

describe("one prompt box for a page and its sidebar", () => {
  it("sends one prompt for both regions, and previews and keeps what it changes in each", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Revenue and Chats are hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();

    await pageWithSidebar.sendPrompt("hide revenue, and hide Chats in the sidebar");
    await pageWithSidebar.renderResult.findByText("Revenue and Chats are hidden.");

    // One request, holding what both regions contain. Neither region's own planner is asked.
    const [planCall] = pageWithSidebar.engineCallsTo("v1/plan");
    expect(pageWithSidebar.engineCallsTo("v1/plan")).toHaveLength(1);
    expect(pageWithSidebar.engineCallsTo("plan")).toHaveLength(0);
    expect(planCall!.requestBody.prompt).toBe("hide revenue, and hide Chats in the sidebar");
    expect(planCall!.requestBody.regions.map((regionPart: any) => regionPart.manifest.regionId)).toEqual([
      "dashboard",
      "sidebar",
    ]);
    // The sidebar's own name goes with it, so "in the sidebar" can be understood.
    expect(planCall!.requestBody.regions[1].manifest.title).toBe("Sidebar");

    // Both are previewed, and nothing is saved yet.
    expect(pageWithSidebar.regionApi("dashboard").preview?.items.revenue?.hidden).toBe(true);
    expect(pageWithSidebar.regionApi("sidebar").preview?.items.chats?.hidden).toBe(true);
    expect(pageWithSidebar.engineCallsTo("v1/changes")).toHaveLength(0);

    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    // Saved in one request, and each region's layout is stored on its own.
    const [saveCall] = pageWithSidebar.engineCallsTo("v1/changes");
    expect(pageWithSidebar.engineCallsTo("revisions")).toHaveLength(0);
    expect(saveCall!.requestBody.prompt).toBe("hide revenue, and hide Chats in the sidebar");
    expect(saveCall!.requestBody.message).toBe("Revenue and Chats are hidden.");
    expect(
      saveCall!.requestBody.regions.map((regionPart: any) => [
        regionPart.manifest.regionId,
        regionPart.operations,
        regionPart.baseRevision,
      ]),
    ).toEqual([
      ["dashboard", HIDE_REVENUE, 0],
      ["sidebar", HIDE_CHATS, 0],
    ]);
    expect(engine.regionState.layout?.items.revenue?.hidden).toBe(true);
    expect(Object.keys(engine.savedStateOf("sidebar").layout!.items)).toEqual(["general", "pages", "chats"]);
    expect(pageWithSidebar.regionApi("sidebar").layout?.items.chats?.hidden).toBe(true);
    expect(pageWithSidebar.regionApi("sidebar").preview).toBeNull();

    // It is one entry in the conversation, not one for each region.
    await waitFor(() =>
      expect(
        [...pageWithSidebar.renderResult.container.querySelectorAll('[data-clickless-bubble="user"]')].map((bubbleElement) => bubbleElement.textContent),
      ).toEqual(["hide revenue, and hide Chats in the sidebar"]),
    );
    expect(pageWithSidebar.engineCallsTo("v1/changes").at(-1)!.method).toBe("GET");
  });

  it("changes the sidebar from the page's prompt box, which is all the user sees", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: PAGES_FIRST }],
      message: "Pages now comes first in the sidebar.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();

    await pageWithSidebar.sendPrompt("move the Pages group to the top");
    await pageWithSidebar.renderResult.findByText("Pages now comes first in the sidebar.");
    expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("0");
    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();

    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");
    expect(engine.savedStateOf("sidebar").layout?.order).toEqual(["pages", "general", "chats"]);
    // The page was not changed, so it gains no saved change of its own.
    expect(engine.regionState.revision).toBe(0);
  });

  it("discards a preview in every region, and tells the engine once", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");

    await pageWithSidebar.pressButton("Discard");

    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();
    expect(pageWithSidebar.regionApi("sidebar").preview).toBeNull();
    expect(pageWithSidebar.renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    const [discardCall] = pageWithSidebar.engineCallsTo("v1/discards");
    expect(pageWithSidebar.engineCallsTo("v1/discards")).toHaveLength(1);
    expect(pageWithSidebar.engineCallsTo("discards")).toHaveLength(0);
    expect(discardCall!.requestBody).toEqual({
      prompt: "hide revenue and chats",
      message: "Both hidden.",
      regions: [
        { regionId: "dashboard", manifestVersion: "1", operations: HIDE_REVENUE },
        { regionId: "sidebar", manifestVersion: "1", operations: HIDE_CHATS },
      ],
    });
    expect(engine.savedStateOf("sidebar").revision).toBe(0);
  });

  it("tells the engine once, as abandoned, when the page goes while a preview waits", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");

    pageWithSidebar.renderResult.unmount();

    await waitFor(() => expect(pageWithSidebar.engineCallsTo("v1/discards")).toHaveLength(1));
    expect(pageWithSidebar.engineCallsTo("discards")).toHaveLength(0);
    expect(pageWithSidebar.engineCallsTo("v1/discards")[0]!.requestBody).toEqual({
      prompt: "hide revenue and chats",
      message: "Both hidden.",
      outcome: "abandoned",
      regions: [
        { regionId: "dashboard", manifestVersion: "1", operations: HIDE_REVENUE },
        { regionId: "sidebar", manifestVersion: "1", operations: HIDE_CHATS },
      ],
    });
  });

  it("leaves the preview waiting when a prompt bar that closes by unmounting is closed", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    let closeBar!: () => void;
    // As a bar inside a sheet or dialog that unmounts what it holds when closed.
    function BarInASheet() {
      const [sheetOpen, setSheetOpen] = useState(true);
      closeBar = () => setSheetOpen(false);
      return sheetOpen ? <PromptBar regionId={BOTH_REGIONS} /> : null;
    }
    const pageWithSidebar = renderPageWithSidebar(engine, { promptControl: <BarInASheet /> });
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");

    act(() => closeBar());

    expect(pageWithSidebar.regionApi("dashboard").preview?.items.revenue?.hidden).toBe(true);
    expect(pageWithSidebar.engineCallsTo("v1/discards")).toHaveLength(0);

    // Then the screen changes under it, and only now is it lost.
    pageWithSidebar.rerenderWithoutChats();
    await waitFor(() => expect(pageWithSidebar.engineCallsTo("v1/discards")).toHaveLength(1));
    expect(pageWithSidebar.engineCallsTo("v1/discards")[0]!.requestBody.outcome).toBe("abandoned");
    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();
  });

  it("plans a follow-up from the preview in each region, adds it there, and keeps the whole as one change", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Revenue and Chats are hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Revenue and Chats are hidden.");

    // A follow-up that touches only the sidebar of the two.
    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "sidebar", operations: PAGES_FIRST }], message: "Pages is first." });
    await pageWithSidebar.sendPrompt("and put pages first");
    await pageWithSidebar.renderResult.findByText("Pages is first.");

    const followUpRegions = pageWithSidebar.engineCallsTo("v1/plan").at(-1)!.requestBody.regions;
    expect(followUpRegions.map((region: any) => [region.manifest.regionId, region.preview])).toEqual([
      ["dashboard", { operations: HIDE_REVENUE, baseRevision: 0 }],
      ["sidebar", { operations: HIDE_CHATS, baseRevision: 0 }],
    ]);
    // Both parts of the first preview are still showing, with the follow-up's on top.
    expect(pageWithSidebar.regionApi("dashboard").preview?.items.revenue?.hidden).toBe(true);
    expect(pageWithSidebar.regionApi("sidebar").preview?.items.chats?.hidden).toBe(true);
    expect(pageWithSidebar.regionApi("sidebar").preview?.order[0]).toBe("pages");
    expect(pageWithSidebar.engineCallsTo("v1/discards")).toEqual([]);

    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");
    const saveCalls = pageWithSidebar.engineCallsTo("v1/changes").filter((engineCall) => engineCall.method === "POST");
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]!.requestBody).toMatchObject({
      prompt: "hide revenue and chats\nand put pages first",
      message: "Revenue and Chats are hidden. Pages is first.",
    });
    expect(
      saveCalls[0]!.requestBody.regions.map((region: any) => [region.manifest.regionId, region.operations]),
    ).toEqual([
      ["dashboard", HIDE_REVENUE],
      ["sidebar", [...HIDE_CHATS, ...PAGES_FIRST]],
    ]);
    expect(pageWithSidebar.isHidden("dashboard", "revenue")).toBe(true);
    expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("0");
  });

  it("adds a follow-up that reaches a region the preview had not changed, and discards the whole of it as one change", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "sidebar", operations: HIDE_CHATS }], message: "Chats is hidden." });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide chats");
    await pageWithSidebar.renderResult.findByText("Chats is hidden.");

    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "dashboard", operations: HIDE_REVENUE }], message: "Revenue is hidden." });
    await pageWithSidebar.sendPrompt("and hide revenue");
    await pageWithSidebar.renderResult.findByText("Revenue is hidden.");
    const followUpRegions = pageWithSidebar.engineCallsTo("v1/plan").at(-1)!.requestBody.regions;
    expect(followUpRegions.map((region: any) => region.preview)).toEqual([undefined, { operations: HIDE_CHATS, baseRevision: 0 }]);
    expect(pageWithSidebar.regionApi("sidebar").preview?.items.chats?.hidden).toBe(true);
    expect(pageWithSidebar.regionApi("dashboard").preview?.items.revenue?.hidden).toBe(true);

    await pageWithSidebar.pressButton("Discard");
    await waitFor(() => expect(pageWithSidebar.engineCallsTo("v1/discards")).toHaveLength(1));
    expect(pageWithSidebar.engineCallsTo("v1/discards")[0]!.requestBody).toMatchObject({
      prompt: "hide chats\nand hide revenue",
      message: "Chats is hidden. Revenue is hidden.",
      regions: [
        { regionId: "sidebar", operations: HIDE_CHATS },
        { regionId: "dashboard", operations: HIDE_REVENUE },
      ],
    });
    expect(pageWithSidebar.regionApi("sidebar").preview).toBeNull();
    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();
    expect(pageWithSidebar.isHidden("sidebar", "chats")).toBe(false);
    expect(pageWithSidebar.isHidden("dashboard", "revenue")).toBe(false);
  });

  it("takes back the part of the preview a follow-up asks for, and leaves the rest", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Revenue and Chats are hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Revenue and Chats are hidden.");

    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "show", id: "revenue" }] }],
      message: "Revenue is back.",
    });
    await pageWithSidebar.sendPrompt("not revenue, just chats");
    await pageWithSidebar.renderResult.findByText("Revenue is back.");

    expect(pageWithSidebar.isHidden("dashboard", "revenue")).toBe(false);
    expect(pageWithSidebar.isHidden("sidebar", "chats")).toBe(true);
    expect(pageWithSidebar.renderResult.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(pageWithSidebar.engineCallsTo("v1/discards")).toEqual([]);
  });

  it("says so plainly when a follow-up comes after a region of the preview changed elsewhere", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "sidebar", operations: HIDE_CHATS }], message: "Chats is hidden." });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide chats");
    await pageWithSidebar.renderResult.findByText("Chats is hidden.");

    // In another tab, the user moved Pages to the top of the sidebar.
    const sidebarElsewhere = engine.savedStateOf("sidebar");
    sidebarElsewhere.layout = { ...pageWithSidebar.regionApi("sidebar").layout!, order: ["pages", "general", "chats"] };
    sidebarElsewhere.revision = 1;
    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "dashboard", operations: HIDE_REVENUE }], message: "Revenue is hidden." });
    await pageWithSidebar.sendPrompt("and hide revenue");

    await pageWithSidebar.renderResult.findByText("This screen was changed somewhere else. It has been refreshed, so please try again.");
    expect(pageWithSidebar.regionApi("sidebar").preview).toBeNull();
    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();
    expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("0");
    expect(pageWithSidebar.isHidden("sidebar", "chats")).toBe(false);
  });

  it("undoes a change in both regions with one press, then the change before it", async () => {
    const engine = createFakeEngine();
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    // First the sidebar alone, by the application's own control. Then both, by prompt.
    await act(() => pageWithSidebar.regionApi("sidebar").applyOperations(PAGES_FIRST));
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");
    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    await pageWithSidebar.pressButton("Undo");
    await pageWithSidebar.renderResult.findByText("Undone: “hide revenue and chats”.");
    expect(pageWithSidebar.engineCallsTo("v1/changes/undo")).toHaveLength(1);
    expect(pageWithSidebar.engineCallsTo("undo")).toHaveLength(0);
    expect(pageWithSidebar.isHidden("dashboard", "revenue")).toBe(false);
    expect(pageWithSidebar.isHidden("sidebar", "chats")).toBe(false);
    // The sidebar's earlier change is still there.
    expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("0");

    await pageWithSidebar.pressButton("Undo");
    await pageWithSidebar.renderResult.findByText("Undone: changed Pages.");
    await waitFor(() => expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("1"));
    expect(engine.regionState.revision).toBe(2);
    await waitFor(() => expect(pageWithSidebar.renderResult.queryByRole("button", { name: "Undo" })).toBeNull());
  });

  it("says so when an undo leaves part of the change on a page that changed again since", async () => {
    const engine = createFakeEngine();
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: HIDE_CHATS }],
      message: "Chats hidden.",
    });
    await pageWithSidebar.sendPrompt("hide chats");
    await pageWithSidebar.renderResult.findByText("Chats hidden.");
    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    engine.keepPartOfTheNextUndoIn(["tasks"]);
    await pageWithSidebar.pressButton("Undo");

    await pageWithSidebar.renderResult.findByText(
      "Undone here: “hide chats”. Part of that change stays in place elsewhere, because that part was changed again since.",
    );
    expect(pageWithSidebar.isHidden("sidebar", "chats")).toBe(false);
  });

  it("saves nothing when one region was changed somewhere else, and says so", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");
    fireEvent.change(pageWithSidebar.renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "" },
    });

    // In another tab, the user moved Pages to the top of the sidebar.
    const sidebarElsewhere = engine.savedStateOf("sidebar");
    sidebarElsewhere.layout = { ...pageWithSidebar.regionApi("sidebar").layout!, order: ["pages", "general", "chats"] };
    sidebarElsewhere.revision = 1;

    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("This screen was changed somewhere else. It has been refreshed, so please try again.");

    // Neither half was saved: the page is as it was, and the sidebar shows what was done elsewhere.
    expect(engine.regionState.revision).toBe(0);
    expect(sidebarElsewhere.revision).toBe(1);
    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();
    expect(pageWithSidebar.regionApi("sidebar").preview).toBeNull();
    expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("0");
    expect(pageWithSidebar.isHidden("dashboard", "revenue")).toBe(false);
    expect(pageWithSidebar.renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    // The request is back in the box, ready to send again.
    expect(
      (pageWithSidebar.renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement).value,
    ).toBe("hide revenue and chats");
    // Only the region that had changed was fetched again.
    expect(pageWithSidebar.engineCallsTo("layout")).toHaveLength(3);
  });

  it("takes the whole preview off when part of it no longer fits its region", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");

    // The application takes Chats out of the sidebar while the preview is showing.
    pageWithSidebar.rerenderWithoutChats();

    await waitFor(() => expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull());
    expect(pageWithSidebar.renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(pageWithSidebar.engineCallsTo("v1/changes")).toHaveLength(0);
  });

  it("shows none of a plan when one region cannot take its part", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    const pageWithSidebar = renderPageWithSidebar(engine, { showChats: false });
    await pageWithSidebar.waitUntilLoaded();

    await pageWithSidebar.sendPrompt("hide revenue and chats");

    await pageWithSidebar.renderResult.findByText("That change no longer fits this screen. Please try again.");
    expect(pageWithSidebar.regionApi("dashboard").preview).toBeNull();
    expect(pageWithSidebar.renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
  });

  it("leaves out a region that is not on this screen", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "dashboard", operations: HIDE_REVENUE }], message: "Revenue is hidden." });
    const pageWithSidebar = renderPageWithSidebar(engine, { showSidebar: false });
    await pageWithSidebar.waitUntilLoaded();

    await pageWithSidebar.sendPrompt("hide revenue");
    await pageWithSidebar.renderResult.findByText("Revenue is hidden.");
    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    expect(pageWithSidebar.engineCallsTo("v1/plan")[0]!.requestBody.regions.map((regionPart: any) => regionPart.manifest.regionId)).toEqual(["dashboard"]);
    expect(pageWithSidebar.engineCallsTo("v1/changes")[0]!.requestBody.regions).toHaveLength(1);
    expect(engine.regionState.layout?.items.revenue?.hidden).toBe(true);
  });

  it("lists past changes to either region, and restores the screen to any of them", async () => {
    const engine = createFakeEngine();
    const pageWithSidebar = renderPageWithSidebar(engine);
    await pageWithSidebar.waitUntilLoaded();
    await act(() => pageWithSidebar.regionApi("sidebar").applyOperations(PAGES_FIRST, "pages first", "Pages is first."));
    engine.setPlanAcrossRegionsReply({
      changes: [
        { regionId: "dashboard", operations: HIDE_REVENUE },
        { regionId: "sidebar", operations: HIDE_CHATS },
      ],
      message: "Both hidden.",
    });
    await pageWithSidebar.sendPrompt("hide revenue and chats");
    await pageWithSidebar.renderResult.findByText("Both hidden.");
    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    const shownPrompts = () =>
      [...pageWithSidebar.renderResult.container.querySelectorAll('[data-clickless-bubble="user"]')].map((bubbleElement) => bubbleElement.textContent);
    await waitFor(() => expect(shownPrompts()).toEqual(["pages first", "hide revenue and chats"]));
    // The latest is where the screen is now, so only the earlier one can be gone back to.
    expect(pageWithSidebar.renderResult.getAllByText("Current")).toHaveLength(1);

    await pageWithSidebar.pressButton("Restore to this point");
    await pageWithSidebar.renderResult.findByText("Back to how this page was at that point.");

    expect(pageWithSidebar.engineCallsTo("v1/changes/restore")[0]!.requestBody).toEqual({
      changeId: 1,
      regions: [
        { regionId: "dashboard", baseRevision: 1 },
        { regionId: "sidebar", baseRevision: 2 },
      ],
    });
    expect(pageWithSidebar.isHidden("dashboard", "revenue")).toBe(false);
    expect(pageWithSidebar.isHidden("sidebar", "chats")).toBe(false);
    expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("0");

    await pageWithSidebar.pressButton("Revert to original");
    await waitFor(() => expect(pageWithSidebar.drawOrderOf("sidebar", "pages")).toBe("1"));
    expect(pageWithSidebar.engineCallsTo("v1/changes/restore")[1]!.requestBody.changeId).toBe(0);
    expect(pageWithSidebar.renderResult.queryByRole("button", { name: "Revert to original" })).toBeNull();
  });

  it("works the same from the inline bar", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [{ regionId: "sidebar", operations: HIDE_CHATS }], message: "Chats is hidden." });
    const pageWithSidebar = renderPageWithSidebar(engine, { promptControl: <PromptBar regionId={["dashboard", "sidebar"]} /> });
    await pageWithSidebar.waitUntilLoaded();

    // The ids are written out in the page each time it draws, which must not start the bar again.
    await pageWithSidebar.sendPrompt("hide chats");
    await pageWithSidebar.renderResult.findByText("Chats is hidden.");
    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    expect(engine.savedStateOf("sidebar").layout?.items.chats?.hidden).toBe(true);
    expect(pageWithSidebar.renderResult.container.querySelector('[data-clickless-prompt-bar="dashboard sidebar"]')).toBeTruthy();
  });

  it("still speaks for one region, through that region's own requests, when given one id in a list", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: HIDE_REVENUE, message: "Revenue is hidden." });
    const pageWithSidebar = renderPageWithSidebar(engine, { promptControl: <PromptBar regionId={["dashboard"]} /> });
    await pageWithSidebar.waitUntilLoaded();

    await pageWithSidebar.sendPrompt("hide revenue");
    await pageWithSidebar.renderResult.findByText("Revenue is hidden.");
    await pageWithSidebar.pressButton("Keep");
    await pageWithSidebar.renderResult.findByText("Your change to this screen is saved.");

    expect(pageWithSidebar.engineCallsTo("plan")).toHaveLength(1);
    expect(pageWithSidebar.engineCallsTo("revisions")).toHaveLength(1);
    expect(pageWithSidebar.engineCallsTo("v1/plan")).toHaveLength(0);
  });
});
