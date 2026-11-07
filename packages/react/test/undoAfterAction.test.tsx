// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionError,
  Adaptive,
  AdaptiveProvider,
  AdaptiveRegion,
  PromptPanel,
  useAdaptiveAction,
  useAdaptiveRegion,
  usePromptBar,
  type ActionArguments,
} from "../src/index";
import { createFakeEngine, MOVE_TRANSACTIONS_FIRST, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(cleanup);

type Page = "dashboard" | "orders";

/**
 * An application with a dashboard and an orders page, which offers to switch
 * its theme (a change to data, confirmed first) and to open a page (which only
 * changes what is shown, and runs at once).
 */
function renderAppWithActions(
  engine: ReturnType<typeof createFakeEngine>,
  {
    switchTheme = () => "Dark mode is on.",
    promptControl = (page) => <PromptPanel regionId={page} defaultOpen dictation={false} />,
  }: {
    switchTheme?: (actionArguments: ActionArguments) => unknown;
    promptControl?: (page: Page) => ReactNode;
  } = {},
) {
  let regionApiValue!: RegionApi;
  function Dashboard() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return (
      <AdaptiveRegion id="dashboard" version="1">
        <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
          revenue
        </Adaptive>
        <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
          txns
        </Adaptive>
      </AdaptiveRegion>
    );
  }
  function App() {
    const [page, setPage] = useState<Page>("dashboard");
    useAdaptiveAction({
      name: "switchTheme",
      title: "Switch theme",
      parameters: { theme: { type: "text", values: ["light", "dark"], description: "Theme" } },
      run: switchTheme,
    });
    useAdaptiveAction({
      name: "openPage",
      title: "Open a page",
      mode: "read",
      parameters: { page: { type: "text", values: ["dashboard", "orders"], description: "Page" } },
      run: ({ page: pageToOpen }) => setPage(pageToOpen as Page),
    });
    return (
      <>
        {page === "dashboard" ? (
          <Dashboard />
        ) : (
          <AdaptiveRegion id="orders" version="1">
            <Adaptive id="orderList" title="Orders" defaults={{ w: 12, h: 4 }}>
              orders
            </Adaptive>
          </AdaptiveRegion>
        )}
        {promptControl(page)}
      </>
    );
  }
  const renderResult = render(
    <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
      <App />
    </AdaptiveProvider>,
  );
  const sendRequest = async (request: string, replyFromPlanner: Parameters<typeof engine.setPlanAcrossRegionsReply>[0]) => {
    engine.setPlanAcrossRegionsReply(replyFromPlanner);
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: request } });
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Send" })));
  };
  const pressButton = async (buttonName: string) => {
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: buttonName })));
  };
  const keepHidingRevenue = async () => {
    await sendRequest("hide revenue", {
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
      message: "Revenue is hidden.",
    });
    await pressButton("Keep");
    await renderResult.findByText("Your change to this screen is saved.");
  };
  const switchToDarkMode = async () => {
    await sendRequest("switch to dark mode", {
      changes: [],
      actionCalls: [{ name: "switchTheme", arguments: { theme: "dark" } }],
      message: "I'll switch to dark mode.",
    });
    await pressButton("Confirm");
  };
  const openPage = (page: Page) =>
    sendRequest(`open ${page}`, {
      changes: [],
      actionCalls: [{ name: "openPage", arguments: { page } }],
      message: `Opening ${page}.`,
    });
  const isHidden = (componentId: string) =>
    renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!.style.display === "none";
  const undoCalls = () => engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "undo");
  return {
    renderResult,
    regionApi: () => regionApiValue,
    sendRequest,
    pressButton,
    keepHidingRevenue,
    switchToDarkMode,
    openPage,
    isHidden,
    undoCalls,
  };
}

/** A prompt box an application builds itself from `usePromptBar`. */
function OwnPromptBox({ page }: { page: Page }) {
  const promptBar = usePromptBar(page);
  return (
    <>
      <textarea
        aria-label="Describe a change to this screen"
        value={promptBar.prompt}
        onChange={(event) => promptBar.setPrompt(event.target.value)}
      />
      <button type="button" onClick={() => promptBar.submitPrompt()}>
        Send
      </button>
      <button type="button" onClick={promptBar.keepPreview}>
        Keep
      </button>
      <button type="button" onClick={promptBar.confirmActionCalls}>
        Confirm
      </button>
      <button type="button" onClick={promptBar.undoLastChange}>
        Undo
      </button>
      <button type="button" onClick={() => void promptBar.restoreRevision(0)}>
        Restore the original
      </button>
      <p data-testid="can-undo">{String(promptBar.canUndo)}</p>
      <p>{promptBar.message?.text}</p>
    </>
  );
}

