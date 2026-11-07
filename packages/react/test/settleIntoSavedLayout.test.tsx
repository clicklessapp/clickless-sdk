// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layout } from "@clickless/core";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, useAdaptiveRegion } from "../src/index";
import { createFakeEngine } from "./dashboardWithFakeEngine";

type RegionApi = ReturnType<typeof useAdaptiveRegion>;

const layoutItem = (hidden = false) => ({ w: 6, h: 3, hidden, props: {} });
const defaultLayout: Layout = {
  formatVersion: 1,
  regionId: "dashboard",
  manifestVersion: "1",
  order: ["balance", "revenue", "txns"],
  items: { balance: layoutItem(), revenue: layoutItem(), txns: layoutItem(true) },
};
const savedLayout: Layout = {
  ...defaultLayout,
  order: ["revenue", "balance", "txns"],
  items: { balance: layoutItem(), revenue: layoutItem(), txns: layoutItem() },
};

let startedAnimations: { itemId: string; keyframes: Keyframe[]; animationOptions: KeyframeAnimationOptions }[] = [];
let prefersReducedMotion = false;
// How far the page has scrolled, which moves every item on screen alike.
let scrolledPixels = 0;
const originalAnimate = HTMLElement.prototype.animate;
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  startedAnimations = [];
  prefersReducedMotion = false;
  scrolledPixels = 0;
  // Each item is drawn one row lower for each place it has in the order.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return { left: 0, top: Number(this.style.order || 0) * 100 - scrolledPixels, width: 100, height: 100 } as DOMRect;
  };
  HTMLElement.prototype.animate = function (
    this: HTMLElement,
    keyframes: Keyframe[],
    animationOptions: KeyframeAnimationOptions,
  ) {
    startedAnimations.push({ itemId: this.dataset.clicklessItem ?? "", keyframes, animationOptions });
    return {} as Animation;
  } as typeof HTMLElement.prototype.animate;
  window.matchMedia = ((mediaQueryText: string) =>
    ({
      matches: mediaQueryText.includes("reduced-motion") && prefersReducedMotion,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  HTMLElement.prototype.animate = originalAnimate;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  window.matchMedia = originalMatchMedia;
});

/** A dashboard whose engine answers only when told to. */
function renderWithSlowEngine(layoutOnEngine: Layout | null, { layoutRequestFails = false } = {}) {
  const engine = createFakeEngine({ revision: layoutOnEngine ? 2 : 0, layout: layoutOnEngine });
  let releaseLayoutAnswer!: () => void;
  const layoutAnswerReleased = new Promise<void>((resolve) => (releaseLayoutAnswer = resolve));
  const fetchFromEngine = engine.engineOptions.fetch;
  const slowFetch: typeof fetch = async (requestInput, requestInit) => {
    if (String(requestInput).endsWith("/layout")) {
      await layoutAnswerReleased;
      if (layoutRequestFails) throw new TypeError("network down");
    }
    return fetchFromEngine(requestInput, requestInit);
  };
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return null;
  }
  render(
    <AdaptiveProvider userId="user-1" engine={{ ...engine.engineOptions, fetch: slowFetch }}>
      <RegionApiProbe />
      <AdaptiveRegion id="dashboard" version="1">
        <Adaptive id="balance" defaults={{ w: 6, h: 3 }}>
          <div>balance</div>
        </Adaptive>
        <Adaptive id="revenue" defaults={{ w: 6, h: 3 }}>
          <div>revenue</div>
        </Adaptive>
        <Adaptive id="txns" defaults={{ w: 6, h: 3, hidden: true }}>
          <div>txns</div>
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  return { regionApi: () => regionApiValue, answerLayoutRequest: () => act(async () => releaseLayoutAnswer()) };
}

describe("when the saved layout arrives after the default was drawn", () => {
  it("glides the items it moves and fades in the ones it shows, without the page having waited", async () => {
    const { regionApi, answerLayoutRequest } = renderWithSlowEngine(savedLayout);
    expect(regionApi().loading).toBe(true);
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);

    await answerLayoutRequest();
    await waitFor(() => expect(regionApi().loading).toBe(false));
    expect(startedAnimations.map(({ itemId, keyframes }) => [itemId, keyframes])).toEqual([
      ["revenue", [{ transform: "translate(0px, 100px)" }, { transform: "translate(0, 0)" }]],
      ["balance", [{ transform: "translate(0px, -100px)" }, { transform: "translate(0, 0)" }]],
      ["txns", [{ opacity: 0 }, { opacity: 1 }]],
    ]);
    // A glide adds to a transform of the host's own instead of replacing it.
    expect(startedAnimations[0]!.animationOptions.composite).toBe("add");
  });

  it("moves nothing when the page scrolled while the engine was slow but the layout is the default", async () => {
    const { regionApi, answerLayoutRequest } = renderWithSlowEngine(null);
    scrolledPixels = 500;
    await answerLayoutRequest();
    await waitFor(() => expect(regionApi().loading).toBe(false));
    expect(startedAnimations).toEqual([]);
  });

  it("moves nothing when the engine cannot be reached, nor on a later change of the user's own", async () => {
    const { regionApi, answerLayoutRequest } = renderWithSlowEngine(savedLayout, { layoutRequestFails: true });
    await answerLayoutRequest();
    await waitFor(() => expect(regionApi().loadFailed).toBe(true));
    expect(startedAnimations).toEqual([]);

    await act(() => regionApi().applyOperations([{ type: "move", id: "revenue", position: "start" }]).catch(() => {}));
    expect(startedAnimations).toEqual([]);
  });

  it("moves nothing for a user who asks for less motion", async () => {
    prefersReducedMotion = true;
    const { regionApi, answerLayoutRequest } = renderWithSlowEngine(savedLayout);
    await answerLayoutRequest();
    await waitFor(() => expect(regionApi().loading).toBe(false));
    expect(regionApi().layout!.order).toEqual(["revenue", "balance", "txns"]);
    expect(startedAnimations).toEqual([]);
  });
});
