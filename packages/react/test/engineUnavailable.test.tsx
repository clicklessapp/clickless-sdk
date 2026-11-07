// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Layout, PropValue } from "@clickless/core";
import {
  Adaptive,
  AdaptiveProvider,
  AdaptiveRegion,
  PromptBar,
  PromptPanel,
  propPresets,
  useAdaptiveRegion,
  type EngineError,
} from "../src/index";
import { createFakeEngine, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Outage = "unreachable" | "slow" | "server_error" | "internal_error" | "token" | null;

/** The stand-in engine, behind a connection that can be made to fail in each way it does for real. */
function createEngineWithOutage(outage: Outage = null) {
  const engine = createFakeEngine();
  let currentOutage = outage;
  let heldRequest: Promise<void> | null = null;
  const engineOptions = {
    url: engine.engineOptions.url,
    getToken: async () => {
      if (currentOutage === "token") throw new Error("the host's sign-in service is down");
      return "signed-token";
    },
    fetch: (async (requestInput, requestInit) => {
      if (heldRequest) {
        const heldRequestRelease = heldRequest;
        heldRequest = null;
        await heldRequestRelease;
      }
      if (currentOutage === "unreachable") throw new TypeError("Failed to fetch");
      if (currentOutage === "server_error") return new Response("Bad gateway", { status: 502 });
      if (currentOutage === "internal_error") return new Response("Internal server error", { status: 500 });
      if (currentOutage === "slow") {
        return new Promise<Response>((_resolve, reject) => {
          requestInit!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return engine.engineOptions.fetch(requestInput, requestInit);
    }) as typeof fetch,
  };
  return {
    engine,
    engineOptions,
    setOutage: (nextOutage: Outage) => (currentOutage = nextOutage),
    /** Holds the next request until the returned function is called. */
    holdNextRequest: () => {
      let releaseHeldRequest!: () => void;
      heldRequest = new Promise((resolve) => (releaseHeldRequest = resolve));
      return releaseHeldRequest;
    },
    /** What the engine holds for the tasks region. */
    savedTasksState: () => engine.savedStateOf("tasks"),
  };
}

const ALL_COLUMNS = ["title", "status", "priority"];

/** A page whose table has a column menu of its own, routed through `adaptiveControls.setProp` as shadcn-admin's is. */
function renderTasksPage(
  engineOptions: ReturnType<typeof createEngineWithOutage>["engineOptions"],
  {
    promptControl = <PromptPanel regionId="tasks" defaultOpen dictation={false} />,
    withSidebar = false,
    onLayoutChange,
  }: { promptControl?: ReactNode; withSidebar?: boolean; onLayoutChange?: (layout: Layout) => void } = {},
) {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("tasks");
    return null;
  }
  const renderResult = render(
    <AdaptiveProvider userId="user-1" engine={engineOptions}>
      <RegionApiProbe />
      <AdaptiveRegion id="tasks" version="1" {...(onLayoutChange && { onLayoutChange })}>
        <Adaptive
          id="table"
          title="Tasks"
          defaults={{ w: 12, h: 4 }}
          presets={{
            columns: propPresets.visibleList({ values: ALL_COLUMNS, min: 1, means: "the columns that show" }),
            density: propPresets.density(),
          }}
        >
          {(props, adaptiveControls) => (
            <TasksTable
              shownColumns={props.columns as string[]}
              density={props.density}
              // As an application writes it: nothing waits on the promise or catches it.
              onShownColumnsChange={(nextShownColumns) =>
                void adaptiveControls.setProp("columns", nextShownColumns)
              }
            />
          )}
        </Adaptive>
      </AdaptiveRegion>
      {withSidebar && (
        <AdaptiveRegion id="sidebar" version="1">
          <Adaptive id="links" title="Links" defaults={{ w: 12, h: 1 }}>
            links
          </Adaptive>
          {/* A region always keeps something showing, so Links can be hidden. */}
          <Adaptive id="help" title="Help" defaults={{ w: 12, h: 1 }}>
            help
          </Adaptive>
        </AdaptiveRegion>
      )}
      {promptControl}
    </AdaptiveProvider>,
  );
  const columnBox = (column: string) => renderResult.getByRole("checkbox", { name: column }) as HTMLInputElement;
  const shownHeadings = () =>
    [...renderResult.container.querySelectorAll("th")].map((headingCell) => headingCell.textContent);
  return { renderResult, columnBox, shownHeadings, regionApi: () => regionApiValue };
}

function TasksTable({
  shownColumns,
  density,
  onShownColumnsChange,
}: {
  shownColumns: string[];
  density: PropValue | undefined;
  onShownColumnsChange: (nextShownColumns: string[]) => void;
}) {
  return (
    <div data-density={String(density)}>
      <fieldset>
        {ALL_COLUMNS.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              checked={shownColumns.includes(column)}
              onChange={(event) =>
                onShownColumnsChange(
                  event.target.checked
                    ? ALL_COLUMNS.filter(
                        (candidateColumn) => candidateColumn === column || shownColumns.includes(candidateColumn),
                      )
                    : shownColumns.filter((candidateColumn) => candidateColumn !== column),
                )
              }
            />
            {column}
          </label>
        ))}
      </fieldset>
      <table>
        <thead>
          <tr>
            {shownColumns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
      </table>
    </div>
  );
}

const UNAVAILABLE_WITH_CHANGES =
  "Personalising isn't available right now. Your changes still work while you're here, and will be saved when it's back, unless they clash with changes you saved before.";

function launcherButtonOf(renderResult: ReturnType<typeof render>) {
  return renderResult.getByRole("button", { name: /^(Close|Ask ClickLess)$/ });
}

describe.each([
  ["cannot be reached", "unreachable"],
  ["answers through a gateway that fails (502)", "server_error"],
  ["answers with an internal server error (500)", "internal_error"],
  ["cannot be given a token by the host", "token"],
] as const)("when the engine %s", (_description, outage) => {
  it("shows the default view, lets the page's own controls work, and saves their changes once it is back", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage(outage);
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);

    // The page is drawn at once, as the application draws it without ClickLess.
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));
    expect(shownHeadings()).toEqual(ALL_COLUMNS);

    fireEvent.click(columnBox("status"));
    // At once, without waiting on the engine.
    expect(shownHeadings()).toEqual(["title", "priority"]);
    expect(columnBox("status").checked).toBe(false);
    await renderResult.findByText(UNAVAILABLE_WITH_CHANGES);
    expect(launcherButtonOf(renderResult).hasAttribute("data-clickless-unavailable")).toBe(true);
    expect(regionApi().hasUnsavedChanges).toBe(true);
    expect(savedTasksState().revision).toBe(0);

    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title", "priority"]);
    expect(savedTasksState().revision).toBe(1);
    expect(shownHeadings()).toEqual(["title", "priority"]);
    expect(regionApi().loadFailed).toBe(false);
    expect(launcherButtonOf(renderResult).hasAttribute("data-clickless-unavailable")).toBe(false);
    expect(renderResult.queryByText(UNAVAILABLE_WITH_CHANGES)).toBeNull();
  });

  it("keeps a change made after the page loaded, and saves it once the engine is back", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage();
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    setOutage(outage);
    fireEvent.click(columnBox("status"));
    expect(shownHeadings()).toEqual(["title", "priority"]);
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(true));

    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title", "priority"]);
  });

  it("tells the user plainly that prompts cannot be carried out, and leaves the page as it is", async () => {
    const { engineOptions } = createEngineWithOutage(outage);
    const { renderResult, shownHeadings, regionApi } = renderTasksPage(engineOptions, {
      promptControl: <PromptBar regionId="tasks" />,
    });
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));
    await renderResult.findByText(
      "Personalising isn't available right now, so this screen may not show your saved changes. Everything on it still works.",
    );

    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "hide the status column" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    const alertElement = await renderResult.findByRole("alert");
    expect(alertElement.textContent).toBe("Personalising isn't available right now. Please try again in a little while.");
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
  });
});

