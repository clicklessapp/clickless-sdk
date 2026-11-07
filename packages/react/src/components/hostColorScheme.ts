import { createContext, useContext, useSyncExternalStore, type CSSProperties } from "react";

export type ColorScheme = "light" | "dark";
/** The panel's and bar's colours: always light, always dark, or "auto" to follow the page. */
export type ColorSchemeSetting = ColorScheme | "auto";

/** The setting AdaptiveProvider gives every panel and bar inside it that sets none of its own. */
export const ColorSchemeSettingContext = createContext<ColorSchemeSetting>("auto");

// The panel's and bar's own colours, for a page that has not set its own with
// the --clickless-* properties. Each pair reads at 4.5:1 or better.
const BUILT_IN_COLORS: Record<ColorScheme, Record<string, string>> = {
  light: {
    surface: "#fff",
    text: "#0b0b0b",
    muted: "#52514e",
    border: "#d6d3cb",
    accent: "#1c5cab",
    "accent-text": "#fff",
    danger: "#a82a2a",
  },
  dark: {
    surface: "#1f1f23",
    text: "#f2f1ee",
    muted: "#b4b2ad",
    border: "#4a4950",
    accent: "#8ab4f8",
    "accent-text": "#0b1b33",
    danger: "#ff8f85",
  },
};

/**
 * The built-in colours for a scheme, to set on the outermost element of the
 * panel or bar. Every colour there is written as the page's own
 * --clickless-<name> if it sets one, else --clickless-built-in-<name>, else the
 * light colour, so a page that maps the colours itself keeps them.
 */
export function builtInColorVariables(colorScheme: ColorScheme): CSSProperties {
  return Object.fromEntries(
    Object.entries(BUILT_IN_COLORS[colorScheme]).map(([colorName, colorValue]) => [
      `--clickless-built-in-${colorName}`,
      colorValue,
    ]),
  ) as CSSProperties;
}

// Every colour a page can set. A page that sets any of them has chosen its own
// colours, and mixing them with dark built-in ones could put light text on a
// light bubble, so the built-in colours then stay light, as they always were.
const COLOR_VARIABLES = [
  ...Object.keys(BUILT_IN_COLORS.light),
  "user-bubble",
  "user-text",
  "reply-bubble",
  "reply-text",
  "reply-border",
  "recording",
].map((colorName) => `--clickless-${colorName}`);

/**
 * The colours a panel or bar is drawn in: its own `colorScheme`, else its
 * provider's, else, for "auto" or anything not understood, the page's.
 *
 * The page's is whether it is drawn dark, so the panel can match it without
 * being told, followed as it changes. It is read from the page's own
 * background, which is how a page shows its theme whichever way it switches
 * it (a class, an attribute, the system setting). A page that paints no
 * background on <html> or <body> is read from a theme attribute or class
 * there, its `color-scheme`, or the background in the middle of the screen,
 * and the system setting only when none of them says. Light for a page that
 * sets any of the colours on its root or body. The server, and the first
 * paint, assume light unless the colours are chosen.
 */
export function usePanelColorScheme(colorScheme: ColorSchemeSetting | undefined): ColorScheme {
  const providerColorScheme = useContext(ColorSchemeSettingContext);
  const setting = colorScheme ?? providerColorScheme;
  const chosenColorScheme = setting === "light" || setting === "dark" ? setting : null;
  const hostColorScheme = useSyncExternalStore(
    chosenColorScheme ? subscribeToNothing : subscribeToColorScheme,
    chosenColorScheme ? () => chosenColorScheme : readCachedHostColorScheme,
    () => chosenColorScheme ?? "light",
  );
  return chosenColorScheme ?? hostColorScheme;
}

const subscribeToNothing = () => () => {};

