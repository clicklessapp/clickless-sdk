import { describe, expect, it } from "vitest";
import { applyOperations, defaultLayout, layoutMatchesManifest, reconcileLayout, type Manifest } from "../src/index";

// Names a plain object already has a meaning for. A developer is free to use them.
// Written as `{ __proto__: … }` the key would set what the object inherits
// from, so each entry is put in by name.
const recordWithEntry = <T,>(entryName: string, entryValue: T): Record<string, T> => Object.fromEntries([[entryName, entryValue]]);
const builtinNamedManifest: Manifest = {
  regionId: "screen",
  version: "1",
  columns: 12,
  components: ["__proto__", "constructor", "toString"].map((componentId) => ({
    id: componentId,
    kind: "card",
    title: componentId,
    capabilities: { move: true, hide: true, props: recordWithEntry("__proto__", { values: ["a", "b"] }) },
    defaults: { w: 6, h: 2, hidden: false, props: recordWithEntry("__proto__", "a") },
  })),
};

describe("components and props named like something a plain object already has", () => {
  it("each get an entry of their own in the default layout", () => {
    const layout = defaultLayout(builtinNamedManifest);
    expect(Object.keys(layout.items)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.keys(layout.items["constructor"]!.props)).toEqual(["__proto__"]);
    expect(layoutMatchesManifest(builtinNamedManifest, layout)).toBe(true);
    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout);
  });

  it("are not taken to be in a layout that lacks them", () => {
    const layout = defaultLayout({ ...builtinNamedManifest, components: [] });
    expect(layoutMatchesManifest(builtinNamedManifest, layout)).toBe(false);
    expect(Object.keys(reconcileLayout(builtinNamedManifest, layout).layout.items)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
  });

  it("can be changed like any other", () => {
    const applyOutcome = applyOperations(builtinNamedManifest, defaultLayout(builtinNamedManifest), [
      { type: "hide", id: "__proto__" },
      { type: "setProp", id: "constructor", prop: "__proto__", value: "b" },
    ]);
    expect(applyOutcome.applied).toBe(true);
    if (!applyOutcome.applied) return;
    expect(applyOutcome.layout.items["__proto__"]!.hidden).toBe(true);
    expect(Object.entries(applyOutcome.layout.items["constructor"]!.props)).toEqual([["__proto__", "b"]]);
  });
});
