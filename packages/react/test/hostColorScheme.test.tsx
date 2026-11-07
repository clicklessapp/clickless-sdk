// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lightnessOf, usePanelColorScheme } from "../src/components/hostColorScheme";
import { AdaptiveProvider, PromptBar, PromptPanel, type ColorSchemeSetting } from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
  for (const attribute of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attribute.name);
  document.body.removeAttribute("class");
  document.querySelectorAll("[data-test-layout]").forEach((layoutElement) => layoutElement.remove());
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  document.head.querySelectorAll("style, link, title, meta").forEach((headElement) => headElement.remove());
});

function ColorSchemeReader() {
  return <span>{usePanelColorScheme(undefined)}</span>;
}

async function afterThePageChanges(changePage: () => void): Promise<void> {
  await act(async () => {
    changePage();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function addDarkStylesheet(): void {
  const darkTheme = document.createElement("style");
  darkTheme.textContent = "body { background-color: rgb(12, 12, 14); }";
  document.head.append(darkTheme);
}

describe("how light a page's background is", () => {
  it("is read from the forms browsers give computed colours in", () => {
    expect(lightnessOf("rgb(255, 255, 255)")).toBeCloseTo(1);
    expect(lightnessOf("rgb(10, 10, 10)")).toBeLessThan(0.1);
    expect(lightnessOf("oklch(0.145 0 0)")).toBeCloseTo(0.145);
    expect(lightnessOf("oklch(98.5% 0 0)")).toBeCloseTo(0.985);
    expect(lightnessOf("lab(20 0 0)")).toBeCloseTo(0.2);
    expect(lightnessOf("color(srgb 1 1 1)")).toBeCloseTo(1);
  });

  it("is unknown when the background is transparent or in a form not read", () => {
    expect(lightnessOf("rgba(0, 0, 0, 0)")).toBeNull();
    expect(lightnessOf("oklch(0.2 0 0 / 0)")).toBeNull();
    expect(lightnessOf("transparent")).toBeNull();
  });
});

describe("the prompt bar's colours", () => {
  it("follow the page into dark and back, unless the page sets its own", async () => {
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    const promptBarElement = () => renderResult.container.querySelector<HTMLElement>("[data-clickless-prompt-bar]")!;
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-surface")).toBe("#fff");

    await act(async () => {
      document.body.style.backgroundColor = "rgb(12, 12, 14)";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-surface")).toBe("#1f1f23");
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-text")).toBe("#f2f1ee");

    await act(async () => {
      document.body.style.backgroundColor = "rgb(250, 250, 250)";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-surface")).toBe("#fff");
  });

  it("stay as the page chose when it sets any colour of its own, so the two are never mixed", async () => {
    document.documentElement.style.setProperty("--clickless-reply-bubble", "#f0fdfa");
    document.body.style.backgroundColor = "rgb(12, 12, 14)";
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    const promptBarElement = renderResult.container.querySelector<HTMLElement>("[data-clickless-prompt-bar]")!;
    expect(promptBarElement.style.getPropertyValue("--clickless-built-in-text")).toBe("#0b0b0b");
  });

  it("are read again when the page's background finishes fading to its new colour", async () => {
    const pageStylesheet = document.head.appendChild(document.createElement("style"));
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    const promptBarElement = () => renderResult.container.querySelector<HTMLElement>("[data-clickless-prompt-bar]")!;
    await act(async () => {
      // The colour lands with no change to the page's attributes or its <head>, as at the end of a fade.
      pageStylesheet.sheet!.insertRule("body { background-color: rgb(12, 12, 14); }");
      const fadeEnded = new Event("transitionend") as TransitionEvent;
      Object.defineProperty(fadeEnded, "propertyName", { value: "background-color" });
      document.body.dispatchEvent(fadeEnded);
    });
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-surface")).toBe("#1f1f23");
  });

  it("are read again when the page adds a stylesheet that turns it dark", async () => {
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    const promptBarElement = () => renderResult.container.querySelector<HTMLElement>("[data-clickless-prompt-bar]")!;
    await act(async () => {
      const darkTheme = document.createElement("style");
      darkTheme.textContent = "body { background-color: rgb(12, 12, 14); }";
      document.head.append(darkTheme);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-surface")).toBe("#1f1f23");
  });

  it("are read again when a linked stylesheet finishes loading", async () => {
    const linkedTheme = document.head.appendChild(document.createElement("link"));
    linkedTheme.rel = "stylesheet";
    const pageStylesheet = document.head.appendChild(document.createElement("style"));
    const renderResult = render(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    const promptBarElement = () => renderResult.container.querySelector<HTMLElement>("[data-clickless-prompt-bar]")!;
    await act(async () => {
      // Stands in for the linked sheet's rules, which arrive with no change to <head>.
      pageStylesheet.sheet!.insertRule("body { background-color: rgb(12, 12, 14); }");
      linkedTheme.dispatchEvent(new Event("load"));
    });
    expect(promptBarElement().style.getPropertyValue("--clickless-built-in-surface")).toBe("#1f1f23");
  });
});

describe("following the page's colour scheme", () => {
  it("reads the page's styles once for a change, however many panels and bars are on screen", async () => {
    const styleReadSpy = vi.spyOn(window, "getComputedStyle");
    const oneReaderRender = render(<ColorSchemeReader />);
    styleReadSpy.mockClear();
    await afterThePageChanges(addDarkStylesheet);
    const styleReadsForOneReader = styleReadSpy.mock.calls.length;
    expect(styleReadsForOneReader).toBeGreaterThan(0);
    expect(oneReaderRender.container.textContent).toBe("dark");
    cleanup();
    document.head.querySelectorAll("style").forEach((styleElement) => styleElement.remove());

    const twoReadersRender = render(
      <>
        <ColorSchemeReader />
        <ColorSchemeReader />
      </>,
    );
    styleReadSpy.mockClear();
    await afterThePageChanges(addDarkStylesheet);
    expect(styleReadSpy.mock.calls.length).toBe(styleReadsForOneReader);
    expect(twoReadersRender.container.textContent).toBe("darkdark");
  });

  it("keeps what it read when only the page's title or other <head> content changes", async () => {
    const styleReadSpy = vi.spyOn(window, "getComputedStyle");
    const renderResult = render(<ColorSchemeReader />);
    styleReadSpy.mockClear();
    await afterThePageChanges(() => {
      document.title = "Inbox";
      document.head.append(Object.assign(document.createElement("meta"), { name: "description" }));
    });
    await afterThePageChanges(() => {
      document.title = "Inbox (2)";
    });
    renderResult.rerender(<ColorSchemeReader />);
    expect(styleReadSpy).not.toHaveBeenCalled();
  });

  it("stops watching the page when the last panel or bar goes", () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const firstReader = render(<ColorSchemeReader />);
    const observedForOneReader = observeSpy.mock.calls.length;
    const secondReader = render(<ColorSchemeReader />);
    expect(observeSpy.mock.calls.length).toBe(observedForOneReader);

    firstReader.unmount();
    expect(disconnectSpy).not.toHaveBeenCalled();
    secondReader.unmount();
    const disconnectedObservers = new Set(disconnectSpy.mock.contexts);
    expect([...new Set(observeSpy.mock.contexts)].every((observer) => disconnectedObservers.has(observer))).toBe(true);
  });
});

/** Makes the system setting dark, so that a light result shows the page was followed instead. */
function systemSettingIsDark(): void {
  vi.stubGlobal(
    "matchMedia",
    (mediaQuery: string) =>
      ({
        matches: mediaQuery === "(prefers-color-scheme: dark)",
        media: mediaQuery,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

/**
 * A layout that paints its own background below a transparent <body>, as Ant
 * Design's does, and that the middle of the screen is over. jsdom works out no
 * layout, so what is under a point is the panel or bar first, then the layout.
 */
function addLayoutPaintedBelowBody(layoutClass: string): HTMLElement {
  const layoutStylesheet = document.createElement("style");
  layoutStylesheet.textContent =
    ".layout-dark { background-color: rgb(20, 20, 20); } .layout-light { background-color: rgb(245, 245, 245); }" +
    " .modal-dimming { background-color: rgba(0, 0, 0, 0.45); }";
  document.head.append(layoutStylesheet);
  const layoutElement = document.createElement("section");
  layoutElement.dataset.testLayout = "";
  layoutElement.className = layoutClass;
  const contentElement = layoutElement.appendChild(document.createElement("main"));
  const dimmingElement = document.createElement("div");
  dimmingElement.dataset.testLayout = "";
  dimmingElement.className = "modal-dimming";
  document.body.append(layoutElement, dimmingElement);
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [
      ...document.querySelectorAll("[data-clickless-prompt-bar], [data-clickless-prompt-bar] *"),
      dimmingElement,
      contentElement,
      layoutElement,
      document.body,
      document.documentElement,
    ],
  });
  return layoutElement;
}

function renderPromptBar(
  promptBarProps: { colorScheme?: ColorSchemeSetting } = {},
  providerColorScheme?: ColorSchemeSetting,
) {
  const renderResult = render(
    <AdaptiveProvider userId="user-1" {...(providerColorScheme && { colorScheme: providerColorScheme })}>
      <PromptBar regionId="dashboard" {...promptBarProps} />
    </AdaptiveProvider>,
  );
  const surfaceColor = () =>
    renderResult.container
      .querySelector<HTMLElement>("[data-clickless-prompt-bar]")!
      .style.getPropertyValue("--clickless-built-in-surface");
  return { ...renderResult, surfaceColor };
}

const LIGHT_SURFACE = "#fff";
const DARK_SURFACE = "#1f1f23";

describe("a page that paints no background on <html> or <body>", () => {
  it("is read from the background behind the middle of the screen, past the bar and a modal's dimming", () => {
    systemSettingIsDark();
    addLayoutPaintedBelowBody("layout-light");
    expect(renderPromptBar().surfaceColor()).toBe(LIGHT_SURFACE);
    cleanup();
    document.querySelectorAll("[data-test-layout]").forEach((layoutElement) => layoutElement.remove());
    addLayoutPaintedBelowBody("layout-dark");
    expect(renderPromptBar().surfaceColor()).toBe(DARK_SURFACE);
  });

  it("follows the layout when only its class changes, as when Ant Design switches theme", async () => {
    const layoutElement = addLayoutPaintedBelowBody("layout-light");
    const { surfaceColor } = renderPromptBar();
    expect(surfaceColor()).toBe(LIGHT_SURFACE);
    await afterThePageChanges(() => {
      layoutElement.className = "layout-dark";
    });
    expect(surfaceColor()).toBe(DARK_SURFACE);
    await afterThePageChanges(() => {
      layoutElement.className = "layout-light";
    });
    expect(surfaceColor()).toBe(LIGHT_SURFACE);
  });

  it("is read from `color-scheme: dark` on the page", () => {
    const pageStylesheet = document.createElement("style");
    pageStylesheet.textContent = ":root { color-scheme: dark; }";
    document.head.append(pageStylesheet);
    expect(renderPromptBar().surfaceColor()).toBe(DARK_SURFACE);
  });

  it("is read from a theme attribute or class on <html>, ahead of the system setting", async () => {
    systemSettingIsDark();
    document.documentElement.setAttribute("data-mantine-color-scheme", "light");
    const { surfaceColor } = renderPromptBar();
    expect(surfaceColor()).toBe(LIGHT_SURFACE);
    await afterThePageChanges(() => document.documentElement.setAttribute("data-mantine-color-scheme", "dark"));
    expect(surfaceColor()).toBe(DARK_SURFACE);
    await afterThePageChanges(() => {
      document.documentElement.removeAttribute("data-mantine-color-scheme");
      document.documentElement.setAttribute("data-bs-theme", "light");
    });
    expect(surfaceColor()).toBe(LIGHT_SURFACE);
    await afterThePageChanges(() => {
      document.documentElement.removeAttribute("data-bs-theme");
      document.documentElement.className = "dark";
    });
    expect(surfaceColor()).toBe(DARK_SURFACE);
  });

  it("follows the system setting when nothing on the page says", () => {
    systemSettingIsDark();
    expect(renderPromptBar().surfaceColor()).toBe(DARK_SURFACE);
  });
});

describe("choosing the colours with `colorScheme`", () => {
  it("overrides what the page looks like, on the bar, the panel or the provider", () => {
    document.body.style.backgroundColor = "rgb(12, 12, 14)";
    expect(renderPromptBar({ colorScheme: "light" }).surfaceColor()).toBe(LIGHT_SURFACE);
    cleanup();
    expect(renderPromptBar({}, "light").surfaceColor()).toBe(LIGHT_SURFACE);
    cleanup();
    expect(renderPromptBar({ colorScheme: "auto" }, "light").surfaceColor()).toBe(DARK_SURFACE);
    cleanup();
    document.body.style.backgroundColor = "rgb(250, 250, 250)";
    expect(renderPromptBar({ colorScheme: "dark" }, "light").surfaceColor()).toBe(DARK_SURFACE);
    cleanup();
    const panelRender = render(
      <AdaptiveProvider userId="user-1">
        <PromptPanel regionId="dashboard" defaultOpen colorScheme="dark" />
      </AdaptiveProvider>,
    );
    const panelElement = panelRender.container.querySelector<HTMLElement>("[data-clickless-prompt-panel]")!;
    expect(panelElement.style.getPropertyValue("--clickless-built-in-surface")).toBe(DARK_SURFACE);
  });

  it("switches when the host's own theme state changes, and reads nothing from the page while chosen", () => {
    document.body.style.backgroundColor = "rgb(250, 250, 250)";
    const styleReadSpy = vi.spyOn(window, "getComputedStyle");
    const renderResult = renderPromptBar({ colorScheme: "dark" });
    expect(renderResult.surfaceColor()).toBe(DARK_SURFACE);
    renderResult.rerender(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" colorScheme="light" />
      </AdaptiveProvider>,
    );
    expect(renderResult.surfaceColor()).toBe(LIGHT_SURFACE);
    expect(styleReadSpy).not.toHaveBeenCalled();
    renderResult.rerender(
      <AdaptiveProvider userId="user-1">
        <PromptBar regionId="dashboard" colorScheme="auto" />
      </AdaptiveProvider>,
    );
    expect(renderResult.surfaceColor()).toBe(LIGHT_SURFACE);
    expect(styleReadSpy).toHaveBeenCalled();
  });
});

describe("rendering on the server", () => {
  it.each([
    ["follows the page", undefined, LIGHT_SURFACE, DARK_SURFACE],
    ["is chosen", "dark", DARK_SURFACE, DARK_SURFACE],
  ] as const)(
    "draws light first unless the colours are chosen, and hydrates with no mismatch when it %s",
    async (_, colorScheme, serverSurface, hydratedSurface) => {
      document.body.style.backgroundColor = "rgb(12, 12, 14)";
      const promptBar = (
        <AdaptiveProvider userId="user-1">
          <PromptBar regionId="dashboard" {...(colorScheme && { colorScheme })} />
        </AdaptiveProvider>
      );
      const serverContainer = document.body.appendChild(document.createElement("div"));
      serverContainer.dataset.testLayout = "";
      serverContainer.innerHTML = renderToString(promptBar);
      const barElement = () => serverContainer.querySelector<HTMLElement>("[data-clickless-prompt-bar]")!;
      expect(barElement().style.getPropertyValue("--clickless-built-in-surface")).toBe(serverSurface);

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const hydrationErrors: unknown[] = [];
      let hydratedRoot: ReturnType<typeof hydrateRoot> | undefined;
      await act(async () => {
        hydratedRoot = hydrateRoot(serverContainer, promptBar, {
          onRecoverableError: (hydrationError) => hydrationErrors.push(hydrationError),
        });
      });
      expect(barElement().style.getPropertyValue("--clickless-built-in-surface")).toBe(hydratedSurface);
      expect(hydrationErrors).toEqual([]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      act(() => hydratedRoot!.unmount());
    },
  );
});
