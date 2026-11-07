import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixturesDirectory } from "./sharedContract";
import {
  MAX_OFF_SCREEN_COMPONENTS,
  Manifest,
  Operation,
  applyOperations,
  contrastRatio,
  defaultLayout,
  ensureReadableTextColor,
  readableTextColor,
  reconcileLayout,
  type Layout,
} from "../src/index";

const dashboardManifest = Manifest.parse(
  JSON.parse(
    readFileSync(fixturesDirectory + "manifests/dashboard.json", "utf8"),
  ),
);

describe("defaultLayout", () => {
  it("follows the manifest order and copies the defaults", () => {
    const layout = defaultLayout(dashboardManifest);
    expect(layout.order).toEqual(["balance", "revenue", "txns", "alerts", "notes"]);
    expect(layout.manifestVersion).toBe("1");
    layout.items.revenue!.props.chartType = "line";
    expect(dashboardManifest.components[1]!.defaults.props.chartType).toBe("bar");
  });
});

describe("applyOperations", () => {
  it("rejects a layout that was not reconciled against the manifest", () => {
    const layout = defaultLayout(dashboardManifest);
    delete layout.items.notes;
    expect(() => applyOperations(dashboardManifest, layout, [])).toThrow(/does not match manifest/);
  });
});

describe("reconcileLayout", () => {
  it("keeps no more than the limit off screen", () => {
    const overviewTabManifest = Manifest.parse(
      JSON.parse(
        readFileSync(fixturesDirectory + "manifests/tabs-overview.json", "utf8"),
      ),
    );
    const offScreenIds = Array.from(
      { length: MAX_OFF_SCREEN_COMPONENTS + 1 },
      (_, offScreenIndex) => `left-${String(offScreenIndex).padStart(3, "0")}`,
    );
    const plainLayoutItem = { w: 6, h: 3, hidden: false, props: {} };
    const layout: Layout = {
      formatVersion: 1,
      regionId: "tabs",
      manifestVersion: "1",
      order: ["revenue", "sales"],
      items: { revenue: plainLayoutItem, sales: plainLayoutItem },
      offScreen: {
        order: ["revenue", ...offScreenIds, "sales"],
        items: Object.fromEntries(
          offScreenIds.map((componentId) => [componentId, plainLayoutItem]),
        ),
      },
    };

    const reconcileResult = reconcileLayout(overviewTabManifest, layout);

    const keptOffScreenIds = offScreenIds.slice(0, -1);
    expect(reconcileResult.changes).toEqual([{ type: "removed", id: offScreenIds.at(-1) }]);
    expect(Object.keys(reconcileResult.layout.offScreen!.items)).toEqual(keptOffScreenIds);
    expect(reconcileResult.layout.offScreen!.order).toEqual(["revenue", ...keptOffScreenIds, "sales"]);
  });
});

describe("Operation schema", () => {
  it("rejects unknown operation types and extra fields", () => {
    expect(Operation.safeParse({ type: "delete", id: "revenue" }).success).toBe(false);
    expect(Operation.safeParse({ type: "hide", id: "revenue", force: true }).success).toBe(false);
  });
});

describe("readableTextColor", () => {
  it.each([
    ["#000000", "#ffffff"],
    ["#b91c1c", "#ffffff"],
    ["#1c5cab", "#ffffff"],
    ["#7b2ff7", "#ffffff"],
    ["#ffffff", "#000000"],
    ["#FFE14D", "#000000"],
    ["#fcfcfb", "#000000"],
    ["#8bd3c7", "#000000"],
  ])("on %s picks %s", (backgroundColour, expectedTextColor) => {
    expect(readableTextColor(backgroundColour)).toBe(expectedTextColor);
  });

  it("treats anything that is not a colour code as a light background", () => {
    expect(readableTextColor("purple")).toBe("#000000");
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#1c5cab")).toBe(contrastRatio("#1c5cab", "#ffffff"));
  });

  it("is 1 when a value is not a colour", () => {
    expect(contrastRatio("navy", "#ffffff")).toBe(1);
  });
});

describe("ensureReadableTextColor", () => {
  it("keeps a text colour that can be read on the background", () => {
    expect(ensureReadableTextColor("#1c5cab", "#ffffff")).toBe("#1c5cab");
    expect(ensureReadableTextColor("#ffe14d", "#0b0b0b")).toBe("#ffe14d");
  });

  it("falls back to black or white when the contrast is too low", () => {
    expect(ensureReadableTextColor("#ffe14d", "#ffffff")).toBe("#000000");
    expect(ensureReadableTextColor("#1c2a44", "#0b0b0b")).toBe("#ffffff");
    expect(ensureReadableTextColor("#ffffff", "#ffffff")).toBe("#000000");
    expect(ensureReadableTextColor("not a colour", "#0b0b0b")).toBe("#ffffff");
  });

  it("accepts a lower minimum for large text", () => {
    expect(ensureReadableTextColor("#777777", "#ffffff")).toBe("#000000");
    expect(ensureReadableTextColor("#777777", "#ffffff", 3)).toBe("#777777");
  });
});
