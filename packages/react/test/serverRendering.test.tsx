// @vitest-environment node
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { reconcileLayout, type Layout, type Manifest } from "@clickless/core";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptPanel, propPresets } from "../src/index";

it("renders the saved layout on the server, before any effect has run", () => {
  const savedLayout: Layout = {
    formatVersion: 1,
    regionId: "dashboard",
    manifestVersion: "1",
    order: ["b", "a"],
    items: {
      a: { w: 4, h: 2, hidden: true, props: {} },
      b: { w: 8, h: 2, hidden: false, props: { mode: "wide" } },
    },
  };
  const renderedHtml = renderToString(
    <AdaptiveProvider userId="user-1">
      <AdaptiveRegion id="dashboard" version="1" initialLayout={savedLayout}>
        <Adaptive id="a" defaults={{ w: 6, h: 2 }}>
          a body
        </Adaptive>
        <Adaptive
          id="b"
          capabilities={{ resize: { minW: 4, maxW: 12, minH: 2, maxH: 4 } }}
          presets={{ mode: propPresets.choice({ values: ["narrow", "wide"], initial: "narrow", means: "how wide it is" }) }}
          defaults={{ w: 6, h: 2 }}
        >
          {(props) => `b is ${String(props.mode)}`}
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  expect(renderedHtml).not.toContain("a body");
  expect(renderedHtml).toContain("b is wide");
  expect(renderedHtml).toMatch(/data-clickless-item="b"[^>]*grid-column:span 8[^>]*order:0/);
  // Browsers that can will read and tab through the items in the order they are drawn.
  expect(renderedHtml).toMatch(/data-clickless-region="dashboard"[^>]*reading-flow:grid-order/);
});

function renderTable(initialLayout: Layout) {
  return renderToString(
    <AdaptiveProvider userId="user-1">
      <AdaptiveRegion id="dashboard" version="2" initialLayout={initialLayout}>
        <Adaptive
          id="table"
          capabilities={{ resize: { minW: 4, maxW: 8, minH: 2, maxH: 4 } }}
          presets={{
            columns: propPresets.visibleList({ values: ["name", "amount"], min: 1, means: "the columns that show" }),
            tint: propPresets.colour({ initial: "#112233", means: "the colour of the text" }),
          }}
          defaults={{ w: 6, h: 2 }}
        >
          {(props) => (
            <p style={{ color: String(props.tint) }}>{(props.columns as string[]).join(" and ")}</p>
          )}
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
}

it("corrects a layout saved for an older version before the first render", () => {
  // Saved before the table had `columns`, wider than it may now be, with a colour that is not one.
  const renderedHtml = renderTable({
    formatVersion: 1,
    regionId: "dashboard",
    manifestVersion: "1",
    order: ["table"],
    items: { table: { w: 12, h: 2, hidden: false, props: { tint: "red;background:url(x)" } } },
  });
  expect(renderedHtml).toContain("name and amount");
  expect(renderedHtml).toContain("#112233");
  expect(renderedHtml).not.toContain("url(x)");
  expect(renderedHtml).toMatch(/data-clickless-item="table"[^>]*grid-column:span 8/);
});

it("shows the default when the saved layout cannot be read", () => {
  const renderedHtml = renderTable({ order: "table" } as unknown as Layout);
  expect(renderedHtml).toContain("name and amount");
  expect(renderedHtml).toMatch(/data-clickless-item="table"[^>]*grid-column:span 6/);
});

it("shows the default for a saved layout that does not say it is in this format", () => {
  const savedWide = {
    regionId: "dashboard",
    manifestVersion: "2",
    order: ["table"],
    items: { table: { w: 8, h: 2, hidden: false, props: {} } },
  };
  for (const savedLayout of [savedWide, { ...savedWide, formatVersion: 2 }]) {
    const renderedHtml = renderTable(savedLayout as unknown as Layout);
    expect(renderedHtml).toMatch(/data-clickless-item="table"[^>]*grid-column:span 6/);
  }
  expect(renderTable({ ...savedWide, formatVersion: 1 })).toMatch(/data-clickless-item="table"[^>]*grid-column:span 8/);
});

it("draws components added since the layout was saved where they will end up", () => {
  // Saved when the screen had only `a` and `b`, with `b` moved first.
  const savedLayout: Layout = {
    formatVersion: 1,
    regionId: "dashboard",
    manifestVersion: "1",
    order: ["b", "a"],
    items: {
      a: { w: 6, h: 2, hidden: false, props: {} },
      b: { w: 6, h: 2, hidden: false, props: {} },
    },
  };
  const writtenOrder = ["first", "a", "after-a", "then", "b", "last"];
  const renderedHtml = renderToString(
    <AdaptiveProvider userId="user-1">
      <AdaptiveRegion id="dashboard" version="2" initialLayout={savedLayout}>
        {writtenOrder.map((componentId) => (
          <Adaptive key={componentId} id={componentId} defaults={{ w: 6, h: 2 }}>
            {componentId}
          </Adaptive>
        ))}
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  const drawOrderOf = (componentId: string) =>
    Number(new RegExp(`data-clickless-item="${componentId}"[^>]*[;"]order:(-?\\d+)`).exec(renderedHtml)![1]);
  const drawnOrder = [...writtenOrder].sort((firstId, secondId) => drawOrderOf(firstId) - drawOrderOf(secondId));

  // The same order the region settles on once it has mounted and reconciled.
  const manifest: Manifest = {
    regionId: "dashboard",
    version: "2",
    columns: 12,
    components: writtenOrder.map((componentId) => ({
      id: componentId,
      kind: "component",
      title: componentId,
      capabilities: { move: true, hide: true },
      defaults: { w: 6, h: 2, hidden: false, props: {} },
    })),
  };
  expect(drawnOrder).toEqual(reconcileLayout(manifest, savedLayout).layout.order);
  expect(drawnOrder).toEqual(["first", "b", "last", "a", "after-a", "then"]);
});

it("treats a saved place with no saved settings as new, and inherited names as absent", () => {
  // `b` is in the order but has no item, so it is placed afresh after `a`.
  const savedLayout = {
    formatVersion: 1,
    regionId: "dashboard",
    manifestVersion: "1",
    order: ["b", "a"],
    items: { a: { w: 6, h: 2, hidden: false, props: {} } },
  } as Layout;
  const renderedHtml = renderToString(
    <AdaptiveProvider userId="user-1">
      <AdaptiveRegion id="dashboard" version="2" initialLayout={savedLayout}>
        {["a", "b", "constructor", "toString"].map((componentId) => (
          <Adaptive key={componentId} id={componentId} defaults={{ w: 6, h: 2 }}>
            {componentId}
          </Adaptive>
        ))}
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  const drawOrderOf = (componentId: string) =>
    Number(new RegExp(`data-clickless-item="${componentId}"[^>]*[;"]order:(-?\\d+)`).exec(renderedHtml)![1]);
  const drawnOrder = ["a", "b", "constructor", "toString"].sort(
    (firstId, secondId) => drawOrderOf(firstId) - drawOrderOf(secondId),
  );
  expect(drawnOrder).toEqual(["a", "b", "constructor", "toString"]);
  expect(renderedHtml).toContain("grid-column:span 6");
});

it("renders the open panel on the server, with no microphone button and no request to the engine", () => {
  const engineFetch = () => {
    throw new Error("the engine must not be asked while rendering on the server");
  };
  const renderedHtml = renderToString(
    <AdaptiveProvider userId="user-1" engine={{ url: "https://engine.test", getToken: () => "signed-token", fetch: engineFetch }}>
      <PromptPanel regionId="dashboard" defaultOpen />
      <AdaptiveRegion id="dashboard" version="1">
        <Adaptive id="a" defaults={{ w: 6, h: 2 }}>
          a body
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  expect(renderedHtml).toContain("Describe a change to this screen");
  // Whether to offer speaking is only known in the browser, after asking the engine.
  expect(renderedHtml).not.toContain("Speak your request");
});