// Reading the page's styles, and what is in the middle of the screen, makes
// the browser work out its layout, so it is read once and again only when the
// page may have changed, not on every render of every panel and bar. The
// changes followed are: an attribute of <html> or <body> (a theme class or
// data attribute), a fade of either's background ending, a stylesheet or
// <style> added to, removed from or changed in <head>, a linked stylesheet
// finishing loading, the class or style of the element the colour was last
// read from in the middle of the screen or of its parents (a theme can be
// switched there alone, as Ant Design's is), and the system's light or dark
// setting. A page that themes itself any other way, such as by editing a
// stylesheet's rules from script, is read again at the next of these. With
// nothing listening, nothing says when the page changes, so nothing is kept.
// Every panel and bar shares one watch on the page, so a change is read once
// however many are on screen.
let cachedHostColorScheme: ColorScheme | null = null;
const colorSchemeSubscribers = new Set<() => void>();
let stopWatchingPage: (() => void) | null = null;
let contentBackgroundObserver: MutationObserver | null = null;

function readCachedHostColorScheme(): ColorScheme {
  if (colorSchemeSubscribers.size === 0) return readHostColorScheme();
  return (cachedHostColorScheme ??= readHostColorScheme());
}

function subscribeToColorScheme(onSchemeChange: () => void): () => void {
  // Wrapped, so the same callback subscribed twice is also two subscribers.
  const colorSchemeSubscriber = () => onSchemeChange();
  colorSchemeSubscribers.add(colorSchemeSubscriber);
  stopWatchingPage ??= watchPageForColorSchemeChanges();
  return () => {
    colorSchemeSubscribers.delete(colorSchemeSubscriber);
    if (colorSchemeSubscribers.size > 0) return;
    stopWatchingPage?.();
    stopWatchingPage = null;
    cachedHostColorScheme = null;
  };
}

function forgetCachedSchemeAndTellSubscribers(): void {
  cachedHostColorScheme = null;
  for (const colorSchemeSubscriber of [...colorSchemeSubscribers]) colorSchemeSubscriber();
}

const STYLESHEET_SELECTOR = 'style, link[rel~="stylesheet" i]';

/** Whether a change in <head> adds, removes or edits a stylesheet, not, say, the <title>. */
function changesStylesheet(headMutation: MutationRecord): boolean {
  const changedTarget =
    headMutation.target instanceof Element ? headMutation.target : headMutation.target.parentElement;
  if (changedTarget?.closest(STYLESHEET_SELECTOR)) return true;
  return [...headMutation.addedNodes, ...headMutation.removedNodes].some(
    (changedNode) =>
      changedNode instanceof Element &&
      (changedNode.matches(STYLESHEET_SELECTOR) || changedNode.querySelector(STYLESHEET_SELECTOR) !== null),
  );
}

/** Starts following the changes that can turn the page light or dark. Returns how to stop. */
function watchPageForColorSchemeChanges(): () => void {
  const pageElements = [document.documentElement, document.body].filter(Boolean);
  const pageAttributeObserver = new MutationObserver(forgetCachedSchemeAndTellSubscribers);
  for (const element of pageElements) pageAttributeObserver.observe(element, { attributes: true });
  // A page whose background fades to its new colour has the old one when its
  // class changes, so the colour is read again when the fade ends.
  const onTransitionEnd = (event: TransitionEvent) => {
    if (pageElements.includes(event.target as HTMLElement) && event.propertyName === "background-color") {
      forgetCachedSchemeAndTellSubscribers();
    }
  };
  for (const element of pageElements) {
    element.addEventListener("transitionend", onTransitionEnd);
    element.addEventListener("transitioncancel", onTransitionEnd);
  }
  // A theme can arrive as a stylesheet: one added or taken away, or a linked
  // one that has only now loaded (`load` does not bubble, so it is caught on the way down).
  const pageHead = document.head;
  const stylesheetObserver = new MutationObserver((headMutations) => {
    if (headMutations.some(changesStylesheet)) forgetCachedSchemeAndTellSubscribers();
  });
  const onStylesheetLoad = (event: Event) => {
    if (event.target instanceof HTMLLinkElement) forgetCachedSchemeAndTellSubscribers();
  };
  if (pageHead) {
    stylesheetObserver.observe(pageHead, { childList: true, subtree: true, characterData: true });
    pageHead.addEventListener("load", onStylesheetLoad, true);
  }
  const systemSchemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  systemSchemeQuery?.addEventListener("change", forgetCachedSchemeAndTellSubscribers);
  contentBackgroundObserver = new MutationObserver(forgetCachedSchemeAndTellSubscribers);
  return () => {
    contentBackgroundObserver?.disconnect();
    contentBackgroundObserver = null;
    pageAttributeObserver.disconnect();
    stylesheetObserver.disconnect();
    pageHead?.removeEventListener("load", onStylesheetLoad, true);
    for (const element of pageElements) {
      element.removeEventListener("transitionend", onTransitionEnd);
      element.removeEventListener("transitioncancel", onTransitionEnd);
    }
    systemSchemeQuery?.removeEventListener("change", forgetCachedSchemeAndTellSubscribers);
  };
}