describe("when the engine is slow", () => {
  it("does not hold up the page or its controls, and gives up after the time limit", async () => {
    vi.useFakeTimers();
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("slow");
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    expect(shownHeadings()).toEqual(ALL_COLUMNS);

    // While the saved layout is still on its way.
    fireEvent.click(columnBox("status"));
    expect(shownHeadings()).toEqual(["title", "priority"]);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(regionApi().loadFailed).toBe(true);
    expect(renderResult.getByText(UNAVAILABLE_WITH_CHANGES)).toBeTruthy();
    expect(shownHeadings()).toEqual(["title", "priority"]);

    // The panel's button is dimmed, and a prompt is answered plainly once it too runs out of time.
    expect(launcherButtonOf(renderResult).hasAttribute("data-clickless-unavailable")).toBe(true);
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "hide the priority column" },
    });
    fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    await act(() => vi.advanceTimersByTimeAsync(150_000));
    expect(renderResult.getByRole("alert").textContent).toBe(
      "Personalising isn't available right now. Please try again in a little while.",
    );
    expect(shownHeadings()).toEqual(["title", "priority"]);

    // Tried again by itself: the attempt already under way runs out its time,
    // and the next one, a little later, finds the engine back.
    setOutage(null);
    await act(() => vi.advanceTimersByTimeAsync(200_000));
    expect(regionApi().hasUnsavedChanges).toBe(false);
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title", "priority"]);
  });
});

