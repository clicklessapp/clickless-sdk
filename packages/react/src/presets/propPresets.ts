import type { CSSProperties } from "react";
import {
  ensureReadableTextColor,
  propAcceptsValue,
  readableTextColor,
  type PropCapabilities,
  type PropValue,
} from "@clickless/core";

/**
 * A setting users may change, or a few that belong together, with its values
 * and the sentence that tells the model what it means. Pass it in `<Adaptive presets>`:
 * its props and starting values become part of the component's declaration, and
 * its sentence follows `description`, which is where the model learns what each
 * prop means.
 */
export interface PropPreset<Reading = unknown> {
  /** Which preset this is, such as "stripes". */
  readonly preset: string;
  readonly capabilities: Readonly<Record<string, PropCapabilities>>;
  readonly defaults: Readonly<Record<string, PropValue>>;
  /** One or two sentences naming each of its props, added to the component's description. */
  readonly description: string;
  /**
   * The preset's current value, from the props a render-function child receives.
   * A missing or unexpected value reads as the preset's default.
   */
  read(adaptiveProps: Readonly<Record<string, PropValue>>): Reading;
}

/**
 * A custom setting: one whose values the application gives, such as a choice of
 * the application's own views. Its prop takes the name it is given in
 * `<Adaptive presets>`, so `{ order: propPresets.choice(...) }` declares a prop
 * called `order`.
 */
export interface CustomPreset<Reading = unknown> {
  /** Which preset this is, such as "choice". */
  readonly preset: string;
  /** The preset with its prop given this name. */
  named(propName: string): PropPreset<Reading>;
}

/** The presets of one component, each under a name of the integrator's choosing. */
export type PresetSet = Readonly<Record<string, PropPreset | CustomPreset>>;

/** The current value of each preset in a set, under the same name. */
export type PresetValues<Presets extends PresetSet> = {
  [PresetName in keyof Presets]: Presets[PresetName] extends PropPreset<infer Reading>
    ? Reading
    : Presets[PresetName] extends CustomPreset<infer Reading>
      ? Reading
      : never;
};

/** Each preset of a set as a `PropPreset`, a custom one taking its key as its prop's name. */
export function presetsByName(presets: PresetSet): Record<string, PropPreset> {
  return Object.fromEntries(
    Object.entries(presets).map(([presetName, preset]) => [
      presetName,
      "named" in preset ? preset.named(presetName) : preset,
    ]),
  );
}

const DEFAULT_TEXT_COLOUR = "#0b0b0b";
const DEFAULT_BACKGROUND_COLOUR = "#ffffff";
const DEFAULT_STRIPE_COLOUR = "#f3f2ee";

function readChoice<Value extends string>(
  adaptiveProps: Readonly<Record<string, PropValue>>,
  propName: string,
  allowedValues: readonly Value[],
  fallbackValue: Value,
): Value {
  const propValue = adaptiveProps[propName];
  return allowedValues.includes(propValue as Value) ? (propValue as Value) : fallbackValue;
}

function readColour(adaptiveProps: Readonly<Record<string, PropValue>>, propName: string, fallbackColour: string) {
  const propValue = adaptiveProps[propName];
  return typeof propValue === "string" && propAcceptsValue({ type: "color" }, propValue) ? propValue : fallbackColour;
}

type ColourReadabilityCapabilities = Pick<Extract<PropCapabilities, { type: "color" }>, "textOn" | "against">;

function colourCapabilities(
  suggestedColours: readonly string[] | undefined,
  readability: ColourReadabilityCapabilities = {},
): PropCapabilities {
  return { type: "color", ...(suggestedColours && { suggested: [...suggestedColours] }), ...readability };
}

/**
 * A chosen colour and the text colour to draw on it: black or white, whichever
 * reads better on that colour.
 */
export type ColourReading = {
  colour: string;
  /** Black or white, whichever is readable on `colour`. */
  textColour: string;
};

function colourReading(colour: string): ColourReading {
  return { colour, textColour: readableTextColor(colour) };
}

