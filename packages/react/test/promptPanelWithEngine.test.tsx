// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation } from "@clickless/core";
import {
  Adaptive,
  AdaptiveProvider,
  AdaptiveRegion,
  PromptPanel,
  useAdaptiveRegion,
  type PromptPanelPosition,
} from "../src/index";
import { ClicklessUiErrorBoundary } from "../src/components/ClicklessUiErrorBoundary";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(cleanup);

describe("PromptPanel", () => {
  const HIDE_REVENUE_OPERATIONS: Operation[] = [{ type: "hide", id: "revenue" }];
  const promptPanel = <PromptPanel regionId="dashboard" defaultOpen pageSize={2} />;

  /**
   * A user returning to a screen with four saved changes: three by prompt and
   * one, after the first, made with the application's own controls.
   */
  async function renderPanelWithHistory() {
    const engine = createFakeEngine();
    const earlierSession = renderDashboardWithEngine(engine);
    await waitFor(() => expect(earlierSession.regionApi().loading).toBe(false));
    const { applyOperations: applyToRegion } = earlierSession.regionApi();
    await act(() => applyToRegion(MOVE_TRANSACTIONS_FIRST, "transactions first", "Transactions moved up."));
    await act(() => applyToRegion(HIDE_REVENUE_OPERATIONS));
    await act(() => applyToRegion([{ type: "show", id: "revenue" }], "bring revenue back", "Revenue is back."));
    await act(() => applyToRegion([{ type: "hide", id: "txns" }], "hide transactions", "Transactions hidden."));
    cleanup();

    const panelSession = renderDashboardWithEngine(engine, promptPanel);
    await panelSession.renderResult.findByText("hide transactions");
    return { engine, ...panelSession };
  }

  const shownPrompts = (renderResult: ReturnType<typeof renderDashboardWithEngine>["renderResult"]) =>
    [...renderResult.container.querySelectorAll('[data-clickless-bubble="user"]')].map(
      (bubbleElement) => bubbleElement.textContent,
    );

  it("is a button until opened, and closes again", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel regionId="dashboard" />);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    expect(renderResult.queryByRole("dialog")).toBeNull();
    fireEvent.click(renderResult.getByRole("button", { name: "Ask ClickLess" }));
    expect(renderResult.getByRole("dialog", { name: "Ask ClickLess" })).toBeTruthy();
    expect(document.activeElement).toBe(renderResult.getByLabelText("Describe a change to this screen"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(renderResult.queryByRole("dialog")).toBeNull();
  });

  it("can be minimised from its header, keeping the conversation and any preview", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Transactions now come before Revenue." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;

    fireEvent.change(promptInput(), { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.keyDown(promptInput(), { key: "Enter" });
    });
    await renderResult.findByText("Transactions now come before Revenue.");

    // Unlike Escape or a click elsewhere, this works while a preview is waiting.
    fireEvent.click(renderResult.getByRole("button", { name: "Minimise" }));
    expect(renderResult.queryByRole("dialog")).toBeNull();
    expect(drawOrderOf("txns")).toBe("1");
    // The button that brings it back says there is something to decide, and has the focus.
    const launcherButton = renderResult.getByRole("button", { name: "Keep or discard?" });
    expect(document.activeElement).toBe(launcherButton);

    fireEvent.click(launcherButton);
    expect(renderResult.getByText("Transactions now come before Revenue.")).toBeTruthy();
    expect(renderResult.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(renderResult.getByText("transactions first")).toBeTruthy();
  });

  it("keeps what was said of a change saved where it was said, above the next request", async () => {
    const engine = createFakeEngine();
    let resolvePlanRequest: (() => void) | null = null;
    const slowPlanEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) => {
          if (String(requestInput).endsWith("/plan") && resolvePlanRequest === null) {
            await new Promise<void>((resolve) => (resolvePlanRequest = resolve));
          }
          return engine.engineOptions.fetch(requestInput, requestInit);
        }) as typeof fetch,
      },
    };
    const { renderResult, regionApi } = renderDashboardWithEngine(slowPlanEngine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen");
    const shownBubbles = () =>
      [...renderResult.container.querySelectorAll("[data-clickless-bubble]")].map((bubbleElement) => bubbleElement.textContent);
    const sendPrompt = async (prompt: string) => {
      fireEvent.change(promptInput(), { target: { value: prompt } });
      await act(async () => {
        fireEvent.keyDown(promptInput(), { key: "Enter" });
      });
    };

    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    await sendPrompt("transactions first");
    await act(async () => resolvePlanRequest!());
    fireEvent.click(await renderResult.findByRole("button", { name: "Keep" }));
    await renderResult.findByText("Your change to this screen is saved.");

    engine.setPlanReply({ operations: [], message: "You can move or hide any section." });
    resolvePlanRequest = null;
    await sendPrompt("what can I change?");
    // While the answer is awaited, the request comes after what was said before it.
    await waitFor(() => expect(shownBubbles().indexOf("what can I change?")).toBeGreaterThan(shownBubbles().indexOf("Your change to this screen is saved.")));
    expect(shownBubbles().indexOf("Your change to this screen is saved.")).not.toBe(-1);

    await act(async () => resolvePlanRequest!());
    await renderResult.findByText("You can move or hide any section.");
    expect(shownBubbles().slice(-3)).toEqual(["Your change to this screen is saved.", "what can I change?", "You can move or hide any section."]);
  });

  it("shows a change kept after another below what was said of the first", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen");
    const shownBubbles = () =>
      [...renderResult.container.querySelectorAll("[data-clickless-bubble]")].map((bubbleElement) => bubbleElement.textContent);
    const keepPrompt = async (prompt: string, reply: string) => {
      fireEvent.change(promptInput(), { target: { value: prompt } });
      await act(async () => {
        fireEvent.keyDown(promptInput(), { key: "Enter" });
      });
      fireEvent.click(await renderResult.findByRole("button", { name: "Keep" }));
      await waitFor(() => expect(shownBubbles().at(-1)).toBe("Your change to this screen is saved."));
      await waitFor(() => expect(shownBubbles()).toContain(reply));
    };

    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Transactions moved up." });
    await keepPrompt("transactions first", "Transactions moved up.");
    engine.setPlanReply({ operations: HIDE_REVENUE_OPERATIONS, message: "Revenue is hidden." });
    await keepPrompt("hide revenue", "Revenue is hidden.");

    expect(shownBubbles()).toEqual([
      "transactions first",
      "Transactions moved up.",
      "Your change to this screen is saved.",
      "hide revenue",
      "Revenue is hidden.",
      "Your change to this screen is saved.",
    ]);
  });

  it("says so when a preview arrives after the panel was minimised", async () => {
    const engine = createFakeEngine();
    let resolvePlanRequest!: () => void;
    const planRequestHeld = new Promise<void>((resolve) => (resolvePlanRequest = resolve));
    const slowPlanEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) => {
          if (String(requestInput).endsWith("/plan")) await planRequestHeld;
          return engine.engineOptions.fetch(requestInput, requestInit);
        }) as typeof fetch,
      },
    };
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(slowPlanEngine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = renderResult.getByLabelText("Describe a change to this screen");

    fireEvent.change(promptInput, { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    fireEvent.click(renderResult.getByRole("button", { name: "Minimise" }));
    expect(renderResult.getByRole("button", { name: "Ask ClickLess" })).toBeTruthy();
    expect(renderResult.getByRole("status").textContent).toBe("");

    await act(async () => {
      resolvePlanRequest();
      await planRequestHeld;
    });
    const launcherButton = await renderResult.findByRole("button", { name: "Keep or discard?" });
    expect(renderResult.getByRole("status").textContent).toBe(
      "A preview is showing. Open the panel to keep or discard it.",
    );

    fireEvent.click(launcherButton);
    fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));
    fireEvent.click(renderResult.getByRole("button", { name: "Minimise" }));
    expect(renderResult.getByRole("button", { name: "Ask ClickLess" })).toBeTruthy();
  });

  it("closes when the user clicks elsewhere, but not while a preview is waiting", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const elementOutsidePanel = renderResult.container.querySelector('[data-clickless-item="balance"]')!;

    fireEvent.pointerDown(renderResult.getByRole("dialog"));
    expect(renderResult.queryByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeNull();

    fireEvent.click(renderResult.getByRole("button", { name: "Ask ClickLess" }));
    const promptInput = renderResult.getByLabelText("Describe a change to this screen");
    fireEvent.change(promptInput, { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    await renderResult.findByText("Moved.");
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeTruthy();

    fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));
    // Something typed and not sent yet keeps it open.
    fireEvent.change(promptInput, { target: { value: "revenue first" } });
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeTruthy();
    fireEvent.change(promptInput, { target: { value: "" } });
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeNull();
  });

  it("stays open on a click elsewhere while the answer to a request is showing", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [], message: "Open the Analytics tab and ask again." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const elementOutsidePanel = renderResult.container.querySelector('[data-clickless-item="balance"]')!;
    const promptInput = renderResult.getByLabelText("Describe a change to this screen");

    fireEvent.change(promptInput, { target: { value: "make the devices chart wider" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    await renderResult.findByText("Open the Analytics tab and ask again.");
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeTruthy();
  });

  it("stays open on a click elsewhere while something is typed in the box", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const elementOutsidePanel = renderResult.container.querySelector('[data-clickless-item="balance"]')!;
    const promptInput = renderResult.getByLabelText("Describe a change to this screen");

    fireEvent.change(promptInput, { target: { value: "make the devices chart wider" } });
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeTruthy();

    fireEvent.change(promptInput, { target: { value: "" } });
    fireEvent.pointerDown(elementOutsidePanel);
    expect(renderResult.queryByRole("dialog")).toBeNull();
  });

  it("can be told to stay open when the user clicks elsewhere", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(
      engine,
      <PromptPanel regionId="dashboard" defaultOpen closeOnOutsideClick={false} />,
    );
    await waitFor(() => expect(regionApi().loading).toBe(false));
    fireEvent.pointerDown(renderResult.container.querySelector('[data-clickless-item="balance"]')!);
    expect(renderResult.queryByRole("dialog")).toBeTruthy();
  });

  it("lists only changes made by prompt, with their replies", async () => {
    const { renderResult, engine } = await renderPanelWithHistory();
    expect(shownPrompts(renderResult)).toEqual(["bring revenue back", "hide transactions"]);
    expect(renderResult.getByText("Revenue is back.")).toBeTruthy();
    expect(renderResult.getByText("Transactions hidden.")).toBeTruthy();
    expect(renderResult.getByText("Current")).toBeTruthy();
    expect(renderResult.getAllByRole("button", { name: "Restore to this point" })).toHaveLength(1);
    expect(engine.receivedCalls.at(-1)!.endpointPath).toBe("revisions?limit=2&prompted=true");
  });

  it("loads earlier prompts above the ones showing, skipping manual changes", async () => {
    const { renderResult } = await renderPanelWithHistory();
    fireEvent.click(renderResult.getByRole("button", { name: "See earlier changes" }));
    await renderResult.findByText("transactions first");
    expect(shownPrompts(renderResult)).toEqual(["transactions first", "bring revenue back", "hide transactions"]);
    expect(renderResult.queryByRole("button", { name: "See earlier changes" })).toBeNull();
    expect(renderResult.container.querySelectorAll("article")).toHaveLength(3);
  });

  it("puts a past prompt back in the box to edit", async () => {
    const { renderResult } = await renderPanelWithHistory();
    fireEvent.click(renderResult.getAllByRole("button", { name: "Reuse" })[0]!);
    const promptInput = renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
    expect(promptInput.value).toBe("bring revenue back");
    expect(document.activeElement).toBe(promptInput);
  });

  it("restores the screen to an earlier prompt and marks it as current", async () => {
    const { renderResult, engine, regionApi } = await renderPanelWithHistory();
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Restore to this point" }));
    });
    const restoredNote = await renderResult.findByText("Back to how this page was at that point.");
    // It names the request it went back to, under the sentence.
    expect(restoredNote.textContent).toBe("Back to how this page was at that point.“bring revenue back”");

    expect(engine.receivedCalls.find((receivedCall) => receivedCall.endpointPath === "restore")).toMatchObject({
      requestBody: { revision: 3, baseRevision: 4 },
    });
    expect(regionApi().layout!.items.txns!.hidden).toBe(false);
    expect(regionApi().revision).toBe(5);
    // The restore itself is not listed, and the prompt it returned to is the current one.
    expect(shownPrompts(renderResult)).toEqual(["bring revenue back", "hide transactions"]);
    const firstArticle = renderResult.container.querySelector("article")!;
    expect(firstArticle.textContent).toContain("Current");
    expect(renderResult.getAllByRole("button", { name: "Restore to this point" })).toHaveLength(1);

    // Once something else is done, the sentence stays where it was said, still naming the request.
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Undo" }));
    });
    await renderResult.findByText("Undone:", { exact: false });
    expect(renderResult.getByText("Back to how this page was at that point.").textContent).toBe(
      "Back to how this page was at that point.“bring revenue back”",
    );
  });

  it("does not mark a prompt current when restoring to it failed", async () => {
    const { renderResult, engine, regionApi } = await renderPanelWithHistory();
    engine.failNextRequest(409, { code: "conflict", message: "The layout changed since it was last read" });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Restore to this point" }));
    });
    await renderResult.findByRole("alert");
    expect(renderResult.container.querySelectorAll("article")[1]!.textContent).toContain("Current");

    // A later change must not be taken for the restore that never happened.
    await act(() => regionApi().applyOperations(HIDE_REVENUE_OPERATIONS));
    await waitFor(() => expect(renderResult.queryByText("Current")).toBeNull());
    expect(renderResult.getAllByRole("button", { name: "Restore to this point" })).toHaveLength(2);
  });

  it("keeps the mark for one region from showing in another", async () => {
    const engine = createFakeEngine();
    const regionApisById: Record<string, RegionApi> = {};
    function RegionApiProbe({ regionId }: { regionId: string }) {
      regionApisById[regionId] = useAdaptiveRegion(regionId);
      return null;
    }
    function ScreenWithPanel({ panelFor }: { panelFor: string }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <PromptPanel regionId={panelFor} defaultOpen />
          {["dashboard", "reports"].map((regionId) => (
            <AdaptiveRegion key={regionId} id={regionId} version="1">
              <RegionApiProbe regionId={regionId} />
              <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
                revenue
              </Adaptive>
              <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
                txns
              </Adaptive>
            </AdaptiveRegion>
          ))}
        </AdaptiveProvider>
      );
    }
    const renderResult = render(<ScreenWithPanel panelFor="dashboard" />);
    await waitFor(() => expect(regionApisById.reports?.loading).toBe(false));

    // On the dashboard: two prompts, then back to the first. That restore is its third saved change.
    await act(() => regionApisById.dashboard!.applyOperations(HIDE_REVENUE_OPERATIONS, "hide revenue", "Hidden."));
    await act(() => regionApisById.dashboard!.applyOperations([{ type: "show", id: "revenue" }], "show it", "Shown."));
    await renderResult.findByText("show it");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Restore to this point" }));
    });
    await renderResult.findByText("Back to how this page was at that point.");
    expect(renderResult.container.querySelector("article")!.textContent).toContain("Current");

    // Reports has three saved changes of its own, so its numbers match the dashboard's.
    await act(() => regionApisById.reports!.applyOperations(HIDE_REVENUE_OPERATIONS, "first on reports", "Hidden."));
    await act(() => regionApisById.reports!.applyOperations([{ type: "show", id: "revenue" }], "second", "Shown."));
    await act(() => regionApisById.reports!.applyOperations([{ type: "hide", id: "txns" }], "third", "Hidden."));

    renderResult.rerender(<ScreenWithPanel panelFor="reports" />);
    await renderResult.findByText("third");
    const articleElements = [...renderResult.container.querySelectorAll("article")];
    expect(shownPrompts(renderResult)).toEqual(["first on reports", "second", "third"]);
    // The latest is the current one here, not the one the dashboard went back to.
    expect(articleElements[0]!.textContent).not.toContain("Current");
    expect(articleElements[2]!.textContent).toContain("Current");
  });

  it("does not mark any prompt current after a change made by hand", async () => {
    const { renderResult, regionApi } = await renderPanelWithHistory();
    await act(() => regionApi().applyOperations(HIDE_REVENUE_OPERATIONS));
    await waitFor(() => expect(renderResult.queryByText("Current")).toBeNull());
    expect(shownPrompts(renderResult)).toEqual(["bring revenue back", "hide transactions"]);
    expect(renderResult.getAllByRole("button", { name: "Restore to this point" })).toHaveLength(2);
  });

  it("keeps Revert to original in view without the whole history loaded", async () => {
    const { renderResult, regionApi } = await renderPanelWithHistory();
    // Earlier changes are still to load, and the way back to the start is already there.
    expect(renderResult.getByRole("button", { name: "See earlier changes" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Revert to original" }));
    });
    await waitFor(() => expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]));
    expect(regionApi().layout!.items.txns!.hidden).toBe(false);
    // Nothing differs from the start now, so there is nothing to revert.
    expect(renderResult.queryByRole("button", { name: "Revert to original" })).toBeNull();
    expect(renderResult.queryByRole("button", { name: "See original" })).toBeNull();
  });

  it("offers neither See original nor Revert to original on a screen that was never changed", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    expect(renderResult.queryByRole("button", { name: "See original" })).toBeNull();
    expect(renderResult.queryByRole("button", { name: "Revert to original" })).toBeNull();
  });

  it("shows how the screen first looked, in place, without saving anything", async () => {
    const { renderResult, regionApi, drawOrderOf, engine } = await renderPanelWithHistory();
    const itemElement = (componentId: string) =>
      renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!;
    expect(itemElement("txns").hidden).toBe(true);
    const callsBefore = engine.receivedCalls.length;

    fireEvent.click(renderResult.getByRole("button", { name: "See original" }));
    expect(renderResult.getByText("You're seeing the original. Nothing is saved unless you keep it.")).toBeTruthy();
    // Transactions is back where it was written, and marked as different from the user's version.
    expect(itemElement("txns").hidden).toBe(false);
    expect(itemElement("txns").dataset.clicklessPreview).toBe("changed");
    expect(drawOrderOf("txns")).toBe("2");
    // What is saved is untouched, and the engine was not asked anything.
    expect(regionApi().layout!.items.txns!.hidden).toBe(true);
    expect(engine.receivedCalls.length).toBe(callsBefore);

    // Minimised, the button says what the screen is showing.
    fireEvent.click(renderResult.getByRole("button", { name: "Minimise" }));
    fireEvent.click(renderResult.getByRole("button", { name: "Seeing original" }));

    fireEvent.click(renderResult.getByRole("button", { name: "Back to my version" }));
    expect(itemElement("txns").hidden).toBe(true);
    expect(itemElement("txns").dataset.clicklessPreview).toBeUndefined();
    expect(renderResult.getByRole("button", { name: "See original" })).toBeTruthy();
  });

  it("keeps the original when asked to from the look at it", async () => {
    const { renderResult, regionApi } = await renderPanelWithHistory();
    fireEvent.click(renderResult.getByRole("button", { name: "See original" }));
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep the original" }));
    });
    await waitFor(() => expect(regionApi().layout!.items.txns!.hidden).toBe(false));
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);
    expect(renderResult.queryByText("You're seeing the original. Nothing is saved unless you keep it.")).toBeNull();
  });

  it("goes back to the user's version when they ask for a change", async () => {
    const { renderResult, engine } = await renderPanelWithHistory();
    engine.setPlanReply({ operations: HIDE_REVENUE_OPERATIONS, message: "Revenue is hidden." });
    const itemElement = (componentId: string) =>
      renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!;
    fireEvent.click(renderResult.getByRole("button", { name: "See original" }));
    expect(itemElement("txns").hidden).toBe(false);

    const promptInput = renderResult.getByLabelText("Describe a change to this screen");
    fireEvent.change(promptInput, { target: { value: "hide revenue" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    await renderResult.findByText("Revenue is hidden.");
    // The preview is of the user's version, which still has Transactions hidden.
    expect(itemElement("txns").hidden).toBe(true);
    expect(itemElement("revenue").hidden).toBe(true);
    expect(renderResult.queryByText("You're seeing the original. Nothing is saved unless you keep it.")).toBeNull();
  });

  it("starts a fresh conversation when pointed at another region", async () => {
    const engine = createFakeEngine();
    function ScreenWithPanel({ panelFor }: { panelFor: string }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <PromptPanel regionId={panelFor} defaultOpen />
          <AdaptiveRegion id="dashboard" version="1">
            <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
              revenue
            </Adaptive>
            <Adaptive id="sales" title="Sales" defaults={{ w: 6, h: 3 }}>
              sales
            </Adaptive>
          </AdaptiveRegion>
        </AdaptiveProvider>
      );
    }
    engine.setPlanReply({ operations: [{ type: "hide", id: "revenue" }], message: "Revenue hidden." });
    const renderResult = render(<ScreenWithPanel panelFor="dashboard" />);
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
    await waitFor(() => expect(engine.receivedCalls.length).toBeGreaterThan(0));

    fireEvent.change(promptInput(), { target: { value: "hide revenue" } });
    await act(async () => {
      fireEvent.keyDown(promptInput(), { key: "Enter" });
    });
    await renderResult.findByText("Revenue hidden.");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    await waitFor(() => expect(shownPrompts(renderResult)).toEqual(["hide revenue"]));

    renderResult.rerender(<ScreenWithPanel panelFor="elsewhere" />);
    await waitFor(() => expect(shownPrompts(renderResult)).toEqual([]));
    expect(renderResult.queryByText("Your change to this screen is saved.")).toBeNull();
    expect(promptInput().value).toBe("");
  });

  it("drops a reply that arrives after the panel was pointed at another region", async () => {
    const engine = createFakeEngine();
    let resolvePlanRequest!: () => void;
    const planRequestHeld = new Promise<void>((resolve) => (resolvePlanRequest = resolve));
    const slowPlanEngineOptions = {
      ...engine.engineOptions,
      fetch: (async (requestInput, requestInit) => {
        if (String(requestInput).endsWith("/plan")) await planRequestHeld;
        return engine.engineOptions.fetch(requestInput, requestInit);
      }) as typeof fetch,
    };
    function ScreenWithPanel({ panelFor }: { panelFor: string }) {
      return (
        <AdaptiveProvider userId="user-1" engine={slowPlanEngineOptions}>
          <PromptPanel regionId={panelFor} defaultOpen />
          <AdaptiveRegion id="dashboard" version="1">
            <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
              revenue
            </Adaptive>
          </AdaptiveRegion>
        </AdaptiveProvider>
      );
    }
    engine.setPlanReply({ operations: [{ type: "hide", id: "revenue" }], message: "Revenue hidden." });
    const renderResult = render(<ScreenWithPanel panelFor="dashboard" />);
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
    await waitFor(() => expect(engine.receivedCalls.length).toBeGreaterThan(0));

    fireEvent.change(promptInput(), { target: { value: "hide revenue" } });
    await act(async () => {
      fireEvent.keyDown(promptInput(), { key: "Enter" });
    });
    renderResult.rerender(<ScreenWithPanel panelFor="elsewhere" />);
    await waitFor(() => expect(promptInput().readOnly).toBe(false));

    await act(async () => {
      resolvePlanRequest();
      await planRequestHeld;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renderResult.queryByText("Revenue hidden.")).toBeNull();
    expect(renderResult.queryByRole("alert")).toBeNull();
    // Nor is the old region left showing a preview nobody can see the reason for.
    expect(renderResult.container.querySelector("[data-clickless-preview]")).toBeNull();
    expect(renderResult.getByText("revenue")).toBeTruthy();
  });

  it("previews a prompt and saves it from inside the panel", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Transactions now come before Revenue." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    const promptInput = renderResult.getByLabelText("Describe a change to this screen");
    fireEvent.change(promptInput, { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    await renderResult.findByText("Transactions now come before Revenue.");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });

    await waitFor(() => expect(shownPrompts(renderResult)).toEqual(["transactions first"]));
    expect(regionApi().layout!.order).toEqual(["balance", "txns", "revenue"]);
    expect(renderResult.getByText("Current")).toBeTruthy();
  });
});

