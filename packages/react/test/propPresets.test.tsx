// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, propPresets, useAdaptiveRegion } from "../src/index";

afterEach(cleanup);

// The model learns what a preset's props mean only from these sentences, so a
// change to one is a change to how every application using it is understood.
describe("the sentence each preset adds", () => {
  it.each([
    [
      propPresets.density(),
      "density is how much room each row or entry takes: compact fits more on screen, comfortable leaves more space.",
    ],
    [
      propPresets.stripes(),
      "stripes turns the colouring of every other row on or off, and stripeColour is the colour used. " +
        "Asking for a stripe colour turns stripes on.",
    ],
    [
      propPresets.stripes({ palette: { grey: "#f3f2ee", red: "#b91c1c" } }),
      "stripes colours every other row grey or red, or is off for plain rows.",
    ],
    [
      propPresets.colours(),
      "background is the colour behind the whole component and textColour the colour of its text. " +
        "Text turns black or white wherever textColour would be hard to read on the background.",
    ],
    [propPresets.textSize(), "textSize is the size of the text in pixels."],
    [propPresets.textStyle(), "textStyle makes the text bold, italic or both, or keeps it regular."],
    [
      propPresets.toggle({ shows: "the line comparing it with last month" }).named("trend"),
      "trend shows or hides the line comparing it with last month.",
    ],
    [
      propPresets
        .choice({ values: ["day", "week", "month"], initial: "week", means: "how much of the calendar shows at once" })
        .named("view"),
      "view is how much of the calendar shows at once.",
    ],
    [
      propPresets.number({ min: 0, max: 24, initial: 6, means: "the corner radius in pixels" }).named("corners"),
      "corners is the corner radius in pixels.",
    ],
    [
      propPresets.colour({ initial: "#1c5cab", means: "the colour of the bars" }).named("barColour"),
      "barColour is the colour of the bars.",
    ],
    [
      propPresets
        .visibleList({ values: ["number", "client", "amount"], min: 1, means: "the columns that show, left to right" })
        .named("columns"),
      "columns lists the columns that show, left to right.",
    ],
    [propPresets.accent({ marks: "the selected entry" }), "accent is the colour that marks the selected entry."],
    [
      propPresets.accent({ marks: "the primary buttons", textOn: true }),
      "accent is the colour that marks the primary buttons. Text on it turns black or white to stay readable.",
    ],
    [
      propPresets.colour({ initial: "#ffe3e3", means: "the colour of the coloured rows", textOn: true }).named("rowColour"),
      "rowColour is the colour of the coloured rows. Text on it turns black or white to stay readable.",
    ],
    [propPresets.count({ of: "customers", max: 8, initial: 5 }), "count is how many customers show."],
    [propPresets.count({ max: 8, initial: 5 }), "count is how many entries show."],
    [
      propPresets.highlight({
        entries: "customers",
        top: { max: 8 },
        above: { measure: "amount invoiced in pounds", max: 20000 },
      }),
      "highlightTop is how many customers are coloured, counted from the top. " +
        "highlightAbove colours the customers whose amount invoiced in pounds is more than that. " +
        "Use one or the other; 0 turns either off. " +
        "highlightColour is the colour of highlighted customers; their text turns black or white to stay readable.",
    ],
    [
      propPresets.highlight({ entries: "payments", above: { measure: "size in pounds" } }),
      "highlightAbove colours the payments whose size in pounds is more than that. 0 turns it off. " +
        "highlightColour is the colour of highlighted payments; their text turns black or white to stay readable.",
    ],
  ])("%#", (preset, expectedSentence) => {
    expect(preset.description).toBe(expectedSentence);
    // Every prop the preset declares is named in its sentence, and has a starting value.
    for (const propName of Object.keys(preset.capabilities)) {
      expect(preset.description).toContain(propName);
      expect(preset.defaults).toHaveProperty(propName);
    }
  });
});

