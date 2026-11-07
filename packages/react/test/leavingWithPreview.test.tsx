// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST } from "./dashboardWithFakeEngine";

afterEach(cleanup);

describe("closing or reloading the browser tab", () => {
  function tryToLeave(): boolean {
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    return !beforeUnload.defaultPrevented;
  }

  it("asks first only while a preview waits to be kept or discarded", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const sendPrompt = async () => {
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
        target: { value: "transactions first" },
      });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
      });
      await renderResult.findByText("Moved.");
    };
    const press = (buttonName: string) =>
      act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: buttonName }));
      });

    // Typed and not sent, nothing is lost on reloading that matters enough to ask.
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: "draft" } });
    expect(tryToLeave()).toBe(true);

    await sendPrompt();
    expect(tryToLeave()).toBe(false);
    await press("Discard");
    expect(tryToLeave()).toBe(true);

    await sendPrompt();
    expect(tryToLeave()).toBe(false);
    await press("Keep");
    await renderResult.findByText("Your change to this screen is saved.");
    expect(tryToLeave()).toBe(true);
  });

  it("does not ask once the bar is gone", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "transactions first" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    await renderResult.findByText("Moved.");
    expect(tryToLeave()).toBe(false);

    renderResult.unmount();
    expect(tryToLeave()).toBe(true);
  });

  it("keeps a change being saved when the tab is reloaded at once", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
    const saveRequests: RequestInit[] = [];
    const slowSaveEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) => {
          if (String(requestInput).endsWith("/revisions")) {
            saveRequests.push(requestInit!);
            await saveHeld;
          }
          return engine.engineOptions.fetch(requestInput, requestInit);
        }) as typeof fetch,
      },
    };
    const { renderResult, regionApi } = renderDashboardWithEngine(slowSaveEngine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "transactions first" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    await renderResult.findByText("Moved.");

    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    await waitFor(() => expect(saveRequests).toHaveLength(1));
    // The browser carries the save on if the page goes, and asks first while it can.
    expect(saveRequests[0]!.keepalive).toBe(true);
    expect(tryToLeave()).toBe(false);

    releaseSave();
    await renderResult.findByText("Your change to this screen is saved.");
    expect(tryToLeave()).toBe(true);
  });

  it("still saves a change too large for the browser to carry on after the page goes", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const saveRequests: RequestInit[] = [];
    const refusingEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) => {
          if (String(requestInput).endsWith("/revisions")) {
            saveRequests.push(requestInit!);
            // As a browser does when others under way already send as much as it allows.
            if (requestInit?.keepalive) throw new TypeError("Failed to fetch");
          }
          return engine.engineOptions.fetch(requestInput, requestInit);
        }) as typeof fetch,
      },
    };
    const { renderResult, regionApi, drawOrderOf } = renderDashboardWithEngine(refusingEngine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "transactions first" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    await renderResult.findByText("Moved.");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });

    await renderResult.findByText("Your change to this screen is saved.");
    expect(saveRequests.map((saveRequest) => saveRequest.keepalive ?? false)).toEqual([true, false]);
    expect(drawOrderOf("txns")).toBe("1");
  });
});