describe("changes kept while the engine cannot be reached", () => {
  it("can be undone within the visit, and only what is left is saved", async () => {
    const { engineOptions, setOutage, savedTasksState, engine } = createEngineWithOutage("unreachable");
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));

    fireEvent.click(columnBox("status"));
    fireEvent.click(columnBox("priority"));
    expect(shownHeadings()).toEqual(["title"]);

    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    expect(shownHeadings()).toEqual(["title", "priority"]);
    // Taken back on this screen alone, and still said in words.
    expect(renderResult.getByText("Undone: changed Tasks.")).toBeTruthy();
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
    expect(regionApi().canUndo).toBe(false);
    expect(renderResult.queryByRole("button", { name: "Undo" })).toBeNull();

    fireEvent.click(columnBox("priority"));
    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title", "status"]);
    expect(engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "revisions")).toHaveLength(1);
  });

  it("are undone across the regions one panel speaks for", async () => {
    const { engineOptions } = createEngineWithOutage("unreachable");
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions, {
      promptControl: <PromptPanel regionId={["tasks", "sidebar"]} defaultOpen dictation={false} />,
      withSidebar: true,
    });
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));

    fireEvent.click(columnBox("status"));
    fireEvent.click(await renderResult.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(shownHeadings()).toEqual(ALL_COLUMNS));
  });

  it("never overwrite a saved setting they were not made on, and stay on screen for the visit", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    // The user had hidden "priority" and chosen the compact table on an earlier visit.
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "tasks",
      manifestVersion: "1",
      order: ["table"],
      items: {
        table: { w: 12, h: 4, hidden: false, props: { columns: ["title", "status"], density: "compact" } },
      },
    };
    Object.assign(savedTasksState(), { revision: 3, layout: savedLayout });
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));

    // Made on the default view: worked out from columns the user had not chosen.
    fireEvent.click(columnBox("status"));
    expect(shownHeadings()).toEqual(["title", "priority"]);

    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApi().loadFailed).toBe(false));
    // What they chose stays on screen, over the rest of their saved layout...
    expect(shownHeadings()).toEqual(["title", "priority"]);
    expect(renderResult.container.querySelector("[data-density]")!.getAttribute("data-density")).toBe("compact");
    // ...but their saved columns are kept as they were, for the next visit.
    expect(savedTasksState().revision).toBe(3);
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title", "status"]);
    expect(regionApi().hasUnsavedChanges).toBe(false);
  });

  it("kept for the visit, give way to the next change that is saved", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "tasks",
      manifestVersion: "1",
      order: ["table"],
      items: { table: { w: 12, h: 4, hidden: false, props: { columns: ["title", "status"], density: "compact" } } },
    };
    Object.assign(savedTasksState(), { revision: 3, layout: savedLayout });
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));
    fireEvent.click(columnBox("status"));
    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApi().loadFailed).toBe(false));
    expect(shownHeadings()).toEqual(["title", "priority"]);

    // A prompt's change to the same setting is saved, and is what the screen shows.
    await act(async () => {
      await regionApi().applyOperations(
        [{ type: "setProp", id: "table", prop: "columns", value: ALL_COLUMNS }],
        "show every column",
      );
    });
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(ALL_COLUMNS);
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
    // And Undo takes back that saved change, not the older one kept for the visit.
    await act(() => regionApi().undoLastChange());
    expect(shownHeadings()).toEqual(["title", "status"]);
  });

  it("kept for the visit, give way to a prompt saved in another region of the same panel", async () => {
    const { engineOptions, engine } = createEngineWithOutage();
    const reportedLayouts: Layout[] = [];
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions, {
      promptControl: <PromptPanel regionId={["tasks", "sidebar"]} defaultOpen dictation={false} />,
      withSidebar: true,
      onLayoutChange: (layout) => reportedLayouts.push(layout),
    });
    await waitFor(() => expect(regionApi().loading).toBe(false));
    // Refused for good, so kept for this visit only.
    engine.failNextRequest(422, { code: "invalid_manifest", message: "…" });
    fireEvent.click(columnBox("status"));
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(shownHeadings()).toEqual(["title", "priority"]);

    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "hide", id: "links" }] }],
      message: "I've hidden the links.",
    });
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "hide the links" },
    });
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Preview" })));
    await act(async () => fireEvent.click(await renderResult.findByRole("button", { name: "Keep" })));
    const linksElement = () => renderResult.container.querySelector<HTMLElement>('[data-clickless-item="links"]')!;
    await waitFor(() => expect(linksElement().hidden).toBe(true));
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
    expect(reportedLayouts.at(-1)!.items.table!.props.columns).toEqual(ALL_COLUMNS);

    // Undo takes back the prompt, the newest change.
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(linksElement().hidden).toBe(false));
  });

  it("show the user's saved layout once the engine answers again, even with nothing to save", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "tasks",
      manifestVersion: "1",
      order: ["table"],
      items: { table: { w: 12, h: 4, hidden: false, props: { columns: ["title", "status"], density: "compact" } } },
    };
    Object.assign(savedTasksState(), { revision: 3, layout: savedLayout });
    const { renderResult, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));
    expect(shownHeadings()).toEqual(ALL_COLUMNS);

    // Any request that gets an answer shows the engine is back.
    setOutage(null);
    await act(async () => {
      await regionApi().readHistory({ limit: 1 });
    });
    await waitFor(() => expect(regionApi().loadFailed).toBe(false));
    expect(shownHeadings()).toEqual(["title", "status"]);
    expect(renderResult.queryByText(/isn't available right now/)).toBeNull();
  });

  it("are carried over to the saved layout when it holds the same for what they changed", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    // Saved earlier: the compact table, with every column.
    const savedLayout: Layout = {
      formatVersion: 1,
      regionId: "tasks",
      manifestVersion: "1",
      order: ["table"],
      items: { table: { w: 12, h: 4, hidden: false, props: { columns: ALL_COLUMNS, density: "compact" } } },
    };
    Object.assign(savedTasksState(), { revision: 2, layout: savedLayout });
    const { renderResult, columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));

    fireEvent.click(columnBox("status"));
    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(shownHeadings()).toEqual(["title", "priority"]);
    expect(renderResult.container.querySelector("[data-density]")!.getAttribute("data-density")).toBe("compact");
    expect(savedTasksState().revision).toBe(3);
    expect(savedTasksState().layout!.items.table!.props).toEqual({ columns: ["title", "priority"], density: "compact" });
  });

  it.each([
    [422, "invalid_manifest"],
    // No permission: a fresh sign-in would be refused the same way.
    [403, "forbidden"],
  ] as const)("are kept for the visit, and not tried again, when the engine refuses them for good (%i %s)", async (status, errorCode) => {
    const { engineOptions, engine, savedTasksState } = createEngineWithOutage();
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    engine.failNextRequest(status, { code: errorCode, message: "…" });
    fireEvent.click(columnBox("status"));
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(shownHeadings()).toEqual(["title", "priority"]);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "revisions")).toHaveLength(1);
    expect(savedTasksState().revision).toBe(0);
  });
});