function readHostColorScheme(): ColorScheme {
  const pageElements = [document.documentElement, document.body].filter(Boolean);
  const pageSetsItsOwnColors = pageElements.some((element) => {
    const computedStyle = getComputedStyle(element);
    return COLOR_VARIABLES.some((colorVariable) => computedStyle.getPropertyValue(colorVariable).trim() !== "");
  });
  if (pageSetsItsOwnColors) return "light";
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const lightness = lightnessOf(getComputedStyle(element).backgroundColor);
    if (lightness !== null) return lightness < 0.5 ? "dark" : "light";
  }
  // A page that paints its background further in, as Ant Design's layout
  // does, may still say which theme it is in on <html> or <body>.
  const markedColorScheme = pageElements.map(colorSchemeMarkedOn).find(Boolean);
  if (markedColorScheme) return markedColorScheme;
  const declaredSchemes = getComputedStyle(document.documentElement).colorScheme ?? "";
  if (declaredSchemes.includes("dark") && !declaredSchemes.includes("light")) return "dark";
  if (declaredSchemes.includes("light") && !declaredSchemes.includes("dark")) return "light";
  const lightnessBehindContent = lightnessBehindPageContent();
  if (lightnessBehindContent !== null) return lightnessBehindContent < 0.5 ? "dark" : "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// The attributes theme switchers commonly set on <html> or <body>: two generic
// ones, Mantine's, Bootstrap's, and GitHub Primer's.
const THEME_ATTRIBUTES = [
  "data-theme",
  "data-color-scheme",
  "data-mantine-color-scheme",
  "data-bs-theme",
  "data-color-mode",
];
const DARK_CLASSES = ["dark", "dark-mode", "theme-dark"];
const LIGHT_CLASSES = ["light", "light-mode", "theme-light"];

/** The theme a page's root or body says it is in, by a theme attribute or class, if it says. */
function colorSchemeMarkedOn(element: Element): ColorScheme | null {
  for (const themeAttribute of THEME_ATTRIBUTES) {
    const themeName = element.getAttribute(themeAttribute)?.toLowerCase() ?? "";
    if (/\bdark\b/.test(themeName)) return "dark";
    if (/\blight\b/.test(themeName)) return "light";
  }
  if (DARK_CLASSES.some((className) => element.classList.contains(className))) return "dark";
  if (LIGHT_CLASSES.some((className) => element.classList.contains(className))) return "light";
  return null;
}

const CLICKLESS_UI_SELECTOR = "[data-clickless-prompt-panel], [data-clickless-prompt-bar]";

/**
 * How light the page looks in the middle of the screen, from the topmost
 * element there with a background of its own, leaving out the panel and bar
 * and anything mostly see-through, such as a modal's dimming. Null when
 * nothing there paints one. This works out the page's layout, so it is only
 * read when nothing cheaper says, and then only when the page may have changed.
 */
