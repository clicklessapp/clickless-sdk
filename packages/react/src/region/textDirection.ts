import type { TextDirection } from "../engine/engineClient";

/**
 * Which way the page reads where `element` is drawn, or at its root without
 * one. Read from the browser, so it holds however the page set it: a `dir`
 * attribute on the element or a parent, or a stylesheet's `direction`. A
 * `lang` attribute alone does not change it.
 */
export function textDirectionAt(element: Element | null | undefined): TextDirection {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "ltr";
  return getComputedStyle(element ?? document.documentElement).direction === "rtl" ? "rtl" : "ltr";
}

/** The direction as a plan request carries it: only when the page reads right to left. */
export function textDirectionToPlanWith(element: Element | null | undefined): { textDirection?: TextDirection } {
  return textDirectionAt(element) === "rtl" ? { textDirection: "rtl" } : {};
}
