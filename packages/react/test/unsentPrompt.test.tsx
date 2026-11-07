// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptBar, PromptPanel } from "../src/index";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST } from "./dashboardWithFakeEngine";

afterEach(cleanup);

type Page = "dashboard" | "reports";

/** An application with two pages, each a region with a prompt panel of its own, and links between them. */
function renderTwoPages(engine: ReturnType<typeof createFakeEngine>) {
  function Application() {
    const [openPage, setOpenPage] = useState<Page>("dashboard");
    return (
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <button type="button" onClick={() => setOpenPage("dashboard")}>
          Go to dashboard
        </button>
        <button type="button" onClick={() => setOpenPage("reports")}>
          Go to reports
        </button>
        <PromptPanel key={openPage} regionId={openPage} defaultOpen />
        <AdaptiveRegion key={`${openPage}-region`} id={openPage} version="1">
          <Adaptive id="first" title="First" defaults={{ w: 6, h: 3 }}>
            first
          </Adaptive>
          <Adaptive id="second" title="Second" defaults={{ w: 6, h: 3 }}>
            second
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>
    );
  }
  const renderResult = render(<Application />);
  const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
  return {
    renderResult,
    promptInput,
    type: (promptText: string) => fireEvent.change(promptInput(), { target: { value: promptText } }),
    goTo: (page: Page) =>
      act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: `Go to ${page}` }));
      }),
    pressButton: (buttonName: string) =>
      act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: buttonName }));
      }),
  };
}

describe("a prompt typed and not sent", () => {
  it("is there again on coming back to the page it was typed on, and only there", async () => {
    const twoPages = renderTwoPages(createFakeEngine());
    twoPages.type("put the second one first");

    await twoPages.goTo("reports");
    expect(twoPages.promptInput().value).toBe("");
    twoPages.type("hide the first one");

    await twoPages.goTo("dashboard");
    expect(twoPages.promptInput().value).toBe("put the second one first");
    await twoPages.goTo("reports");
    expect(twoPages.promptInput().value).toBe("hide the first one");
  });

  it("is not brought back once it was sent and answered", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [], message: "Which one do you mean?" });
    engine.setPlanReply({ operations: [], message: "Which one do you mean?" });
    const twoPages = renderTwoPages(engine);
    await waitFor(() => expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "layout")).toBe(true));
    twoPages.type("make it bigger");
    await twoPages.pressButton("Preview");
    await twoPages.renderResult.findByText("Which one do you mean?");
    expect(twoPages.promptInput().value).toBe("");

    await twoPages.goTo("reports");
    await twoPages.goTo("dashboard");
    expect(twoPages.promptInput().value).toBe("");
  });

  it("is not brought back after leaving a preview by going to another page", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: [{ type: "move", id: "second", position: "before", targetId: "first" }], message: "Moved." });
    const twoPages = renderTwoPages(engine);
    await waitFor(() => expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "layout")).toBe(true));
    twoPages.type("put the second one first");
    await twoPages.pressButton("Preview");
    await twoPages.renderResult.findByText("Moved.");

    await twoPages.goTo("reports");
    await twoPages.goTo("dashboard");
    expect(twoPages.renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
    // It was sent, so what is typed on coming back is a request of its own.
    expect(twoPages.promptInput().value).toBe("");
  });

  it("is the same in two bars for the same regions", () => {
    const engine = createFakeEngine();
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <PromptBar regionId="dashboard" />
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    const [firstInput, secondInput] = renderResult.getAllByLabelText("Describe a change to this screen") as HTMLInputElement[];
    fireEvent.change(firstInput!, { target: { value: "hide revenue" } });
    expect(secondInput!.value).toBe("hide revenue");
  });

  it("follows a bar that is pointed at other regions, and comes back with it", async () => {
    const engine = createFakeEngine();
    function Screen({ barFor }: { barFor: string | string[] }) {
      return (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <PromptBar regionId={barFor} />
        </AdaptiveProvider>
      );
    }
    const renderResult = render(<Screen barFor="dashboard" />);
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement;
    fireEvent.change(promptInput(), { target: { value: "for the dashboard" } });

    // The same page with its sidebar is another set of regions, with its own draft.
    renderResult.rerender(<Screen barFor={["dashboard", "sidebar"]} />);
    expect(promptInput().value).toBe("");
    fireEvent.change(promptInput(), { target: { value: "for the dashboard and sidebar" } });

    renderResult.rerender(<Screen barFor="dashboard" />);
    expect(promptInput().value).toBe("for the dashboard");
    renderResult.rerender(<Screen barFor={["dashboard", "sidebar"]} />);
    expect(promptInput().value).toBe("for the dashboard and sidebar");
  });
});

describe("a request whose preview could not be saved because the screen changed elsewhere", () => {
  async function previewThenKeepAfterConflict(typeWhilePreviewing: string) {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement;
    fireEvent.change(promptInput(), { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    await renderResult.findByText("Moved.");
    fireEvent.change(promptInput(), { target: { value: typeWhilePreviewing } });

    engine.failNextRequest(409, { code: "conflict", message: "The layout changed since it was last read" });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Keep" }));
    });
    await renderResult.findByText("This screen was changed somewhere else. It has been refreshed, so please try again.");
    expect(regionApi().preview).toBeNull();
    return promptInput().value;
  }

  it("is put back in an empty box, ready to send again", async () => {
    expect(await previewThenKeepAfterConflict("")).toBe("transactions first");
  });

  it("leaves what the user typed since in its place", async () => {
    expect(await previewThenKeepAfterConflict("hide revenue")).toBe("hide revenue");
  });
});