describe("the host's own handler", () => {
  it("does not stop a change when it throws, and the fault is reported", async () => {
    const reportedErrors: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reportedErrors.push(error));
    try {
      const { engineOptions } = createEngineWithOutage("unreachable");
      let regionApiValue!: RegionApi;
      function RegionApiProbe() {
        regionApiValue = useAdaptiveRegion("tasks");
        return null;
      }
      const renderResult = render(
        <AdaptiveProvider userId="user-1" engine={engineOptions}>
          <RegionApiProbe />
          <AdaptiveRegion
            id="tasks"
            version="1"
            onLayoutChange={() => {
              throw new Error("the host's own save failed");
            }}
          >
            <Adaptive id="table" title="Tasks" defaults={{ w: 12, h: 4 }}>
              table
            </Adaptive>
            <Adaptive id="notes" title="Notes" defaults={{ w: 12, h: 1 }}>
              notes
            </Adaptive>
          </AdaptiveRegion>
        </AdaptiveProvider>,
      );
      let applyOutcome: unknown;
      await act(async () => {
        applyOutcome = await regionApiValue.applyOperations([{ type: "hide", id: "table" }]);
      });
      expect(applyOutcome).toMatchObject({ applied: true });
      expect(renderResult.container.querySelector<HTMLElement>('[data-clickless-item="table"]')!.hidden).toBe(true);
      expect(reportedErrors).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/** Tasks and a sidebar under one panel. The tasks region can be taken off the screen and brought back. */
function renderTwoRegionPage(
  { engineOptions, engine }: ReturnType<typeof createEngineWithOutage>,
  onTasksLayoutChange: (layout: Layout) => void,
) {
  let tasksApi!: RegionApi;
  let sidebarApi!: RegionApi;
  function TasksApiProbe() {
    tasksApi = useAdaptiveRegion("tasks");
    sidebarApi = useAdaptiveRegion("sidebar");
    return null;
  }
  function TwoRegionPage({ showTasks }: { showTasks: boolean }) {
    return (
      <AdaptiveProvider userId="user-1" engine={engineOptions}>
        <TasksApiProbe />
        {showTasks && (
          <AdaptiveRegion id="tasks" version="1" onLayoutChange={onTasksLayoutChange}>
            <Adaptive
              id="table"
              title="Tasks"
              defaults={{ w: 12, h: 4 }}
              presets={{
                columns: propPresets.visibleList({ values: ALL_COLUMNS, min: 1, means: "the columns that show" }),
              }}
            >
              {(props, adaptiveControls) => (
                <TasksTable
                  shownColumns={props.columns as string[]}
                  density={undefined}
                  onShownColumnsChange={(nextShownColumns) =>
                    void adaptiveControls.setProp("columns", nextShownColumns)
                  }
                />
              )}
            </Adaptive>
          </AdaptiveRegion>
        )}
        <AdaptiveRegion id="sidebar" version="1">
          <Adaptive id="links" title="Links" defaults={{ w: 12, h: 1 }}>
            links
          </Adaptive>
          {/* A region always keeps something showing, so Links can be hidden. */}
          <Adaptive id="help" title="Help" defaults={{ w: 12, h: 1 }}>
            help
          </Adaptive>
        </AdaptiveRegion>
        <PromptPanel regionId={["tasks", "sidebar"]} defaultOpen dictation={false} />
      </AdaptiveProvider>
    );
  }
  const renderResult = render(<TwoRegionPage showTasks />);
  return {
    renderResult,
    /** Waits for both regions to have their saved layouts. */
    waitUntilLoaded: async () => {
      await waitFor(() =>
        expect(engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "layout")).toHaveLength(2),
      );
      await act(async () => {});
    },
    setShowTasks: (showTasks: boolean) => renderResult.rerender(<TwoRegionPage showTasks={showTasks} />),
    /** Makes a change the engine refuses for good, so it is kept for this visit only. */
    tasksApi: () => tasksApi,
    sidebarApi: () => sidebarApi,
    keepStatusHiddenForTheVisit: async () => {
      engine.failNextRequest(422, { code: "invalid_manifest", message: "…" });
      fireEvent.click(renderResult.getByRole("checkbox", { name: "status" }));
      expect(tasksApi.hasUnsavedChanges).toBe(true);
      await waitFor(() => expect(tasksApi.hasUnsavedChanges).toBe(false));
    },
    shownHeadings: () => [...renderResult.container.querySelectorAll("th")].map((headingCell) => headingCell.textContent),
    linksElement: () => renderResult.container.querySelector<HTMLElement>('[data-clickless-item="links"]')!,
  };
}

/** Asks the panel for a change, and keeps it. */
async function keepPrompt(renderResult: ReturnType<typeof render>, prompt: string) {
  fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: prompt } });
  await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Preview" })));
  // An earlier "Your change to this screen is saved." stays in the conversation, so this waits for one more.
  const savedBefore = renderResult.queryAllByText("Your change to this screen is saved.").length;
  await act(async () => fireEvent.click(await renderResult.findByRole("button", { name: "Keep" })));
  await waitFor(() => expect(renderResult.queryAllByText("Your change to this screen is saved.")).toHaveLength(savedBefore + 1));
}


