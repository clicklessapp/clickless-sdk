import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Layout, Manifest, layoutMatchesManifest, reconcileLayout } from "../src/index";
import { fixturesDirectory } from "./sharedContract";

const readFixtureJson = (relativePath: string) =>
  JSON.parse(readFileSync(fixturesDirectory + relativePath, "utf8"));

interface ReconcileFixtureCase {
  name: string;
  manifest: string;
  layout: unknown;
  expect: { layout: unknown; changes: unknown };
}

for (const caseFileName of readdirSync(fixturesDirectory + "reconcile").sort()) {
  describe(`reconcile/${caseFileName}`, () => {
    for (const fixtureCase of readFixtureJson(`reconcile/${caseFileName}`) as ReconcileFixtureCase[]) {
      it(fixtureCase.name, () => {
        const manifest = Manifest.parse(readFixtureJson(`manifests/${fixtureCase.manifest}.json`));
        const layout = Layout.parse(fixtureCase.layout);
        const layoutBefore = structuredClone(layout);

        const reconcileResult = reconcileLayout(manifest, layout);

        expect(layout).toEqual(layoutBefore);
        expect(reconcileResult.changes).toEqual(fixtureCase.expect.changes);
        expect(reconcileResult.layout).toEqual(fixtureCase.expect.layout);
        expect(layoutMatchesManifest(manifest, reconcileResult.layout)).toBe(true);
        expect(reconcileLayout(manifest, reconcileResult.layout)).toEqual({ layout: reconcileResult.layout, changes: [] });
      });
    }
  });
}