describe("PromptPanel given a history it cannot fully read", () => {
  it("shows what it can, and neither it nor the page breaks", async () => {
    const engine = createFakeEngine({ revision: 3, layout: null });
    const garbledHistory = {
      revisions: [
        {
          revision: 3,
          kind: "something-new",
          prompt: { text: "an object, not words" },
          message: ["not", "words"],
          operations: [null, "hide", { type: 7 }, { type: "hide", id: "revenue" }],
          createdAt: "2026-10-01T09:03:00Z",
        },
        {
          revision: 2,
          kind: "apply",
          prompt: "hide revenue",
          message: "Revenue is hidden.",
          operations: [{ type: "hide", id: "revenue" }],
          createdAt: "2026-10-01T09:02:00Z",
        },
      ],
      hasMore: false,
    };
    const engineWithGarbledHistory = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) =>
          String(requestInput).includes("/revisions?")
            ? new Response(JSON.stringify(garbledHistory), { status: 200 })
            : engine.engineOptions.fetch(requestInput, requestInit)) as typeof fetch,
      },
    };
    const { renderResult, regionApi } = renderDashboardWithEngine(
      engineWithGarbledHistory,
      <PromptPanel regionId="dashboard" defaultOpen />,
    );
    await renderResult.findByText("Revenue is hidden.");
    expect(renderResult.getByText("hide revenue")).toBeTruthy();
    expect(renderResult.queryByText(/not words/)).toBeNull();
    expect(renderResult.getAllByRole("button", { name: "Restore to this point" })).toHaveLength(1);
    // The page is still there, and its own changes still work.
    let applyOutcome: unknown;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST);
    });
    expect(applyOutcome).toMatchObject({ applied: true });
  });

  it("draws nothing, and leaves the page working, when drawing the panel itself fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const wordingThatBreaks = Object.defineProperty({}, "speak", {
        enumerable: true,
        get() {
          throw new Error("a fault while drawing the panel");
        },
      });
      const engine = createFakeEngine();
      const { renderResult, regionApi, drawOrderOf } = renderDashboardWithEngine(
        engine,
        <PromptPanel regionId="dashboard" defaultOpen dictationLabels={wordingThatBreaks} />,
      );
      await waitFor(() => expect(regionApi().loading).toBe(false));
      expect(renderResult.queryByRole("dialog")).toBeNull();
      expect(renderResult.queryByRole("button", { name: "Ask ClickLess" })).toBeNull();
      expect(renderResult.getByText("revenue")).toBeTruthy();
      await act(() => regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST));
      expect(drawOrderOf("txns")).toBe("1");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("tries drawing again once pointed at other regions after drawing failed", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      function DrawsFor({ regionId }: { regionId: string }) {
        if (regionId === "broken") throw new Error("a fault while drawing the panel");
        return <p>drawn for {regionId}</p>;
      }
      const renderResult = render(
        <ClicklessUiErrorBoundary resetKey="broken">
          <DrawsFor regionId="broken" />
        </ClicklessUiErrorBoundary>,
      );
      expect(renderResult.container.textContent).toBe("");
      renderResult.rerender(
        <ClicklessUiErrorBoundary resetKey="dashboard">
          <DrawsFor regionId="dashboard" />
        </ClicklessUiErrorBoundary>,
      );
      expect(renderResult.getByText("drawn for dashboard")).toBeTruthy();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("PromptPanel for keyboard and other-language users", () => {
  const promptPanel = <PromptPanel regionId="dashboard" defaultOpen />;

  it("offers Undo for a change made with the application's own controls", async () => {
    const engine = createFakeEngine();
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    expect(renderResult.queryByRole("button", { name: "Undo" })).toBeNull();

    await act(() => regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST));
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Undo" }));
    });
    // With no request to quote, the reply says what the change did.
    await renderResult.findByText("Undone: changed Transactions.");
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "undo")).toHaveLength(1);
    expect(drawOrderOf("txns")).toBe("2");
  });

  it("does not send a prompt while a word is still being composed", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;

    fireEvent.change(promptInput, { target: { value: "取引を先に" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter", isComposing: true });
    });
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "plan")).toEqual([]);

    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "plan")).toHaveLength(1);
  });

  it("keeps the keyboard focus in the box while working, and returns it to the button on Escape", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Transactions now come before Revenue." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, promptPanel);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
    promptInput.focus();

    fireEvent.change(promptInput, { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    await renderResult.findByText("Transactions now come before Revenue.");
    expect(document.activeElement).toBe(promptInput);

    // Escape is held back while the preview waits, then closes the panel.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(renderResult.queryByRole("dialog")).toBeTruthy();
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(renderResult.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(renderResult.getByRole("button", { name: "Ask ClickLess" }));
  });
});

