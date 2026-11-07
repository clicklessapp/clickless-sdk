import { describe, expect, it } from "vitest";
import { contrastRatio, ensureReadableTextColor, readableTextColor } from "../src/index";

describe("colours written in other hex forms", () => {
  it("reads a short colour as its long form", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21);
    expect(readableTextColor("#000")).toBe("#ffffff");
    expect(readableTextColor("#fff")).toBe("#000000");
  });

  it("ignores transparency", () => {
    expect(readableTextColor("#1a1a1acc")).toBe("#ffffff");
    expect(readableTextColor("#fffc")).toBe("#000000");
  });

  it("keeps the chosen text on a background it cannot judge", () => {
    expect(ensureReadableTextColor("#ffffff", "rgb(0, 0, 0)")).toBe("#ffffff");
    expect(ensureReadableTextColor("#777777", "#787878")).toBe("#000000");
  });
});