describe("reading a preset's value", () => {
  it("gives the stripe colour, or null when stripes are off", () => {
    const ownColourStripes = propPresets.stripes({ colour: "#dddddd" });
    expect(ownColourStripes.read({ stripes: "on", stripeColour: "#1c5cab" })).toEqual({
      colour: "#1c5cab",
      textColour: "#ffffff",
    });
    expect(ownColourStripes.read({ stripes: "off", stripeColour: "#1c5cab" })).toBeNull();
    const paletteStripes = propPresets.stripes({ palette: { red: "#b91c1c", yellow: "#ffff00" } });
    expect(paletteStripes.read({ stripes: "red" })).toEqual({ colour: "#b91c1c", textColour: "#ffffff" });
    expect(paletteStripes.read({ stripes: "yellow" })).toEqual({ colour: "#ffff00", textColour: "#000000" });
    expect(paletteStripes.read({ stripes: "off" })).toBeNull();
  });

  it("refuses a starting stripe colour the palette does not have", () => {
    expect(() => propPresets.stripes({ palette: { red: "#b91c1c" }, initial: "blue" })).toThrow(
      'the initial value, "blue", must be "off" or one of the palette\'s names',
    );
  });

  it("turns text black or white where the chosen colour would be hard to read", () => {
    const shownColours = propPresets.colours().read({ background: "#0b0b0b", textColour: "#111111" });
    expect(shownColours).toEqual({
      background: "#0b0b0b",
      textColour: "#ffffff",
      chosenTextColour: "#111111",
      style: { background: "#0b0b0b", color: "#ffffff" },
    });
  });

  it("gives a chosen accent or colour with black or white text readable on it", () => {
    const primaryButtons = propPresets.accent({ marks: "the primary buttons", textOn: true });
    expect(primaryButtons.read({})).toEqual({ colour: "#1c5cab", textColour: "#ffffff" });
    expect(primaryButtons.read({ accent: "#ffa500" })).toEqual({ colour: "#ffa500", textColour: "#000000" });
    expect(primaryButtons.read({ accent: "#ffffff" })).toEqual({ colour: "#ffffff", textColour: "#000000" });
    expect(primaryButtons.read({ accent: "#00008b" })).toEqual({ colour: "#00008b", textColour: "#ffffff" });
    const rowColour = propPresets.colour({ initial: "#ffe3e3", means: "the colour of the coloured rows" }).named("rowColour");
    expect(rowColour.read({ rowColour: "#ffff00" })).toEqual({ colour: "#ffff00", textColour: "#000000" });
    expect(rowColour.read({ rowColour: "#b91c1c" })).toEqual({ colour: "#b91c1c", textColour: "#ffffff" });
  });

  it("keeps a chosen text colour where it reads, and corrects it where it does not", () => {
    const cardColours = propPresets.colours();
    expect(cardColours.read({ background: "#ffffff", textColour: "#b91c1c" }).textColour).toBe("#b91c1c");
    expect(cardColours.read({ background: "#ffa500", textColour: "#ffffff" })).toMatchObject({
      textColour: "#000000",
      chosenTextColour: "#ffffff",
    });
    expect(cardColours.read({ background: "#ffffff", textColour: "#ffff00" }).textColour).toBe("#000000");
  });

  it("tells the planner what is drawn on a colour and behind it", () => {
    expect(
      propPresets.accent({ marks: "the primary buttons", textOn: true, against: "#ffffff" }).capabilities.accent,
    ).toEqual({ type: "color", textOn: {}, against: "#ffffff" });
    expect(propPresets.accent({ marks: "the progress gauge" }).capabilities.accent).toEqual({ type: "color" });
    expect(
      propPresets.colour({ initial: "#ffe3e3", means: "the row colour", textOn: true }).named("rowColour").capabilities
        .rowColour,
    ).toEqual({ type: "color", textOn: {} });
    expect(propPresets.colours().capabilities.background).toEqual({ type: "color", textOn: { colorProp: "textColour" } });
    expect(propPresets.highlight({ top: true }).capabilities.highlightColour).toEqual({ type: "color", textOn: {} });
    expect(propPresets.stripes({ textOn: true }).capabilities.stripeColour).toEqual({ type: "color", textOn: {} });
  });

  it("refuses a colour behind it that is not written as #rrggbb", () => {
    expect(() => propPresets.accent({ marks: "the primary buttons", against: "white" })).toThrow(
      'accent(): against, "white", must be written as #rrggbb, such as "#ffffff".',
    );
  });

  it("gives a highlighted entry's style, and none for the others", () => {
    const highlight = propPresets
      .highlight({ top: true, above: { measure: "amount in pounds" } })
      .read({ highlightTop: 1, highlightAbove: 1000, highlightColour: "#0b0b0b" });
    expect(highlight.styleFor(0, 5)).toEqual({ background: "#0b0b0b", color: "#ffffff" });
    expect(highlight.styleFor(4, 1500)).toEqual({ background: "#0b0b0b", color: "#ffffff" });
    expect(highlight.styleFor(4, 500)).toBeUndefined();
  });

  it("gives bold and italic separately", () => {
    const badgeTextStyle = propPresets.textStyle();
    expect(badgeTextStyle.read({ textStyle: "bold italic" })).toEqual({ bold: true, italic: true });
    expect(badgeTextStyle.read({ textStyle: "italic" })).toEqual({ bold: false, italic: true });
    expect(badgeTextStyle.read({})).toEqual({ bold: false, italic: false });
  });

  it("highlights by position, by a measure, or neither", () => {
    const customerHighlight = propPresets.highlight({
      entries: "customers",
      top: true,
      above: { measure: "amount invoiced in pounds" },
    });
    const byPosition = customerHighlight.read({ highlightTop: 2, highlightAbove: 0, highlightColour: "#0b0b0b" });
    expect([0, 1, 2].map((position) => byPosition.isHighlighted(position, 1))).toEqual([true, true, false]);
    expect(byPosition.textColour).toBe("#ffffff");
    const byAmount = customerHighlight.read({ highlightTop: 0, highlightAbove: 10000 });
    expect(byAmount.isHighlighted(5, 11000)).toBe(true);
    expect(byAmount.isHighlighted(0, 9000)).toBe(false);
    expect(customerHighlight.read({}).isHighlighted(0, 99999)).toBe(false);
    expect(() => propPresets.highlight({ entries: "customers" })).toThrow("give top, above, below, kinds or a mix");
  });

  it("highlights the entries of chosen kinds, on their own or alongside a measure", () => {
    const ticketHighlight = propPresets.highlight({
      entries: "tickets",
      kinds: { of: "priorities", values: ["low", "medium", "high", "urgent"] },
    });
    expect(ticketHighlight.description).toBe(
      "highlightKinds lists the priorities whose tickets are coloured, from low, medium, high, urgent; " +
        "an empty list turns it off. " +
        "highlightColour is the colour of highlighted tickets; their text turns black or white to stay readable.",
    );
    expect(ticketHighlight.capabilities.highlightKinds).toEqual({
      values: ["low", "medium", "high", "urgent"],
      multiple: true,
    });
    expect(ticketHighlight.defaults.highlightKinds).toEqual([]);
    const urgent = ticketHighlight.read({ highlightKinds: ["urgent", "not a priority"], highlightColour: "#d3f9d8" });
    expect(urgent.styleFor(3, { kind: "urgent" })).toEqual({ background: "#d3f9d8", color: "#000000" });
    expect(urgent.styleFor(0, { kind: "low" })).toBeUndefined();
    expect(urgent.styleFor(0)).toBeUndefined();
    expect(ticketHighlight.read({}).isHighlighted(0, { kind: "urgent" })).toBe(false);

    const deliveryHighlight = propPresets.highlight({
      entries: "deliveries",
      below: { measure: "due time in hours", max: 24 },
      kinds: { of: "statuses", values: ["scheduled", "delivered", "cancelled"] },
    });
    expect(deliveryHighlight.description).toContain(
      "0 turns it off. highlightKinds lists the statuses whose deliveries are coloured, from scheduled, delivered, cancelled; " +
        "an empty list turns it off. " +
        "highlightKinds adds to the others: an entry of a chosen kind is coloured whatever they say.",
    );
    expect(
      propPresets.highlight({
        top: true,
        above: { measure: "price in pounds" },
        kinds: { of: "categories", values: ["food", "drink"] },
      }).description,
    ).toBe(
      "highlightTop is how many entries are coloured, counted from the top. " +
        "highlightAbove colours the entries whose price in pounds is more than that. " +
        "Use one or the other; 0 turns either off. " +
        "highlightKinds lists the categories whose entries are coloured, from food, drink; an empty list turns it off. " +
        "highlightKinds adds to the others: an entry of a chosen kind is coloured whatever they say. " +
        "highlightColour is the colour of highlighted entries; their text turns black or white to stay readable.",
    );
    const earlyOrCancelled = deliveryHighlight.read({ highlightBelow: 10, highlightKinds: ["cancelled"] });
    expect(earlyOrCancelled.isHighlighted(0, { measure: 9, kind: "scheduled" })).toBe(true);
    expect(earlyOrCancelled.isHighlighted(0, { measure: 15, kind: "cancelled" })).toBe(true);
    expect(earlyOrCancelled.isHighlighted(0, { measure: 15, kind: "delivered" })).toBe(false);
    expect(earlyOrCancelled.isHighlighted(0, 9)).toBe(true);
    expect(() => propPresets.highlight({ kinds: { of: "statuses", values: [] } })).toThrow("at least one value");
  });

  it("highlights the entries below an amount, alongside those above it", () => {
    const deliveryHighlight = propPresets.highlight({
      entries: "deliveries",
      above: { measure: "due time in hours from midnight", max: 24 },
      below: { measure: "due time in hours from midnight", max: 24 },
    });
    expect(deliveryHighlight.description).toBe(
      "highlightAbove colours the deliveries whose due time in hours from midnight is more than that. " +
        "highlightBelow colours the deliveries whose due time in hours from midnight is less than that. " +
        "0 turns either off. " +
        "highlightColour is the colour of highlighted deliveries; their text turns black or white to stay readable.",
    );
    expect(
      propPresets.highlight({ top: true, above: { measure: "price in pounds" }, below: { measure: "price in pounds" } })
        .description,
    ).toBe(
      "highlightTop is how many entries are coloured, counted from the top. " +
        "highlightAbove colours the entries whose price in pounds is more than that. " +
        "highlightBelow colours the entries whose price in pounds is less than that. " +
        "Use highlightTop or the others, not both; 0 turns any of them off. " +
        "highlightColour is the colour of highlighted entries; their text turns black or white to stay readable.",
    );
    expect(deliveryHighlight.capabilities.highlightBelow).toEqual({ type: "number", min: 0, max: 24 });
    const beforeTwo = deliveryHighlight.read({ highlightBelow: 14 });
    expect([9, 13.5, 14, 16].map((hour) => beforeTwo.isHighlighted(0, hour))).toEqual([true, true, false, false]);
    const outsideCore = deliveryHighlight.read({ highlightBelow: 10, highlightAbove: 16 });
    expect([9, 12, 17].map((hour) => outsideCore.isHighlighted(0, hour))).toEqual([true, false, true]);
    expect(deliveryHighlight.read({ highlightBelow: 30 }).isHighlighted(0, 9)).toBe(false);
    expect(() =>
      propPresets.highlight({ above: { measure: "price in pounds" }, below: { measure: "stock" } }),
    ).toThrow("give them the same measure");
  });

  it("puts no upper limit on a highlight unless given one", () => {
    const unlimited = propPresets.highlight({ entries: "payments", top: true, above: { measure: "size in pounds" } });
    expect(unlimited.capabilities.highlightTop).toEqual({
      type: "number",
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
    });
    expect(unlimited.capabilities.highlightAbove).toEqual({ type: "number", min: 0, max: Number.MAX_SAFE_INTEGER });
    // An amount need not be whole, and may be far beyond anything in the list today.
    expect(unlimited.read({ highlightAbove: 0.5 }).isHighlighted(9, 0.75)).toBe(true);
    expect(unlimited.read({ highlightAbove: 5_000_000 }).isHighlighted(9, 4_999_999)).toBe(false);
    const limited = propPresets.highlight({ entries: "customers", top: { max: 8 }, above: { measure: "amount", max: 100 } });
    expect(limited.capabilities.highlightTop).toMatchObject({ max: 8 });
    expect(limited.read({ highlightAbove: 500 }).isHighlighted(0, 1000)).toBe(false);
  });

  it("falls back to the starting value for a missing or unexpected value", () => {
    expect(propPresets.density({ initial: "compact" }).read({ density: "roomy" })).toBe("compact");
    expect(propPresets.textSize({ initial: 15 }).read({ textSize: 99 })).toBe(15);
    expect(propPresets.count({ of: "months", max: 12, initial: 6 }).read({ count: 2.5 })).toBe(6);
    expect(propPresets.toggle({ shows: "the time of each event", initial: false }).named("times").read({})).toBe(false);
    const view = propPresets.choice({ values: ["day", "week"], initial: "week", means: "the view" }).named("view");
    expect(view.read({ view: "year" })).toBe("week");
    const corners = propPresets.number({ min: 0, max: 24, initial: 6, means: "corners" }).named("corners");
    expect(corners.read({ corners: 30 })).toBe(6);
    expect(corners.read({ corners: 2.5 })).toBe(6);
    const columns = propPresets
      .visibleList({ values: ["number", "client"], min: 1, means: "the columns" })
      .named("columns");
    expect(columns.read({ columns: ["client", "number"] })).toEqual(["client", "number"]);
    expect(columns.read({ columns: [] })).toEqual(["number", "client"]);
    expect(columns.read({ columns: ["number", "po"] })).toEqual(["number", "client"]);
    expect(propPresets.accent({ marks: "today", colour: "#b91c1c" }).read({ accent: "red" })).toEqual({
      colour: "#b91c1c",
      textColour: "#ffffff",
    });
  });
});

