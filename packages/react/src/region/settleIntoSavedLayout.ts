import { useRef } from "react";
import type { Layout } from "@clickless/core";
import { useIsomorphicLayoutEffect } from "./regionContext";
import type { RegionStore } from "./regionStore";

const SETTLE_DURATION_MS = 280;
const SETTLE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * While the saved layout is being fetched the region shows what it has, often
 * the default, and nothing waits for the engine. When the saved layout arrives,
 * each item that it puts somewhere else glides there from where it was, and an
 * item that was not drawn fades in, so the change reads as the screen settling
 * rather than jumping. Users who ask for less motion get the change at once.
 *
 * Where items were is read the moment the engine answers, while the screen
 * still shows the old layout, so scrolling or the page's own content moving
 * while the engine was slow makes nothing slide.
 */
export function useSettleIntoSavedLayout(regionStore: RegionStore, layout: Layout | null): void {
  const shownLayout = useRef(layout);
  shownLayout.current = layout;
  const placesBefore = useRef<Map<string, DOMRect> | null>(null);

  useIsomorphicLayoutEffect(
    () =>
      regionStore.beforeSavedLayoutIsShown(() => {
        placesBefore.current =
          shownLayout.current && !prefersLessMotion() ? placesOf(regionStore, shownLayout.current) : null;
      }),
    [regionStore],
  );

  // After every commit, so places read for an answer that changed nothing on
  // screen are dropped then, not used for some later change.
  useIsomorphicLayoutEffect(() => {
    const placesBeforeAnswer = placesBefore.current;
    placesBefore.current = null;
    if (!placesBeforeAnswer || !layout) return;

    for (const [itemId, placeAfter] of placesOf(regionStore, layout)) {
      const itemElement = regionStore.elementOf(itemId);
      if (!itemElement || typeof itemElement.animate !== "function") continue;
      const placeBefore = placesBeforeAnswer.get(itemId);
      if (!placeBefore) {
        // One the host made see-through keeps its own opacity rather than flash.
        if (getComputedStyle(itemElement).opacity !== "1") continue;
        itemElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SETTLE_DURATION_MS, easing: SETTLE_EASING });
        continue;
      }
      const shiftX = placeBefore.left - placeAfter.left;
      const shiftY = placeBefore.top - placeAfter.top;
      if (Math.abs(shiftX) < 1 && Math.abs(shiftY) < 1) continue;
      // Added to any transform the host gives the item, rather than replacing it.
      itemElement.animate([{ transform: `translate(${shiftX}px, ${shiftY}px)` }, { transform: "translate(0, 0)" }], {
        duration: SETTLE_DURATION_MS,
        easing: SETTLE_EASING,
        composite: "add",
      });
    }
  });
}

/** Where each drawn item is on the page. Hidden items have no place. */
function placesOf(regionStore: RegionStore, layout: Layout): Map<string, DOMRect> {
  const placesByItemId = new Map<string, DOMRect>();
  for (const itemId of layout.order) {
    const itemElement = regionStore.elementOf(itemId);
    if (!itemElement || layout.items[itemId]?.hidden) continue;
    placesByItemId.set(itemId, itemElement.getBoundingClientRect());
  }
  return placesByItemId;
}

function prefersLessMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