const TEXT_ON_SENTENCE = "Text on it turns black or white to stay readable.";

/** The options `accent`, `colour` and `stripes` share on what is drawn on the colour and behind it. */
type ReadabilityOptions = {
  /**
   * Text is drawn on the colour in its reading's `textColour`, as on a button
   * or a selected entry. The planner is then told, and its reply says when a
   * chosen colour turns that text from white to black or back.
   */
  textOn?: boolean;
  /**
   * The colour behind it, written as #rrggbb, such as the page's `#ffffff`. The
   * planner's reply then says when a chosen colour would be hard to see on it:
   * under 3:1 for a colour with no text on it, such as a link or a line, and
   * all but the same as what is behind it, such as white on white, with `textOn`.
   */
  against?: string;
};

/** What the manifest declares for the options, and the sentence they add to the preset's own. */
function readability(
  presetName: string,
  { textOn = false, against }: ReadabilityOptions,
): { capabilities: ColourReadabilityCapabilities; sentence: string } {
  if (against !== undefined && !propAcceptsValue({ type: "color" }, against)) {
    throw new Error(`${presetName}(): against, "${against}", must be written as #rrggbb, such as "#ffffff".`);
  }
  return {
    capabilities: { ...(textOn && { textOn: {} }), ...(against !== undefined && { against }) },
    sentence: textOn ? ` ${TEXT_ON_SENTENCE}` : "",
  };
}

