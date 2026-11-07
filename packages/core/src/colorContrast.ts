const HEX_COLOR_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Relative luminance as WCAG defines it, or null if the value is not a hex
 * colour. Short forms (#rgb) are read as their long ones, and transparency
 * (#rgba, #rrggbbaa) is ignored.
 */
function relativeLuminance(colour: string): number | null {
  const hexDigits = HEX_COLOR_PATTERN.exec(colour)?.[1];
  if (!hexDigits) return null;
  const sixDigitHex =
    hexDigits.length <= 4 ? [...hexDigits].map((digit) => digit + digit).join("") : hexDigits;
  const [red, green, blue] = [0, 2, 4].map((channelStart) => {
    const channelIntensity = parseInt(sixDigitHex.slice(channelStart, channelStart + 2), 16) / 255;
    return channelIntensity <= 0.04045 ? channelIntensity / 12.92 : ((channelIntensity + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * The WCAG contrast ratio between two hex colours, from 1 (identical) to
 * 21 (black on white). Returns 1 if either value is not a hex colour.
 */
export function contrastRatio(firstColour: string, secondColour: string): number {
  const firstLuminance = relativeLuminance(firstColour);
  const secondLuminance = relativeLuminance(secondColour);
  if (firstLuminance === null || secondLuminance === null) return 1;
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

/**
 * Black or white, whichever is easier to read on the given background.
 * Use it for text drawn over a colour the user chose. Anything that is not a
 * hex colour, such as `rgb(...)` or a colour name, is treated as a light
 * background.
 */
export function readableTextColor(backgroundColour: string): "#000000" | "#ffffff" {
  return contrastRatio("#ffffff", backgroundColour) > contrastRatio("#000000", backgroundColour)
    ? "#ffffff"
    : "#000000";
}

/**
 * A text colour the user chose, kept only where it can be read. Returns
 * `textColour` if it contrasts enough with `backgroundColour`, and otherwise black or
 * white, whichever reads better. A background that is not a hex colour cannot
 * be judged, so `textColour` is returned as it is.
 *
 * `minimumContrastRatio` defaults to 4.5, the WCAG AA ratio for body text. Use
 * 3 for large or bold text.
 */
export function ensureReadableTextColor(
  textColour: string,
  backgroundColour: string,
  minimumContrastRatio = 4.5,
): string {
  if (relativeLuminance(backgroundColour) === null) return textColour;
  return contrastRatio(textColour, backgroundColour) >= minimumContrastRatio
    ? textColour
    : readableTextColor(backgroundColour);
}
