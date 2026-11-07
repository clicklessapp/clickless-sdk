import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Manifest } from "../src/index";
import { findManifestFailure } from "../src/validateManifest";
import { fixturesDirectory } from "./sharedContract";

interface ManifestLimitFixtureCase {
  name: string;
  accepted: boolean;
  /** How a manifest the schema passes is refused, worded as findManifestFailure and the engine both word it. */
  message?: string;
  manifest: unknown;
}

const manifestLimitCases = JSON.parse(
  readFileSync(fixturesDirectory + "limits/manifests.json", "utf8"),
) as ManifestLimitFixtureCase[];

describe("limits/manifests.json", () => {
  for (const fixtureCase of manifestLimitCases) {
    it(fixtureCase.name, () => {
      // The schema checks each value on its own; findManifestFailure, how they fit together.
      const parsedManifest = Manifest.safeParse(fixtureCase.manifest);
      const accepted = parsedManifest.success && findManifestFailure(parsedManifest.data) === undefined;
      expect(accepted).toBe(fixtureCase.accepted);
      // A refusal past the schema is pinned word for word; one by the schema is not.
      if (!fixtureCase.accepted) {
        const manifestFailure = parsedManifest.success ? findManifestFailure(parsedManifest.data) : undefined;
        expect(manifestFailure).toBe(fixtureCase.message);
      }
    });
  }
});