describe("where PromptPanel sits on the screen", () => {
  // Whatever is given is passed on as it is, so a value such as null or 0
  // reaches the panel the way it would from a host's config.
  async function renderPanelAt(panelProps: { position?: PromptPanelPosition } = {}) {
    const { renderResult, regionApi } = renderDashboardWithEngine(
      createFakeEngine(),
      <PromptPanel regionId="dashboard" defaultOpen {...panelProps} />,
    );
    await waitFor(() => expect(regionApi().loading).toBe(false));
    return {
      launcherStyle: renderResult.getByRole("button", { name: "Close" }).style,
      panelStyle: renderResult.getByRole("dialog").style,
    };
  }

  // The panel keeps 16px free at the far side and the far end of the screen,
  // however far in the button has been moved.
  const PANEL_WIDTH = "min(380px, calc(100vw - var(--clickless-launcher-offset-x, 16px) - 16px))";
  const PANEL_MAX_HEIGHT = "min(620px, calc(100vh - var(--clickless-launcher-offset-y, 16px) - 52px - 16px))";

  it("is the bottom-right corner unless told otherwise, 16px in from each edge", async () => {
    const { launcherStyle, panelStyle } = await renderPanelAt();
    expect(launcherStyle.right).toBe("var(--clickless-launcher-offset-x, 16px)");
    expect(launcherStyle.bottom).toBe("var(--clickless-launcher-offset-y, 16px)");
    expect(launcherStyle.left).toBe("");
    expect(launcherStyle.top).toBe("");
    expect(panelStyle.right).toBe("var(--clickless-launcher-offset-x, 16px)");
    expect(panelStyle.bottom).toBe("calc(var(--clickless-launcher-offset-y, 16px) + 52px)");
    expect(panelStyle.width).toBe(PANEL_WIDTH);
    expect(panelStyle.maxHeight).toBe(PANEL_MAX_HEIGHT);
  });

  it.each([
    ["bottom-left", "left", "bottom"],
    ["top-right", "right", "top"],
    ["top-left", "left", "top"],
  ] as const)("puts the button and the panel in the %s corner", async (position, horizontalEdge, verticalEdge) => {
    const { launcherStyle, panelStyle } = await renderPanelAt({ position });
    const otherHorizontalEdge = horizontalEdge === "left" ? "right" : "left";
    const otherVerticalEdge = verticalEdge === "top" ? "bottom" : "top";
    for (const elementStyle of [launcherStyle, panelStyle]) {
      expect(elementStyle[horizontalEdge]).toContain("--clickless-launcher-offset-x");
      expect(elementStyle[verticalEdge]).toContain("--clickless-launcher-offset-y");
      expect(elementStyle[otherHorizontalEdge]).toBe("");
      expect(elementStyle[otherVerticalEdge]).toBe("");
    }
    // The panel opens clear of the button, on the same side of it as the screen's middle.
    expect(panelStyle[verticalEdge]).toBe("calc(var(--clickless-launcher-offset-y, 16px) + 52px)");
    expect(panelStyle.width).toBe(PANEL_WIDTH);
    expect(panelStyle.maxHeight).toBe(PANEL_MAX_HEIGHT);
  });

  it.each(["bottom", "right-bottom", "middle", "constructor", null, 0, 7])(
    "falls back to the bottom-right corner for %j, which is not a corner",
    async (notACorner) => {
      const { launcherStyle, panelStyle } = await renderPanelAt({ position: notACorner as PromptPanelPosition });
      for (const elementStyle of [launcherStyle, panelStyle]) {
        expect(elementStyle.right).toContain("--clickless-launcher-offset-x");
        expect(elementStyle.bottom).toContain("--clickless-launcher-offset-y");
        expect(elementStyle.left).toBe("");
        expect(elementStyle.top).toBe("");
      }
    },
  );

  it("answers a prompt that came back with nothing to change and nothing said", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [], message: "" });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = renderResult.getByLabelText("Describe a change to this screen");

    fireEvent.change(promptInput, { target: { value: "reset the card colours" } });
    await act(async () => {
      fireEvent.keyDown(promptInput, { key: "Enter" });
    });
    await renderResult.findByText("I couldn't work out what to change. Could you say it another way?");
  });
});