describe("changes kept for the visit, across the regions of one panel", () => {
  it("give way in a region that is off the screen when a later change is saved", async () => {
    const engineWithOutage = createEngineWithOutage();
    const { engine } = engineWithOutage;
    const reportedLayouts: Layout[] = [];
    const { renderResult, waitUntilLoaded, setShowTasks, keepStatusHiddenForTheVisit, shownHeadings, linksElement } = renderTwoRegionPage(
      engineWithOutage,
      (layout) => reportedLayouts.push(layout),
    );
    await waitUntilLoaded();
    await keepStatusHiddenForTheVisit();
    expect(shownHeadings()).toEqual(["title", "priority"]);

    setShowTasks(false);
    const reportsBeforePrompt = reportedLayouts.length;
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "hide", id: "links" }] }],
      message: "I've hidden the links.",
    });
    await keepPrompt(renderResult, "hide the links");
    expect(linksElement().hidden).toBe(true);
    // Nothing is reported for a region that is not there.
    expect(reportedLayouts).toHaveLength(reportsBeforePrompt);

    // Back on the screen, the older change kept for the visit has given way.
    setShowTasks(true);
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
    // And Undo takes back the prompt, the newest change, not that older one.
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(linksElement().hidden).toBe(false));
    expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "v1/changes/undo")).toBe(true);
  });

  it("give way, and are reported once, when a restore leaves their region's saved layout as it was", async () => {
    const engineWithOutage = createEngineWithOutage();
    const { engine } = engineWithOutage;
    const reportedLayouts: Layout[] = [];
    const { renderResult, waitUntilLoaded, keepStatusHiddenForTheVisit, shownHeadings, linksElement } = renderTwoRegionPage(engineWithOutage, (layout) =>
      reportedLayouts.push(layout),
    );
    await waitUntilLoaded();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "hide", id: "links" }] }],
      message: "I've hidden the links.",
    });
    await keepPrompt(renderResult, "hide the links");
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "show", id: "links" }] }],
      message: "The links are back.",
    });
    await keepPrompt(renderResult, "show the links");
    expect(linksElement().hidden).toBe(false);

    await keepStatusHiddenForTheVisit();
    expect(shownHeadings()).toEqual(["title", "priority"]);
    const reportsBeforeRestore = reportedLayouts.length;

    // Back to after the first prompt: only the sidebar's saved layout changes.
    const [restoreToFirstPrompt] = renderResult.getAllByRole("button", { name: "Restore to this point" });
    await act(async () => fireEvent.click(restoreToFirstPrompt!));
    await waitFor(() => expect(linksElement().hidden).toBe(true));
    expect(engine.savedStateOf("tasks").revision).toBe(0);
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
    expect(reportedLayouts).toHaveLength(reportsBeforeRestore + 1);
    expect(reportedLayouts.at(-1)!.items.table!.props.columns).toEqual(ALL_COLUMNS);
  });
});