function lightnessBehindPageContent(): number | null {
  if (typeof document.elementsFromPoint !== "function") return null;
  const elementsAtCentre = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  for (const element of elementsAtCentre) {
    if (element === document.body || element === document.documentElement) continue;
    if (element.closest(CLICKLESS_UI_SELECTOR)) continue;
    const backgroundColor = parseColor(getComputedStyle(element).backgroundColor);
    if (backgroundColor && backgroundColor.alpha >= 0.5) {
      followClassAndStyleOf(element);
      return backgroundColor.lightness;
    }
  }
  return null;
}

/** Reads the colours again when `element` or a parent below <body> changes its class or style. */
function followClassAndStyleOf(element: Element): void {
  if (!contentBackgroundObserver) return;
  contentBackgroundObserver.disconnect();
  for (let followed: Element | null = element; followed && followed !== document.body; ) {
    contentBackgroundObserver.observe(followed, { attributes: true, attributeFilter: ["class", "style"] });
    followed = followed.parentElement;
  }
}

/**
 * How light a computed colour looks, from 0 to 1, or null when it is
 * transparent or in a form not read here. Browsers give computed colours as
 * rgb(), or in the space they were written in, such as oklch() for a page that
 * uses Tailwind 4.
 */
export function lightnessOf(cssColor: string): number | null {
  return parseColor(cssColor)?.lightness ?? null;
}

/** A computed colour's lightness and opacity, each from 0 to 1, or null as for `lightnessOf`. */
function parseColor(cssColor: string): { lightness: number; alpha: number } | null {
  const colorFunctionMatch = /^(rgba?|oklch|oklab|lch|lab|color)\((.*)\)$/i.exec(cssColor.trim());
  if (!colorFunctionMatch) return null;
  const [, colorFunction, argumentsText] = colorFunctionMatch;
  const colorArguments = argumentsText!.replace(/[,/]/g, " ").split(/\s+/).filter(Boolean);
  const alphaArgument = argumentsText!.includes("/")
    ? colorArguments.at(-1)
    : colorFunction!.toLowerCase() === "rgba"
      ? colorArguments[3]
      : undefined;
  const alpha = alphaArgument === undefined ? 1 : parseNumberOrPercentage(alphaArgument, 1);
  if (alpha === 0) return null;
  const lightness = lightnessOfColorFunction(colorFunction!.toLowerCase(), colorArguments);
  return lightness === null ? null : { lightness, alpha };
}

function lightnessOfColorFunction(colorFunction: string, colorArguments: string[]): number | null {
  switch (colorFunction) {
    case "rgb":
    case "rgba":
      return relativeLuminanceLightness(
        colorArguments.slice(0, 3).map((colorArgument) => parseNumberOrPercentage(colorArgument, 255)),
      );
    case "color":
      return colorArguments[0] === "srgb"
        ? relativeLuminanceLightness(
            colorArguments.slice(1, 4).map((colorArgument) => parseNumberOrPercentage(colorArgument, 1) * 255),
          )
        : null;
    case "oklch":
    case "oklab":
      return parseNumberOrPercentage(colorArguments[0]!, 1);
    default:
      // lab() and lch() give lightness from 0 to 100, as a number or a percentage.
      return Number.parseFloat(colorArguments[0]!) / 100;
  }
}

/** A number, or a percentage of `whole`. */
function parseNumberOrPercentage(numberText: string, wholeAmount: number): number {
  return numberText.endsWith("%") ? (Number.parseFloat(numberText) / 100) * wholeAmount : Number.parseFloat(numberText);
}

/** Perceived lightness from 0 to 1 of an sRGB colour, from its relative luminance. */
function relativeLuminanceLightness([red, green, blue]: number[]): number {
  const linearChannel = (channel: number) => {
    const channelFraction = channel / 255;
    return channelFraction <= 0.04045 ? channelFraction / 12.92 : ((channelFraction + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linearChannel(red!) + 0.7152 * linearChannel(green!) + 0.0722 * linearChannel(blue!);
  // CIE lightness, so 0.5 means mid-grey as it looks, not as it measures.
  return (luminance <= 216 / 24389 ? (luminance * 24389) / 27 : 116 * Math.cbrt(luminance) - 16) / 100;
}
