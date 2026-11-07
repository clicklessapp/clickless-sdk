// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PromptBar, PromptPanel } from "../src/index";
import { useFocusAfterPromptAction } from "../src/components/focusAfterPromptAction";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST } from "./dashboardWithFakeEngine";

afterEach(cleanup);

describe("PromptBar", () => {
  async function typeAndSubmitPrompt(
    renderResult: ReturnType<typeof renderDashboardWithEngine>["renderResult"],
    promptText: string,
  ) {
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: promptText },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
  }

  it("plans a prompt, previews it, and saves it with the prompt on Keep", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Transactions now come before Revenue." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "  transactions first  ");
    await renderResult.findByText("Transactions now come before Revenue.");
    expect(engine.receivedCalls.at(-1)).toMatchObject({ endpointPath: "plan", requestBody: { prompt: "transactions first" } });
    expect(drawOrderOf("txns")).toBe("1");
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);

    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    await renderResult.findByText("Your change to this screen is saved.");
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "revisions").at(-1)).toMatchObject({
      requestBody: {
        operations: MOVE_TRANSACTIONS_FIRST,
        prompt: "transactions first",
        message: "Transactions now come before Revenue.",
        baseRevision: 0,
      },
    });
    expect(regionApi().layout!.order).toEqual(["balance", "txns", "revenue"]);
    expect(renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(renderResult.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("keeps the keyboard focus in the box when Keep, Undo or Discard leaves the bar", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = renderResult.getByLabelText("Describe a change to this screen");
    const pressWithKeyboard = async (buttonName: string) => {
      const button = renderResult.getByRole("button", { name: buttonName });
      button.focus();
      await act(async () => fireEvent.click(button));
    };

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    await pressWithKeyboard("Keep");
    await renderResult.findByText("Your change to this screen is saved.");
    expect(document.activeElement).toBe(promptInput);

    await pressWithKeyboard("Undo");
    await renderResult.findByText("Undone: “transactions first”.");
    expect(renderResult.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(document.activeElement).toBe(promptInput);

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    await pressWithKeyboard("Discard");
    expect(document.activeElement).toBe(promptInput);
  });

  it("does not pull the focus back to a button whose click changed nothing, once the user has moved on", async () => {
    let redraw!: () => void;
    function BarWithIdleButton() {
      const [, setDrawCount] = useState(0);
      redraw = () => setDrawCount((drawCount) => drawCount + 1);
      const promptInput = useRef<HTMLInputElement>(null);
      const thenKeepFocus = useFocusAfterPromptAction(promptInput, true);
      return (
        <>
          <input ref={promptInput} aria-label="Prompt" />
          <button type="button" onClick={thenKeepFocus(() => {})}>
            Nothing to do
          </button>
        </>
      );
    }
    const renderResult = render(<BarWithIdleButton />);
    const idleButton = renderResult.getByRole("button", { name: "Nothing to do" });
    idleButton.focus();
    fireEvent.click(idleButton);
    // The user clicks on the page itself, which takes the focus off the button.
    fireEvent.pointerDown(document.body);
    idleButton.blur();
    act(() => redraw());
    expect(document.activeElement).toBe(document.body);
  });

  it("never shows the engine's own error text to the user", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({
      error: [400, { code: "region_mismatch", message: "The manifest is for another region" }],
    });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    const alertElement = await renderResult.findByRole("alert");
    expect(alertElement.textContent).toBe("Something went wrong. Please try again.");
  });

  it("does not say Saved when the engine turns the preview down", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Transactions now come before Revenue." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Transactions now come before Revenue.");

    engine.failNextRequest(422, {
      code: "invalid_operations",
      errors: [{ index: 0, code: "unknown_component", message: "No component txns" }],
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    const alertElement = await renderResult.findByRole("alert");
    expect(alertElement.textContent).toBe("That change no longer fits this screen. Please try again.");
    expect(renderResult.queryByText("Your change to this screen is saved.")).toBeNull();
    // The preview is gone with it, since it could never be saved.
    expect(renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(drawOrderOf("txns")).toBe("2");
    expect(regionApi().revision).toBe(0);
  });

  it("empties the box once a request is sent, so what is typed next is a request of its own", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement;

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    expect(promptInput().value).toBe("");
    fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));
    expect(promptInput().value).toBe("");

    await typeAndSubmitPrompt(renderResult, "hide revenue");
    expect(engine.receivedCalls.at(-1)).toMatchObject({ endpointPath: "plan", requestBody: { prompt: "hide revenue" } });
  });

  it("puts a request back in the box when it could not be carried out", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ error: [503, { code: "planner_not_configured", message: "No model API key" }] });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByRole("alert");
    expect((renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement).value).toBe(
      "transactions first",
    );
  });

  it("discards a preview without saving", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));

    expect(drawOrderOf("txns")).toBe("2");
    expect(renderResult.queryByText("Moved.")).toBeNull();
    expect(engine.receivedCalls.some((receivedCall) => receivedCall.endpointPath === "revisions")).toBe(false);
  });

  it("tells the engine when the user discards what a prompt produced", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(engine.receivedCalls.at(-1)!.endpointPath).toBe("discards"));
    expect(engine.receivedCalls.at(-1)).toMatchObject({
      method: "POST",
      token: "Bearer signed-token",
      requestBody: {
        manifestVersion: "1",
        prompt: "transactions first",
        message: "Moved.",
        operations: MOVE_TRANSACTIONS_FIRST,
      },
    });
  });

  it("tells the engine once, as abandoned, when the page goes while a preview waits", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    renderResult.unmount();

    await waitFor(() => expect(engine.receivedCalls.at(-1)!.endpointPath).toBe("discards"));
    const discardCalls = engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards");
    expect(discardCalls).toHaveLength(1);
    expect(discardCalls[0]!.requestBody).toEqual({
      manifestVersion: "1",
      prompt: "transactions first",
      message: "Moved.",
      operations: MOVE_TRANSACTIONS_FIRST,
      outcome: "abandoned",
    });
  });

  it("reports nothing when a preview is kept, cancelled by the application, or not from a prompt", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const discardCalls = () => engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards");

    // Kept.
    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    await renderResult.findByText("Your change to this screen is saved.");

    // Previewed without a prompt, then discarded by the user.
    act(() => void regionApi().previewOperations([{ type: "hide", id: "revenue" }]));
    act(() => regionApi().discardPreview());

    // From a prompt, but taken down by the application itself.
    engine.setPlanReply({ operations: [{ type: "hide", id: "txns" }], message: "Hidden." });
    await typeAndSubmitPrompt(renderResult, "hide transactions");
    await renderResult.findByText("Hidden.");
    act(() => regionApi().cancelPreview());

    await act(async () => {});
    expect(discardCalls()).toEqual([]);
    expect(regionApi().preview).toBeNull();
  });

  it("plans a follow-up typed during a preview from that preview, and keeps both as one change", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [{ type: "resize", id: "revenue", w: 8 }], message: "Revenue is wider." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const planCalls = () => engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "plan");

    await typeAndSubmitPrompt(renderResult, "make revenue wider");
    await renderResult.findByText("Revenue is wider.");
    expect(planCalls()[0]!.requestBody.preview).toBeUndefined();

    engine.setPlanReply({ operations: [{ type: "resize", id: "revenue", w: 10 }], message: "Revenue is wider again." });
    await typeAndSubmitPrompt(renderResult, "wider again");
    await renderResult.findByText("Revenue is wider again.");
    // The planner is told what the user is looking at, so "again" starts from there.
    expect(planCalls()[1]!.requestBody.preview).toEqual({
      operations: [{ type: "resize", id: "revenue", w: 8 }],
      baseRevision: 0,
    });
    expect(regionApi().preview!.items.revenue!.w).toBe(10);
    expect(regionApi().layout!.items.revenue!.w).toBe(6);
    // Building on a preview is not turning it down.
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards")).toEqual([]);

    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    await renderResult.findByText("Your change to this screen is saved.");
    const revisionCalls = engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "revisions");
    expect(revisionCalls).toHaveLength(1);
    expect(revisionCalls[0]!.requestBody).toMatchObject({
      operations: [
        { type: "resize", id: "revenue", w: 8 },
        { type: "resize", id: "revenue", w: 10 },
      ],
      prompt: "make revenue wider\nwider again",
      message: "Revenue is wider. Revenue is wider again.",
    });
    expect(regionApi().layout!.items.revenue!.w).toBe(10);
    expect(regionApi().preview).toBeNull();
  });

  it("leaves the preview as it is when a follow-up changes nothing, and discards the whole of it as one change", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const discardCalls = () => engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards");

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    engine.setPlanReply({ operations: [{ type: "hide", id: "revenue" }], message: "Hidden." });
    await typeAndSubmitPrompt(renderResult, "and hide revenue");
    await renderResult.findByText("Hidden.");
    engine.setPlanReply({ operations: [], message: "Transactions now comes first, and Revenue is hidden." });
    await typeAndSubmitPrompt(renderResult, "what did you change?");
    await renderResult.findByText("Transactions now comes first, and Revenue is hidden.");

    expect(drawOrderOf("txns")).toBe("1");
    expect(regionApi().preview!.items.revenue!.hidden).toBe(true);
    expect(renderResult.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(discardCalls()).toEqual([]);

    act(() => fireEvent.click(renderResult.getByRole("button", { name: "Discard" })));
    await waitFor(() => expect(discardCalls()).toHaveLength(1));
    expect(discardCalls()[0]!.requestBody).toMatchObject({
      prompt: "transactions first\nand hide revenue",
      message: "Moved. Hidden.",
      operations: [...MOVE_TRANSACTIONS_FIRST, { type: "hide", id: "revenue" }],
    });
    // Back to the saved layout, as it was before the first of them.
    expect(drawOrderOf("txns")).toBe("2");
    expect(regionApi().layout!.items.revenue!.hidden).toBe(false);
  });

  it("takes the preview off, as turned down, when a follow-up takes all of it back", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    engine.setPlanReply({
      operations: [{ type: "move", id: "txns", position: "after", targetId: "revenue" }],
      message: "Transactions is back after Revenue.",
    });
    await typeAndSubmitPrompt(renderResult, "no, put it back");
    await renderResult.findByText("Transactions is back after Revenue.");

    expect(regionApi().preview).toBeNull();
    expect(drawOrderOf("txns")).toBe("2");
    expect(renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    const discardCalls = engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards");
    expect(discardCalls).toHaveLength(1);
    expect(discardCalls[0]!.requestBody).toMatchObject({ prompt: "transactions first\nno, put it back" });
  });

  it("says so plainly, and shows the saved screen, when a follow-up comes after the screen changed elsewhere", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");

    // In another tab, the user hid Revenue.
    engine.regionState.layout = {
      ...regionApi().layout!,
      items: { ...regionApi().layout!.items, revenue: { ...regionApi().layout!.items.revenue!, hidden: true } },
    };
    engine.regionState.revision = 1;
    engine.setPlanReply({ operations: [{ type: "hide", id: "txns" }], message: "Transactions is hidden." });
    await typeAndSubmitPrompt(renderResult, "and hide transactions");

    await renderResult.findByText("This screen was changed somewhere else. It has been refreshed, so please try again.");
    expect(regionApi().preview).toBeNull();
    expect(drawOrderOf("txns")).toBe("2");
    expect(regionApi().layout!.items.revenue!.hidden).toBe(true);
    // The request is still there to send again, now planned from the saved screen.
    expect((renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement).value).toBe(
      "and hide transactions",
    );
    await typeAndSubmitPrompt(renderResult, "and hide transactions");
    await renderResult.findByText("Transactions is hidden.");
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "plan").at(-1)!.requestBody.preview).toBeUndefined();
  });

  it("leaves the preview in place when asking for something else gets no answer", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");

    engine.setPlanReply({
      error: [503, { code: "planner_unavailable", message: "The model could not be reached" }],
    });
    await typeAndSubmitPrompt(renderResult, "something else");
    await renderResult.findByRole("alert");
    // Nothing was said about the screen, so the preview is still there to keep,
    // and it was not turned down.
    expect(drawOrderOf("txns")).toBe("1");
    expect(renderResult.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards")).toEqual([]);
  });

  it("plans a prompt from a preview the application made itself, and records nothing about it when the answer changes nothing", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [], message: "Nothing needs to change." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    act(() => void regionApi().previewOperations(MOVE_TRANSACTIONS_FIRST));
    expect(drawOrderOf("txns")).toBe("1");

    await typeAndSubmitPrompt(renderResult, "is anything hidden?");
    await renderResult.findByText("Nothing needs to change.");
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "plan").at(-1)!.requestBody.preview).toEqual({
      operations: MOVE_TRANSACTIONS_FIRST,
      baseRevision: 0,
    });
    expect(drawOrderOf("txns")).toBe("1");
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards")).toEqual([]);
  });

  it("does not report a preview as discarded while it is being saved", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");

    // A bar of the host's own might leave Discard usable while Keep is at work.
    await act(async () => {
      const savePromise = regionApi().commitPreview();
      regionApi().discardPreview();
      await savePromise;
    });
    expect(engine.receivedCalls.filter((receivedCall) => receivedCall.endpointPath === "discards")).toEqual([]);
    expect(regionApi().revision).toBe(1);
  });

  it("discards the preview even when the engine cannot be told", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, drawOrderOf, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByText("Moved.");
    engine.failNextRequest(500, { code: "error", message: "database is down" });
    fireEvent.click(renderResult.getByRole("button", { name: "Discard" }));
    await act(async () => {});

    expect(drawOrderOf("txns")).toBe("2");
    expect(renderResult.queryByRole("alert")).toBeNull();
  });

  it("shows the request and a sign of work as soon as it is sent, until the answer comes", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const releasePlan = engine.holdNextPlan();

    await typeAndSubmitPrompt(renderResult, "transactions first");
    expect(renderResult.getByText("Working on it…", { exact: false })).toBeTruthy();
    expect(renderResult.getByText("“transactions first”")).toBeTruthy();

    await act(async () => releasePlan());
    await renderResult.findByText("Moved.");
    expect(renderResult.queryByText("Working on it…", { exact: false })).toBeNull();
  });

  it("puts a request that failed back in the box, with no sign of work left", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    engine.failNextRequest(500, { code: "error", message: "database is down" });

    await typeAndSubmitPrompt(renderResult, "transactions first");
    await renderResult.findByRole("alert");
    expect(renderResult.queryByText("Working on it…", { exact: false })).toBeNull();
    expect((renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement).value).toBe("transactions first");
  });

  it("in the panel, scrolls the request just sent and its sign of work into view", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const releasePlan = engine.holdNextPlan();
    // jsdom lays nothing out, so the conversation is given a height to scroll to.
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
    try {
      await typeAndSubmitPrompt(renderResult, "transactions first");
      const working = renderResult.container.querySelector('[data-clickless-bubble="working"]')!;
      const conversation = working.parentElement!.parentElement!;
      expect(conversation.scrollTop).toBe(900);
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      await act(async () => releasePlan());
    }
  });

  it("in the panel, shows the request as the user's message at once, then its answer under it", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const releasePlan = engine.holdNextPlan();
    const userBubbles = () => renderResult.container.querySelectorAll('[data-clickless-bubble="user"]');

    await typeAndSubmitPrompt(renderResult, "transactions first");
    expect([...userBubbles()].map((bubble) => bubble.textContent)).toEqual(["transactions first"]);
    expect(renderResult.container.querySelector('[data-clickless-bubble="working"]')).not.toBeNull();

    await act(async () => releasePlan());
    await renderResult.findByText("Moved.");
    expect([...userBubbles()].map((bubble) => bubble.textContent)).toEqual(["transactions first"]);
    expect(renderResult.container.querySelector('[data-clickless-bubble="working"]')).toBeNull();
  });

  it("shows the model's explanation when nothing can be changed", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [], message: "The account balance is locked." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "hide my balance");
    await renderResult.findByText("The account balance is locked.");
    expect(renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(regionApi().preview).toBeNull();
  });

  it("explains when planning is unavailable", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ error: [503, { code: "planner_not_configured", message: "No model API key" }] });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "transactions first");
    const alertElement = await renderResult.findByRole("alert");
    expect(alertElement.textContent).toBe(
      "Changes can't be made by typing right now. Please try again in a little while.",
    );
  });

  it("says something plain when a prompt comes back with nothing to change and nothing said", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [], message: " " });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    await typeAndSubmitPrompt(renderResult, "reset the card colours");
    await renderResult.findByText("I couldn't work out what to change. Could you say it another way?");
  });
});