describe("several regions under one panel while the engine cannot be reached", () => {
  const UNAVAILABLE_FOR_ACTION = "Personalising isn't available right now. Please try again in a little while.";

  it("keep and undo the page's own changes, refuse plainly to undo or restore saved ones, and keep the history", async () => {
    const engineWithOutage = createEngineWithOutage();
    const { engine, setOutage } = engineWithOutage;
    const { renderResult, waitUntilLoaded, shownHeadings, linksElement, tasksApi } = renderTwoRegionPage(engineWithOutage, () => {});
    await waitUntilLoaded();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "hide", id: "links" }] }],
      message: "I've hidden the links.",
    });
    await keepPrompt(renderResult, "hide the links");
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "show", id: "links" }] }],
      message: "The links are back.",
    });
    await keepPrompt(renderResult, "show the links");

    setOutage("unreachable");
    // The page's own change shows at once, and is taken back within the visit.
    fireEvent.click(renderResult.getByRole("checkbox", { name: "status" }));
    expect(shownHeadings()).toEqual(["title", "priority"]);
    expect(tasksApi().hasUnsavedChanges).toBe(true);
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(shownHeadings()).toEqual(ALL_COLUMNS));
    expect(tasksApi().hasUnsavedChanges).toBe(false);

    // A saved change needs the engine to be undone, and the user is told so.
    const savedCallsBefore = engine.receivedCalls.length;
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await renderResult.findByText(UNAVAILABLE_FOR_ACTION);
    expect(linksElement().hidden).toBe(false);

    // So does going back to an earlier point, and the history stays listed.
    const [restoreToFirstPrompt] = renderResult.getAllByRole("button", { name: "Restore to this point" });
    await act(async () => fireEvent.click(restoreToFirstPrompt!));
    // The undo's refusal stays in the conversation above this one.
    await waitFor(() => expect(renderResult.queryAllByText(UNAVAILABLE_FOR_ACTION)).toHaveLength(2));
    expect(linksElement().hidden).toBe(false);
    expect(renderResult.getByText("hide the links")).toBeTruthy();
    expect(renderResult.getByText("show the links")).toBeTruthy();
    expect(engine.receivedCalls.length).toBe(savedCallsBefore);

    // Once it is back, the saved change can be undone again.
    setOutage(null);
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(linksElement().hidden).toBe(true));
  });
});

describe("the order changes reach the engine in", () => {
  it("a change saved after one kept for the visit only is what the screen shows", async () => {
    const { engineOptions, engine, savedTasksState } = createEngineWithOutage();
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    // Refused for good, so kept for this visit only.
    engine.failNextRequest(422, { code: "unstorable_value", message: "…" });
    fireEvent.click(columnBox("status"));
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));

    fireEvent.click(columnBox("priority"));
    await waitFor(() => expect(savedTasksState().revision).toBe(1));
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title"]);
    expect(shownHeadings()).toEqual(["title"]);
    // Undo takes back the saved change, the newest, through the engine.
    await act(() => regionApi().undoLastChange());
    expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "undo")).toBe(true);
    expect(shownHeadings()).toEqual(ALL_COLUMNS);
  });

  it("a prompt's change waits for an older one, and is refused while that cannot be saved", async () => {
    const { engineOptions, engine, savedTasksState } = createEngineWithOutage();
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    engine.failNextRequest(503, { code: "error", message: "…" });
    fireEvent.click(columnBox("status"));
    await waitFor(() => expect(engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "revisions")).toHaveLength(1));
    await act(async () => {});
    expect(regionApi().hasUnsavedChanges).toBe(true);

    const showOnlyTitles = [{ type: "setProp" as const, id: "table", prop: "columns", value: ["title"] }];
    engine.failNextRequest(503, { code: "error", message: "…" });
    let refusal: unknown;
    await act(async () => {
      refusal = await regionApi().applyOperations(showOnlyTitles, "only the titles").catch((rejectionReason) => rejectionReason);
    });
    expect((refusal as EngineError).status).toBe(503);
    expect(savedTasksState().revision).toBe(0);
    expect(shownHeadings()).toEqual(["title", "priority"]);

    // Once it can be, the older change is saved first, then the prompt's.
    await act(async () => {
      await regionApi().applyOperations(showOnlyTitles, "only the titles");
    });
    expect(savedTasksState().revision).toBe(2);
    expect(shownHeadings()).toEqual(["title"]);
    await act(() => regionApi().undoLastChange());
    expect(shownHeadings()).toEqual(["title", "priority"]);
  });

  it("a prompt saved across regions waits for an older change in another of them", async () => {
    const engineWithOutage = createEngineWithOutage();
    const { engine } = engineWithOutage;
    const { renderResult, waitUntilLoaded, shownHeadings, linksElement, tasksApi } = renderTwoRegionPage(engineWithOutage, () => {});
    await waitUntilLoaded();
    // A sign-in the engine refused: worth trying again, though the engine is there.
    engine.failNextRequest(401, { code: "unauthorized", message: "…" });
    fireEvent.click(renderResult.getByRole("checkbox", { name: "status" }));
    await waitFor(() => expect(engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "revisions")).toHaveLength(1));
    await act(async () => {});
    expect(tasksApi().hasUnsavedChanges).toBe(true);

    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "sidebar", operations: [{ type: "hide", id: "links" }] }],
      message: "I've hidden the links.",
    });
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "hide the links" },
    });
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Preview" })));
    engine.failNextRequest(401, { code: "unauthorized", message: "…" });
    await act(async () => fireEvent.click(await renderResult.findByRole("button", { name: "Keep" })));
    expect((await renderResult.findByRole("alert")).textContent).toBe("You have been signed out. Please sign in again.");
    expect(engine.receivedCalls.some((engineCall) => engineCall.method === "POST" && engineCall.endpointPath === "v1/changes")).toBe(false);

    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Keep" })));
    await waitFor(() => expect(linksElement().hidden).toBe(true));
    expect(engine.savedStateOf("tasks").revision).toBe(1);
    // Undo takes back the prompt, the newest change, and leaves the older one.
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(linksElement().hidden).toBe(false));
    expect(shownHeadings()).toEqual(["title", "priority"]);
  });
});