describe("Undo after an action", () => {
  it("names the request it takes back when a change to the screen was the last thing done", async () => {
    const engine = createFakeEngine();
    const app = renderAppWithActions(engine);
    await waitFor(() => expect(app.regionApi().loading).toBe(false));

    await app.keepHidingRevenue();
    await app.pressButton("Undo");

    await app.renderResult.findByText("Undone: “hide revenue”.");
    expect(app.isHidden("revenue")).toBe(false);
    expect(app.undoCalls()).toHaveLength(1);
  });

  it("is not offered once an action has run, so an older change is not taken back in its place", async () => {
    const engine = createFakeEngine();
    const switchTheme = vi.fn(() => "Dark mode is on.");
    const app = renderAppWithActions(engine, { switchTheme });
    await waitFor(() => expect(app.regionApi().loading).toBe(false));
    await app.keepHidingRevenue();
    expect(app.renderResult.getByRole("button", { name: "Undo" })).toBeTruthy();

    await app.switchToDarkMode();

    await app.renderResult.findByText("Dark mode is on.");
    expect(switchTheme).toHaveBeenCalledWith({ theme: "dark" });
    expect(app.renderResult.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(app.isHidden("revenue")).toBe(true);
    expect(app.undoCalls()).toHaveLength(0);
  });

  it("is offered again for a change made after the action, and only for that one", async () => {
    const engine = createFakeEngine();
    const app = renderAppWithActions(engine);
    await waitFor(() => expect(app.regionApi().loading).toBe(false));
    await app.keepHidingRevenue();
    await app.switchToDarkMode();
    await app.renderResult.findByText("Dark mode is on.");

    // With the application's own controls, which the history knows by what they changed.
    await act(() => app.regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST));
    await app.pressButton("Undo");

    await app.renderResult.findByText("Undone: changed Transactions.");
    expect(app.regionApi().layout!.order).toEqual(["revenue", "txns"]);
    // The next undo would reach back past the action, to hiding Revenue.
    await waitFor(() => expect(app.renderResult.queryByRole("button", { name: "Undo" })).toBeNull());
    expect(app.isHidden("revenue")).toBe(true);
  });

  it("is not offered after an action that only changed what is shown, back on the page it changed", async () => {
    const engine = createFakeEngine();
    const app = renderAppWithActions(engine);
    await waitFor(() => expect(app.regionApi().loading).toBe(false));
    await app.keepHidingRevenue();

    await app.openPage("orders");
    await app.renderResult.findByText("orders");
    await app.openPage("dashboard");
    await waitFor(() => expect(app.regionApi().loading).toBe(false));

    expect(app.renderResult.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(app.isHidden("revenue")).toBe(true);
  });

  it("is still offered when the action failed, since it changed nothing", async () => {
    const engine = createFakeEngine();
    const app = renderAppWithActions(engine, {
      switchTheme: () => {
        throw new ActionError("The theme couldn't be changed just now.");
      },
    });
    await waitFor(() => expect(app.regionApi().loading).toBe(false));
    await app.keepHidingRevenue();

    await app.switchToDarkMode();
    await app.renderResult.findByText("The theme couldn't be changed just now.");
    await app.pressButton("Undo");

    await app.renderResult.findByText("Undone: “hide revenue”.");
  });

  it("tells a prompt box of the application's own why nothing was undone", async () => {
    const engine = createFakeEngine();
    const app = renderAppWithActions(engine, { promptControl: (page) => <OwnPromptBox page={page} /> });
    await waitFor(() => expect(app.regionApi().loading).toBe(false));
    await app.keepHidingRevenue();
    expect(app.renderResult.getByTestId("can-undo").textContent).toBe("true");

    await app.switchToDarkMode();
    await waitFor(() => expect(app.renderResult.getByTestId("can-undo").textContent).toBe("false"));
    await app.pressButton("Undo");

    await app.renderResult.findByText(
      "There's no change to undo since your last request. To reverse what it did, ask for that instead.",
    );
    expect(app.undoCalls()).toHaveLength(0);
    expect(app.isHidden("revenue")).toBe(true);
  });

  it("says it took back going to an earlier version, when that was the last change", async () => {
    const engine = createFakeEngine();
    const app = renderAppWithActions(engine, { promptControl: (page) => <OwnPromptBox page={page} /> });
    await waitFor(() => expect(app.regionApi().loading).toBe(false));
    await app.keepHidingRevenue();
    await app.pressButton("Restore the original");
    await app.renderResult.findByText("Back to how this page started.");
    expect(app.isHidden("revenue")).toBe(false);

    await app.pressButton("Undo");

    await app.renderResult.findByText("Undone: going back to an earlier version of this screen.");
    expect(app.isHidden("revenue")).toBe(true);
  });
});
