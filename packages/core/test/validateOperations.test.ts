import { describe, expect, it } from "vitest";
import { propAcceptsValue, reconcileLayoutItem, validateOperations, type Component, type Manifest } from "../src/index";

const cardComponent: Component = {
  id: "card",
  kind: "card",
  title: "Card",
  capabilities: {
    move: true,
    hide: true,
    props: {
      size: { type: "number", min: 0, max: 1000000, integer: true },
      opacity: { type: "number", min: 0.5, max: 2.5 },
      tiny: { type: "number", min: 0.00001, max: 1e21 },
      anything: { type: "number", min: -Infinity, max: Infinity },
      label: { values: ["café", "日本", 10, 2.5, true] },
      tags: { values: ["café", "日本"], multiple: true, min: 1 },
    },
  },
  defaults: {
    w: 4,
    h: 2,
    hidden: false,
    props: { size: 10, opacity: 1, tiny: 1, anything: 0, label: "café", tags: ["café"] },
  },
};
const cardManifest: Manifest = { regionId: "page", version: "1", columns: 12, components: [cardComponent] };

const validationMessagesFor = (propName: string, propValue: string | number | string[]) =>
  validateOperations(cardManifest, [
    { type: "setProp", id: "card", prop: propName, value: propValue },
  ]).map((operationError) => operationError.message);

describe("validateOperations", () => {
  // The engine's own operation validation tests expect these same sentences.
  it("words what a prop accepts exactly as the Python engine does", () => {
    expect(validationMessagesFor("size", -1)).toEqual([
      '"size" of "card" must be a whole number from 0 to 1000000',
    ]);
    expect(validationMessagesFor("opacity", 3)).toEqual(['"opacity" of "card" must be a number from 0.5 to 2.5']);
    expect(validationMessagesFor("tiny", 0)).toEqual(['"tiny" of "card" must be a number from 0.00001 to 1e+21']);
    expect(validationMessagesFor("label", "tea")).toEqual([
      '"label" of "card" must be one of ["café","日本",10,2.5,true]',
    ]);
    expect(validationMessagesFor("tags", [])).toEqual([
      '"tags" of "card" must be a list of at least 1 different entries from ["café","日本"]',
    ]);
  });

  it("refuses a number that is not finite even when the range has no limits", () => {
    expect(validationMessagesFor("anything", 1e300)).toEqual([]);
    for (const nonFiniteNumber of [Infinity, -Infinity, NaN]) {
      expect(validationMessagesFor("anything", nonFiniteNumber)).toEqual([
        '"anything" of "card" must be a number from -Infinity to Infinity',
      ]);
      expect(propAcceptsValue(cardComponent.capabilities.props!.anything!, nonFiniteNumber)).toBe(false);
    }
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "treats a prop named %s as undeclared",
    (propName) => {
      const validationErrors = validateOperations(cardManifest, [
        { type: "setProp", id: "card", prop: propName, value: "x" },
      ]);
      expect(validationErrors.map((operationError) => operationError.code)).toEqual(["unknown_prop"]);
    },
  );
});

describe("reconcileLayoutItem", () => {
  it("drops saved settings named like something every object has", () => {
    const savedItem = { ...cardComponent.defaults, props: { ...cardComponent.defaults.props, constructor: "x", toString: 1 } };
    expect(reconcileLayoutItem(cardComponent, savedItem, 12)).toEqual({
      ...cardComponent.defaults,
      offeredValues: { tags: ["café", "日本"] },
    });
  });

  it("fills a default named like something every object has when the saved item lacks it", () => {
    const componentWithBuiltinNamedProp: Component = {
      ...cardComponent,
      capabilities: { move: true, hide: true, props: { constructor: { values: ["a", "b"] } } },
      defaults: { w: 4, h: 2, hidden: false, props: { constructor: "a" } },
    };
    const savedItem = { w: 4, h: 2, hidden: false, props: {} };
    expect(reconcileLayoutItem(componentWithBuiltinNamedProp, savedItem, 12).props).toEqual({ constructor: "a" });
    expect(reconcileLayoutItem(componentWithBuiltinNamedProp, { ...savedItem, props: { constructor: "b" } }, 12).props).toEqual({
      constructor: "b",
    });
  });
});