describe("<Adaptive presets>", () => {
  function renderTable(adaptiveProps: Partial<Parameters<typeof Adaptive>[0]>) {
    let regionApi!: ReturnType<typeof useAdaptiveRegion>;
    function RegionApiProbe() {
      regionApi = useAdaptiveRegion("tables");
      return null;
    }
    render(
      <AdaptiveProvider userId="user-1">
        <RegionApiProbe />
        <AdaptiveRegion id="tables" version="1">
          <Adaptive id="invoices" kind="table" title="Invoices" defaults={{ w: 12, h: 4 }} {...adaptiveProps}>
            {(currentProps) => <span>{JSON.stringify(currentProps)}</span>}
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    return () => regionApi;
  }

  it("declares the presets' props, and adds their sentences to the component's description", () => {
    const regionApi = renderTable({
      description: "Every invoice sent this year",
      presets: {
        columns: propPresets.visibleList({ values: ["number", "client"], means: "the columns that show" }),
        rows: propPresets.density({ initial: "compact" }),
        text: propPresets.textSize({ min: 12, max: 18 }),
      },
    });
    const invoicesComponent = regionApi().manifest!.components.find((component) => component.id === "invoices")!;
    expect(invoicesComponent.description).toBe(
      "Every invoice sent this year. " +
        "columns lists the columns that show. " +
        "density is how much room each row or entry takes: compact fits more on screen, comfortable leaves more space. " +
        "textSize is the size of the text in pixels.",
    );
    expect(invoicesComponent.capabilities.props).toEqual({
      columns: { values: ["number", "client"], multiple: true },
      density: { values: ["comfortable", "compact"] },
      textSize: { type: "number", min: 12, max: 18, integer: true },
    });
    expect(invoicesComponent.defaults.props).toEqual({
      columns: ["number", "client"],
      density: "compact",
      textSize: 14,
    });
  });

  it("hands each preset's current value to the render function, under its name", () => {
    render(
      <AdaptiveProvider userId="user-1">
        <AdaptiveRegion id="lists" version="1">
          <Adaptive
            id="customers"
            defaults={{ w: 6, h: 4 }}
            presets={{
              shown: propPresets.count({ of: "customers", max: 8, initial: 3 }),
              ranks: propPresets.toggle({ shows: "each customer's position" }),
            }}
          >
            {(currentProps, adaptiveControls, presetValues) => {
              // Typed from the presets given: a number and a boolean.
              const shownCount: number = presetValues.shown;
              const showsRanks: boolean = presetValues.ranks;
              return <output>{`${shownCount} ${showsRanks}`}</output>;
            }}
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    expect(document.querySelector("output")!.textContent).toBe("3 true");
  });

  it("names a custom preset's prop after its key, and types its value from the values given", () => {
    let regionApi!: ReturnType<typeof useAdaptiveRegion>;
    function RegionApiProbe() {
      regionApi = useAdaptiveRegion("calendar");
      return null;
    }
    render(
      <AdaptiveProvider userId="user-1">
        <RegionApiProbe />
        <AdaptiveRegion id="calendar" version="1">
          <Adaptive
            id="events"
            defaults={{ w: 6, h: 4 }}
            presets={{
              view: propPresets.choice({ values: ["day", "week"], initial: "week", means: "how much shows at once" }),
            }}
          >
            {(currentProps, adaptiveControls, presetValues) => {
              const shownView: "day" | "week" = presetValues.view;
              return <output>{shownView}</output>;
            }}
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    const events = regionApi.manifest!.components.find((component) => component.id === "events")!;
    expect(events.capabilities.props).toEqual({ view: { values: ["day", "week"] } });
    expect(events.defaults.props).toEqual({ view: "week" });
    expect(events.description).toBe("view is how much shows at once.");
    expect(document.querySelector("output")!.textContent).toBe("week");
  });

  it("refuses a custom preset whose starting value it does not offer", () => {
    expect(() =>
      // @ts-expect-error: "year" is not one of the values.
      propPresets.choice({ values: ["day", "week"], initial: "year", means: "the view" }),
    ).toThrow('the initial value, "year", must be one of day, week');
  });

  it("refuses presets given as a list, which leaves their values without names", () => {
    expect(() =>
      // @ts-expect-error: a list is not a set of named presets.
      renderTable({ presets: [propPresets.density()] }),
    ).toThrow("give presets as an object, each under a name");
  });

  it("refuses settings declared by hand, saying where they go", () => {
    expect(() =>
      renderTable({
        // @ts-expect-error: settings are declared in presets.
        capabilities: { props: { density: { values: ["tight", "loose"] } } },
      }),
    ).toThrow("settings users may change are declared in presets");
    expect(() =>
      // @ts-expect-error: starting values come with each preset.
      renderTable({ defaults: { w: 12, h: 4, props: { density: "compact" } } }),
    ).toThrow("settings users may change are declared in presets");
  });

  it("refuses a prop declared by two presets", () => {
    expect(() =>
      renderTable({ presets: { rows: propPresets.density(), spacing: propPresets.density() } }),
    ).toThrow('the density preset declares "density", which another preset already declares');
  });
});