describe("undo across the regions of one panel", () => {
  it("takes back a change saved in the background before an older one kept for the visit", async () => {
    const engineWithOutage = createEngineWithOutage();
    const { engine } = engineWithOutage;
    const { renderResult, waitUntilLoaded, keepStatusHiddenForTheVisit, shownHeadings, linksElement, sidebarApi } = renderTwoRegionPage(
      engineWithOutage,
      () => {},
    );
    await waitUntilLoaded();
    await keepStatusHiddenForTheVisit();
    // A newer change, in the other region, saved behind the scenes.
    await act(async () => {
      await sidebarApi().applyOperations([{ type: "hide", id: "links" }]);
    });
    await waitFor(() => expect(engine.savedStateOf("sidebar").revision).toBe(1));
    expect(linksElement().hidden).toBe(true);

    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(linksElement().hidden).toBe(false));
    expect(shownHeadings()).toEqual(["title", "priority"]);
  });
});

describe("what waits, and what stops", () => {
  it("changes to a section that has left the screen, and to one still on it, are both saved", async () => {
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    let regionApiValue!: RegionApi;
    function TasksWithSummary({ showTable }: { showTable: boolean }) {
      regionApiValue = useAdaptiveRegion("tasks");
      return (
        <AdaptiveRegion id="tasks" version="1">
          <Adaptive id="summary" title="Summary" defaults={{ w: 12, h: 1 }}>
            summary
          </Adaptive>
          <Adaptive id="notes" title="Notes" defaults={{ w: 12, h: 1 }}>
            notes
          </Adaptive>
          {showTable && (
            <Adaptive
              id="table"
              title="Tasks"
              defaults={{ w: 12, h: 4 }}
              presets={{
                columns: propPresets.visibleList({ values: ALL_COLUMNS, min: 1, means: "the columns that show" }),
              }}
            >
              {(props, adaptiveControls) => (
                <TasksTable
                  shownColumns={props.columns as string[]}
                  density={undefined}
                  onShownColumnsChange={(nextShownColumns) =>
                    void adaptiveControls.setProp("columns", nextShownColumns)
                  }
                />
              )}
            </Adaptive>
          )}
        </AdaptiveRegion>
      );
    }
    const pageTree = (showTable: boolean) => (
      <AdaptiveProvider userId="user-1" engine={engineOptions}>
        <TasksWithSummary showTable={showTable} />
      </AdaptiveProvider>
    );
    const renderResult = render(pageTree(true));
    await waitFor(() => expect(regionApiValue.loadFailed).toBe(true));
    fireEvent.click(renderResult.getByRole("checkbox", { name: "status" }));

    // The table leaves the screen, as on another tab; then the summary is hidden.
    renderResult.rerender(pageTree(false));
    await act(async () => {
      await regionApiValue.applyOperations([{ type: "hide", id: "summary" }]);
    });

    setOutage(null);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(regionApiValue.hasUnsavedChanges).toBe(false));
    expect(savedTasksState().revision).toBe(2);
    expect(savedTasksState().layout!.items.summary!.hidden).toBe(true);

    renderResult.rerender(pageTree(true));
    expect([...renderResult.container.querySelectorAll("th")].map((headingCell) => headingCell.textContent)).toEqual([
      "title",
      "priority",
    ]);
  });

  it("a change made while a prompt's change is being saved is newer, and is kept and saved after it", async () => {
    const { engineOptions, engine, savedTasksState, holdNextRequest } = createEngineWithOutage();
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    // The prompt keeps "title" and "priority"; while it is on its way the user
    // unticks "priority" in the page's own menu, on the screen as it still is.
    const releasePrompt = holdNextRequest();
    const promptSave = regionApi().applyOperations(
      [{ type: "setProp", id: "table", prop: "columns", value: ["title", "priority"] }],
      "hide the status column",
    );
    await act(async () => {});
    expect(savedTasksState().revision).toBe(0);
    fireEvent.click(columnBox("priority"));
    expect(shownHeadings()).toEqual(["title", "status"]);
    await act(async () => {
      releasePrompt();
      await promptSave;
    });
    await waitFor(() => expect(regionApi().hasUnsavedChanges).toBe(false));
    // The user's click came last, so it is what is saved and shown.
    expect(savedTasksState().revision).toBe(2);
    expect(savedTasksState().layout!.items.table!.props.columns).toEqual(["title", "status"]);
    expect(shownHeadings()).toEqual(["title", "status"]);
    expect(engine.receivedCalls.filter((engineCall) => engineCall.endpointPath === "revisions")).toHaveLength(2);
  });

  it("a read started by a save is tried again on its own when it fails", async () => {
    vi.useFakeTimers();
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    Object.assign(savedTasksState(), {
      revision: 3,
      layout: {
        formatVersion: 1,
        regionId: "tasks",
        manifestVersion: "1",
        order: ["table"],
        items: { table: { w: 12, h: 4, hidden: false, props: { columns: ["title", "status"], density: "compact" } } },
      },
    });
    const { columnBox, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(regionApi().loadFailed).toBe(true);
    // Just before the read is due to be tried again, a change starts a save,
    // which reads first, slowly; the read due meanwhile finds one under way.
    await act(() => vi.advanceTimersByTimeAsync(4_900));
    setOutage("slow");
    fireEvent.click(columnBox("priority"));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    // Taking the change back leaves nothing to save; the read is still tried again.
    await act(() => regionApi().undoLastChange());
    setOutage(null);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(regionApi().loadFailed).toBe(false);
    expect(shownHeadings()).toEqual(["title", "status"]);
  });

  it("a saved layout that could not be read is read again on its own once the engine is back", async () => {
    vi.useFakeTimers();
    const { engineOptions, setOutage, savedTasksState } = createEngineWithOutage("unreachable");
    Object.assign(savedTasksState(), {
      revision: 3,
      layout: {
        formatVersion: 1,
        regionId: "tasks",
        manifestVersion: "1",
        order: ["table"],
        items: { table: { w: 12, h: 4, hidden: false, props: { columns: ["title", "status"], density: "compact" } } },
      },
    });
    const { renderResult, shownHeadings, regionApi } = renderTasksPage(engineOptions);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(regionApi().loadFailed).toBe(true);
    expect(launcherButtonOf(renderResult).hasAttribute("data-clickless-unavailable")).toBe(true);

    setOutage(null);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(regionApi().loadFailed).toBe(false);
    expect(shownHeadings()).toEqual(["title", "status"]);
    expect(launcherButtonOf(renderResult).hasAttribute("data-clickless-unavailable")).toBe(false);
  });

  it("says plainly when the saved layout is refused though the engine answers", async () => {
    const { engineOptions, engine } = createEngineWithOutage();
    engine.failNextRequest(403, { code: "forbidden", message: "…" });
    const { renderResult, regionApi } = renderTasksPage(engineOptions);
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));
    await renderResult.findByText("Your saved changes to this screen couldn't be loaded just now, so it may not show them.");
    expect(launcherButtonOf(renderResult).hasAttribute("data-clickless-unavailable")).toBe(false);
  });

  it("a change for a region no longer on the screen is refused, not thrown", async () => {
    const engineWithOutage = createEngineWithOutage();
    const { waitUntilLoaded, setShowTasks, tasksApi } = renderTwoRegionPage(engineWithOutage, () => {});
    await waitUntilLoaded();
    setShowTasks(false);
    let applyOutcome: Promise<unknown> | undefined;
    expect(() => {
      applyOutcome = tasksApi().applyOperations([{ type: "hide", id: "table" }]);
    }).not.toThrow();
    await expect(applyOutcome).rejects.toThrow(/not mounted/);
  });

  it("nothing is tried again once the provider has gone, even a save that was under way", async () => {
    vi.useFakeTimers();
    const { engineOptions, setOutage, engine } = createEngineWithOutage();
    const { renderResult, columnBox, regionApi } = renderTasksPage(engineOptions);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(regionApi().loading).toBe(false);

    setOutage("slow");
    fireEvent.click(columnBox("status"));
    renderResult.unmount();
    // The save under way runs out of time after the provider has gone, and is not tried again.
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    setOutage(null);
    await act(() => vi.advanceTimersByTimeAsync(600_000));
    window.dispatchEvent(new Event("online"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "revisions")).toBe(false);
  });
});

