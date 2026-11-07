import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, ensureReadableTextColor, readableTextColor } from "../src/index";
import { fixturesDirectory } from "./sharedContract";

type ContrastCases = {
  contrastRatio: { name: string; colours: [string, string]; ratio: number }[];
  readableTextColor: { name: string; background: string; text: string }[];
  ensureReadableTextColor: {
    name: string;
    text: string;
    background: string;
    minimumContrastRatio?: number;
    expect: string;
  }[];
};

const contrastCases = JSON.parse(
  readFileSync(fixturesDirectory + "contrast/cases.json", "utf8"),
) as ContrastCases;

describe("contrast cases shared with the engine", () => {
  for (const contrastCase of contrastCases.contrastRatio) {
    it(`contrastRatio: ${contrastCase.name}`, () => {
      expect(contrastRatio(...contrastCase.colours)).toBeCloseTo(contrastCase.ratio, 1);
      expect(contrastRatio(contrastCase.colours[1], contrastCase.colours[0])).toBeCloseTo(contrastCase.ratio, 1);
    });
  }

  for (const readableCase of contrastCases.readableTextColor) {
    it(`readableTextColor: ${readableCase.name}`, () => {
      expect(readableTextColor(readableCase.background)).toBe(readableCase.text);
    });
  }

  for (const ensureCase of contrastCases.ensureReadableTextColor) {
    it(`ensureReadableTextColor: ${ensureCase.name}`, () => {
      expect(ensureReadableTextColor(ensureCase.text, ensureCase.background, ensureCase.minimumContrastRatio)).toBe(
        ensureCase.expect,
      );
    });
  }
});