/** Words joined as people write them: "grey", "grey or red", "grey, blue or red". */
function listedWithOr(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

type Density = "comfortable" | "compact";
const DENSITIES: readonly Density[] = ["comfortable", "compact"];

/** `density`: how much room each row or entry takes. Reads as "comfortable" or "compact". */
function density({ initial = "comfortable" }: { initial?: Density } = {}): PropPreset<Density> {
  return {
    preset: "density",
    capabilities: { density: { values: [...DENSITIES] } },
    defaults: { density: initial },
    description:
      "density is how much room each row or entry takes: compact fits more on screen, comfortable leaves more space.",
    read: (adaptiveProps) => readChoice(adaptiveProps, "density", DENSITIES, initial),
  };
}

/**
 * `stripes`: colouring every other row. Reads as the stripe colour and the text
 * colour readable on it, or null when off.
 *
 * With `palette`, users choose among the named colours given, such as
 * `{ grey: "#f3f2ee", red: "#b91c1c" }`. Without it, they may choose any colour,
 * held in a second prop, `stripeColour`.
 */
function stripes(
  options:
    | ({ initial?: "off" | "on"; colour?: string; suggested?: readonly string[] } & ReadabilityOptions)
    | { palette: Readonly<Record<string, string>>; initial?: string } = {},
): PropPreset<ColourReading | null> {
  if ("palette" in options) {
    const colourNames = Object.keys(options.palette);
    if (colourNames.length === 0 || colourNames.includes("off")) {
      throw new Error('stripes(): give the palette at least one colour, and name none of them "off".');
    }
    const stripeValues = ["off", ...colourNames];
    const initialValue = options.initial ?? "off";
    if (!stripeValues.includes(initialValue)) {
      throw new Error(`stripes(): the initial value, "${initialValue}", must be "off" or one of the palette's names.`);
    }
    return {
      preset: "stripes",
      capabilities: { stripes: { values: stripeValues } },
      defaults: { stripes: initialValue },
      description: `stripes colours every other row ${listedWithOr(colourNames)}, or is off for plain rows.`,
      read: (adaptiveProps) => {
        const stripeChoice = readChoice(adaptiveProps, "stripes", stripeValues, initialValue);
        return stripeChoice === "off" ? null : colourReading(options.palette[stripeChoice]!);
      },
    };
  }
  const initialColour = options.colour ?? DEFAULT_STRIPE_COLOUR;
  const initialValue = options.initial ?? "off";
  const stripeReadability = readability("stripes", options);
  return {
    preset: "stripes",
    capabilities: {
      stripes: { values: ["off", "on"] },
      stripeColour: colourCapabilities(options.suggested, stripeReadability.capabilities),
    },
    defaults: { stripes: initialValue, stripeColour: initialColour },
    description:
      "stripes turns the colouring of every other row on or off, and stripeColour is the colour used. " +
      "Asking for a stripe colour turns stripes on." +
      stripeReadability.sentence,
    read: (adaptiveProps) =>
      readChoice(adaptiveProps, "stripes", ["off", "on"], initialValue) === "on"
        ? colourReading(readColour(adaptiveProps, "stripeColour", initialColour))
        : null,
  };
}

/**
 * `background` and `textColour`. Reads as both colours, with `textColour` turned
 * black or white where the chosen one would be hard to read on the background,
 * as the description promises the model; `chosenTextColour` is the user's choice as is.
 */
function colours({
  background = DEFAULT_BACKGROUND_COLOUR,
  textColour = DEFAULT_TEXT_COLOUR,
  suggested,
}: { background?: string; textColour?: string; suggested?: readonly string[] } = {}): PropPreset<{
  background: string;
  textColour: string;
  chosenTextColour: string;
  /** Both colours as a style, ready to spread onto the component's outer element. */
  style: CSSProperties;
}> {
  return {
    preset: "colours",
    capabilities: {
      background: colourCapabilities(suggested, { textOn: { colorProp: "textColour" } }),
      textColour: colourCapabilities(suggested),
    },
    defaults: { background, textColour },
    description:
      "background is the colour behind the whole component and textColour the colour of its text. " +
      "Text turns black or white wherever textColour would be hard to read on the background.",
    read: (adaptiveProps) => {
      const shownBackground = readColour(adaptiveProps, "background", background);
      const chosenTextColour = readColour(adaptiveProps, "textColour", textColour);
      const readableTextColour = ensureReadableTextColor(chosenTextColour, shownBackground);
      return {
        background: shownBackground,
        textColour: readableTextColour,
        chosenTextColour,
        style: { background: shownBackground, color: readableTextColour },
      };
    },
  };
}

/** `textSize`: the size of the text in pixels, a whole number from `min` to `max`. */
function textSize({
  initial = 14,
  min = 11,
  max = 22,
}: { initial?: number; min?: number; max?: number } = {}): PropPreset<number> {
  if (!(min <= initial && initial <= max)) {
    throw new Error(`textSize(): the initial size, ${initial}, must be from ${min} to ${max}.`);
  }
  return {
    preset: "textSize",
    capabilities: { textSize: { type: "number", min, max, integer: true } },
    defaults: { textSize: initial },
    description: "textSize is the size of the text in pixels.",
    read: (adaptiveProps) => readWholeNumber(adaptiveProps, "textSize", min, max, initial),
  };
}

/**
 * Showing or hiding one part of the component, such as
 * `{ trend: propPresets.toggle({ shows: "the line comparing it with last month" }) }`.
 * The prop takes its name from the key and holds "on" or "off"; it reads as true while shown.
 */
function toggle({ shows, initial = true }: { shows: string; initial?: boolean }): CustomPreset<boolean> {
  const initialValue = initial ? "on" : "off";
  return {
    preset: "toggle",
    named: (propName) => ({
      preset: "toggle",
      capabilities: { [propName]: { values: ["on", "off"] } },
      defaults: { [propName]: initialValue },
      description: `${propName} shows or hides ${shows}.`,
      read: (adaptiveProps) => readChoice(adaptiveProps, propName, ["on", "off"], initialValue) === "on",
    }),
  };
}

/**
 * One of a list of the application's own values, such as the view of a calendar:
 * `{ view: propPresets.choice({ values: ["day", "week", "month"], initial: "week", means: "how much of the calendar shows at once" }) }`.
 * `means` says what the prop is, in plain words, for the model: "view is …".
 */
function choice<const Value extends string>({
  values,
  initial,
  means,
}: {
  values: readonly Value[];
  initial: NoInfer<Value>;
  means: string;
}): CustomPreset<Value> {
  if (!values.includes(initial)) {
    throw new Error(`choice(): the initial value, "${initial}", must be one of ${values.join(", ")}.`);
  }
  return {
    preset: "choice",
    named: (propName) => ({
      preset: "choice",
      capabilities: { [propName]: { values: [...values] } },
      defaults: { [propName]: initial },
      description: `${propName} is ${means}.`,
      read: (adaptiveProps) => readChoice(adaptiveProps, propName, values, initial),
    }),
  };
}

/**
 * A number from `min` to `max`, whole unless `whole` is false, such as the corner
 * radius of a button. `means` says what it is, with its unit: "the corner radius in pixels".
 */
function number({
  min,
  max,
  initial,
  whole = true,
  means,
}: {
  min: number;
  max: number;
  initial: number;
  whole?: boolean;
  means: string;
}): CustomPreset<number> {
  if (!(min <= initial && initial <= max)) {
    throw new Error(`number(): the initial number, ${initial}, must be from ${min} to ${max}.`);
  }
  return {
    preset: "number",
    named: (propName) => ({
      preset: "number",
      capabilities: { [propName]: { type: "number", min, max, ...(whole && { integer: true }) } },
      defaults: { [propName]: initial },
      description: `${propName} is ${means}.`,
      read: (adaptiveProps) => {
        const propValue = adaptiveProps[propName];
        return typeof propValue === "number" &&
          propValue >= min &&
          propValue <= max &&
          (!whole || Number.isInteger(propValue))
          ? propValue
          : initial;
      },
    }),
  };
}

/**
 * Any colour, such as the colour of a chart's bars. `means` says what it colours:
 * "the colour of the bars". `suggested` lists colours to prefer, such as the brand's.
 * Reads as the colour and the text colour readable on it; give `textOn` where
 * text is drawn on it in that text colour, and `against` for the colour behind it.
 */
function colour({
  initial,
  suggested,
  means,
  ...readabilityOptions
}: {
  initial: string;
  suggested?: readonly string[];
  means: string;
} & ReadabilityOptions): CustomPreset<ColourReading> {
  const colourReadability = readability("colour", readabilityOptions);
  return {
    preset: "colour",
    named: (propName) => ({
      preset: "colour",
      capabilities: { [propName]: colourCapabilities(suggested, colourReadability.capabilities) },
      defaults: { [propName]: initial },
      description: `${propName} is ${means}.${colourReadability.sentence}`,
      read: (adaptiveProps) => colourReading(readColour(adaptiveProps, propName, initial)),
    }),
  };
}

/**
 * Which of the application's own entries show, and in what order, such as the
 * columns of a table. `means` says what the list holds: "the columns that show,
 * left to right". All of `values` show to begin with unless `initial` is given;
 * `min` is the fewest the list may hold, and `required` lists entries it must
 * always hold, such as the tab of the page that is open. They can still be moved.
 */
function visibleList<const Value extends string>({
  values,
  initial = values,
  min = 0,
  required = [],
  means,
}: {
  values: readonly Value[];
  initial?: readonly NoInfer<Value>[];
  min?: number;
  required?: readonly NoInfer<Value>[];
  means: string;
}): CustomPreset<Value[]> {
  const holdsWhatItMust = (entries: readonly unknown[]) =>
    entries.length >= min &&
    entries.every((entry) => values.includes(entry as Value)) &&
    required.every((requiredEntry) => entries.includes(requiredEntry));
  if (!holdsWhatItMust(initial)) {
    throw new Error(
      `visibleList(): the initial list must hold at least ${min} of ${values.join(", ")}` +
        (required.length > 0 ? `, including ${required.join(", ")}.` : "."),
    );
  }
  return {
    preset: "visibleList",
    named: (propName) => ({
      preset: "visibleList",
      capabilities: {
        [propName]: {
          values: [...values],
          multiple: true,
          ...(min > 0 && { min }),
          ...(required.length > 0 && { required: [...required] }),
        },
      },
      defaults: { [propName]: [...initial] },
      description: `${propName} lists ${means}.`,
      read: (adaptiveProps) => {
        const propValue = adaptiveProps[propName];
        return Array.isArray(propValue) && holdsWhatItMust(propValue) ? (propValue as Value[]) : [...initial];
      },
    }),
  };
}

function readWholeNumber(
  adaptiveProps: Readonly<Record<string, PropValue>>,
  propName: string,
  min: number,
  max: number,
  fallbackNumber: number,
): number {
  const propValue = adaptiveProps[propName];
  return typeof propValue === "number" && Number.isInteger(propValue) && propValue >= min && propValue <= max
    ? propValue
    : fallbackNumber;
}

/**
 * `count`: how many entries show, such as rows of a table or bars of a chart.
 * `of` names the entries, in the plural, where the component's title does not
 * make them plain: "months" on a chart titled "Revenue".
 */
function count({
  of = "entries",
  min = 1,
  max,
  initial,
}: {
  of?: string;
  min?: number;
  max: number;
  initial: number;
}): PropPreset<number> {
  if (!(min <= initial && initial <= max)) {
    throw new Error(`count(): the initial count, ${initial}, must be from ${min} to ${max}.`);
  }
  return {
    preset: "count",
    capabilities: { count: { type: "number", min, max, integer: true } },
    defaults: { count: initial },
    description: `count is how many ${of} show.`,
    read: (adaptiveProps) => readWholeNumber(adaptiveProps, "count", min, max, initial),
  };
}

type HighlightReading = {
  /** The highlight colour. */
  colour: string;
  /** Black or white, whichever is readable on the highlight colour. */
  textColour: string;
  /**
   * Whether an entry is highlighted. `position` counts from 0 at the top. `entry`
   * is the entry's value of the measure given to `above` or `below`, or, where
   * `kinds` is given too, `{ measure, kind }`, with `kind` the entry's value of it.
   */
  isHighlighted(position: number, entry?: HighlightedEntry): boolean;
  /**
   * The style for an entry: the highlight colour and readable text where it is
   * highlighted, and nothing where it is not. Pass it to the entry's own `style`,
   * such as `<tr style={highlight.styleFor(rowIndex, row.amount)}>` or
   * `<tr style={highlight.styleFor(rowIndex, { kind: row.status })}>`.
   */
  styleFor(position: number, entry?: HighlightedEntry): CSSProperties | undefined;
};

/** An entry's value of the measure, or that and its kind. */
type HighlightedEntry = number | { measure?: number; kind?: string };

// The format needs a largest value for every number. A highlight compares against
// whatever the list holds at the time, so by default it has none to speak of.
const NO_UPPER_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Colouring the entries that stand out in a list or table: the top few, such as
 * the top 3 (`top`), those whose value of a measure is more than an amount
 * (`above`) or less than one (`below`), or any of these. `entries` names them, in
 * the plural, where the component's title does not make them plain. `measure`
 * says what is compared, with its unit and without "the": "amount invoiced in
 * pounds", or "start time in hours from midnight, such as 13.5 for 1:30 pm".
 * `above` and `below` compare the same value, so given together they name the
 * same measure.
 * `kinds` colours the entries of chosen kinds, from a fixed set the application
 * names in `values`, such as `{ of: "statuses", values: ["booked", "arrived",
 * "cancelled"] }`. The values are kinds an entry falls into, never the entries
 * themselves, so a person's or customer's name is never one.
 * Adds `highlightTop`, `highlightAbove`, `highlightBelow`, `highlightKinds`
 * (whichever are given) and `highlightColour`. 0, or no kinds, turns any of them
 * off, and all start off.
 *
 * None has a largest value unless you give `max`: the amount is compared
 * with the entries shown at the time, so it suits a list whose contents change.
 */
function highlight({
  entries = "entries",
  top,
  above,
  below,
  kinds,
  colour = "#b91c1c",
  suggested,
}: {
  entries?: string;
  top?: true | { max: number };
  above?: { measure: string; max?: number };
  below?: { measure: string; max?: number };
  kinds?: { of: string; values: readonly string[] };
  colour?: string;
  suggested?: readonly string[];
}): PropPreset<HighlightReading> {
  if (!top && !above && !below && !kinds) throw new Error("highlight(): give top, above, below, kinds or a mix.");
  if (kinds && kinds.values.length === 0) throw new Error("highlight(): kinds needs at least one value.");
  if (above && below && above.measure !== below.measure) {
    throw new Error("highlight(): above and below compare the same value, so give them the same measure.");
  }
  const topLimit = top === true ? NO_UPPER_LIMIT : top?.max;
  const aboveLimit = above?.max ?? NO_UPPER_LIMIT;
  const belowLimit = below?.max ?? NO_UPPER_LIMIT;
  const ruleCount = [top, above, below].filter(Boolean).length;
  const kindValues = kinds ? [...kinds.values] : [];
  // A count from the top and an amount answer different questions, so the model
  // is told to pick one. Above and below together mark what falls outside a band,
  // such as deliveries due before 10 or after 4, so they may be used at once.
  const sentences = [
    top && `highlightTop is how many ${entries} are coloured, counted from the top.`,
    above && `highlightAbove colours the ${entries} whose ${above.measure} is more than that.`,
    below && `highlightBelow colours the ${entries} whose ${below.measure} is less than that.`,
    ruleCount === 0
      ? undefined
      : ruleCount === 1
        ? "0 turns it off."
        : ruleCount === 2 && top
          ? "Use one or the other; 0 turns either off."
          : ruleCount === 2
            ? "0 turns either off."
            : "Use highlightTop or the others, not both; 0 turns any of them off.",
    kinds &&
      `highlightKinds lists the ${kinds.of} whose ${entries} are coloured, from ${kindValues.join(", ")}; ` +
        "an empty list turns it off.",
    kinds && ruleCount > 0 && "highlightKinds adds to the others: an entry of a chosen kind is coloured whatever they say.",
    `highlightColour is the colour of highlighted ${entries}; their text turns black or white to stay readable.`,
  ];
  const readAmount = (adaptiveProps: Readonly<Record<string, PropValue>>, propName: string, limit: number) => {
    const amount = adaptiveProps[propName];
    return typeof amount === "number" && amount >= 0 && amount <= limit ? amount : 0;
  };
  return {
    preset: "highlight",
    capabilities: {
      ...(topLimit !== undefined && { highlightTop: { type: "number", min: 0, max: topLimit, integer: true } }),
      ...(above && { highlightAbove: { type: "number", min: 0, max: aboveLimit } }),
      ...(below && { highlightBelow: { type: "number", min: 0, max: belowLimit } }),
      ...(kinds && { highlightKinds: { values: kindValues, multiple: true } }),
      highlightColour: colourCapabilities(suggested, { textOn: {} }),
    },
    defaults: {
      ...(top && { highlightTop: 0 }),
      ...(above && { highlightAbove: 0 }),
      ...(below && { highlightBelow: 0 }),
      ...(kinds && { highlightKinds: [] }),
      highlightColour: colour,
    },
    description: sentences.filter(Boolean).join(" "),
    read: (adaptiveProps) => {
      const highlightTop =
        topLimit !== undefined ? readWholeNumber(adaptiveProps, "highlightTop", 0, topLimit, 0) : 0;
      const highlightAbove = above ? readAmount(adaptiveProps, "highlightAbove", aboveLimit) : 0;
      const highlightBelow = below ? readAmount(adaptiveProps, "highlightBelow", belowLimit) : 0;
      const chosenKinds = adaptiveProps.highlightKinds;
      const highlightKinds = new Set(
        kinds && Array.isArray(chosenKinds)
          ? chosenKinds.filter((kind): kind is string => typeof kind === "string" && kindValues.includes(kind))
          : [],
      );
      const highlightColour = readColour(adaptiveProps, "highlightColour", colour);
      const highlightTextColour = readableTextColor(highlightColour);
      const isHighlighted = (position: number, entry?: HighlightedEntry) => {
        const { measure: measuredValue, kind } = typeof entry === "number" ? { measure: entry } : (entry ?? {});
        return (
          position < highlightTop ||
          (measuredValue !== undefined &&
            ((highlightAbove > 0 && measuredValue > highlightAbove) ||
              (highlightBelow > 0 && measuredValue < highlightBelow))) ||
          (kind !== undefined && highlightKinds.has(kind))
        );
      };
      return {
        colour: highlightColour,
        textColour: highlightTextColour,
        isHighlighted,
        styleFor: (position, entry) =>
          isHighlighted(position, entry) ? { background: highlightColour, color: highlightTextColour } : undefined,
      };
    },
  };
}

type TextStyle = "regular" | "italic" | "bold" | "bold italic";
const TEXT_STYLES: readonly TextStyle[] = ["regular", "italic", "bold", "bold italic"];

/**
 * `textStyle`: whether the text is bold, italic, both or neither. It leaves
 * letter case alone, so a prop of your own for capitals combines with it.
 * Reads as `{ bold, italic }`; what bold looks like is up to you.
 */
function textStyle({ initial = "regular" }: { initial?: TextStyle } = {}): PropPreset<{ bold: boolean; italic: boolean }> {
  return {
    preset: "textStyle",
    capabilities: { textStyle: { values: [...TEXT_STYLES] } },
    defaults: { textStyle: initial },
    description: "textStyle makes the text bold, italic or both, or keeps it regular.",
    read: (adaptiveProps) => {
      const chosenStyle = readChoice(adaptiveProps, "textStyle", TEXT_STYLES, initial);
      return { bold: chosenStyle.startsWith("bold"), italic: chosenStyle.endsWith("italic") };
    },
  };
}

/**
 * `accent`: the one colour that marks what stands out, such as the selected
 * entry of a menu or today in a calendar. Name what it marks in `marks`.
 * Reads as the colour and the text colour readable on it; give `textOn` where
 * text is drawn on it in that text colour, such as a button's label, and
 * `against` for the colour behind it.
 */
function accent({
  marks,
  colour = "#1c5cab",
  suggested,
  ...readabilityOptions
}: {
  marks: string;
  colour?: string;
  suggested?: readonly string[];
} & ReadabilityOptions): PropPreset<ColourReading> {
  const accentReadability = readability("accent", readabilityOptions);
  return {
    preset: "accent",
    capabilities: { accent: colourCapabilities(suggested, accentReadability.capabilities) },
    defaults: { accent: colour },
    description: `accent is the colour that marks ${marks}.${accentReadability.sentence}`,
    read: (adaptiveProps) => colourReading(readColour(adaptiveProps, "accent", colour)),
  };
}

/**
 * The settings users may change, for `<Adaptive presets>`, each under a name of
 * your choosing. Built-in settings (`count`, `highlight`, `density`, `stripes`,
 * `colours`, `textSize`, `textStyle`, `accent`) come with their names, values and
 * wording, shared across applications; use one when it fits. Custom settings
 * (`toggle`, `choice`, `number`, `colour`, `visibleList`) take the application's
 * own values and a few words saying what they mean, and their prop takes the name
 * it is given.
 *
 * @example
 * <Adaptive id="invoices" kind="table" title="Invoices" defaults={{ w: 12, h: 5 }}
 *   presets={{
 *     columns: propPresets.visibleList({ values: COLUMN_IDS, min: 1, means: "the columns that show, left to right" }),
 *     stripes: propPresets.stripes({ suggested: BRAND_COLOURS }),
 *     rows: propPresets.density(),
 *   }}>
 *   {(props, adaptiveControls, presetValues) => (
 *     <InvoiceTable
 *       columns={presetValues.columns}
 *       stripeColour={presetValues.stripes}
 *       compact={presetValues.rows === "compact"}
 *     />
 *   )}
 * </Adaptive>
 */
export const propPresets = {
  count,
  highlight,
  density,
  stripes,
  colours,
  textSize,
  textStyle,
  accent,
  toggle,
  choice,
  number,
  colour,
  visibleList,
};
