import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Layout, Manifest, OperationList, applyOperations, defaultLayout } from "../src/index";
import { fixturesDirectory } from "./sharedContract";

const readFixtureJson = (relativePath: string) =>
  JSON.parse(readFileSync(fixturesDirectory + relativePath, "utf8"));

interface ApplyFixtureCase {
  name: string;
  manifest: string;
  layout?: unknown;
  operations: unknown;
  expect: {
    order?: string[];
    items?: Layout["items"];
    offScreen?: null;
    errors?: { index: number; code: string; message?: string }[];
  };
}

for (const caseFileName of readdirSync(fixturesDirectory + "cases").sort()) {
  describe(caseFileName, () => {
    for (const fixtureCase of readFixtureJson(`cases/${caseFileName}`) as ApplyFixtureCase[]) {
      it(fixtureCase.name, () => {
        const manifest = Manifest.parse(readFixtureJson(`manifests/${fixtureCase.manifest}.json`));
        const startingLayout = fixtureCase.layout ? Layout.parse(fixtureCase.layout) : defaultLayout(manifest);
        const layoutBefore = structuredClone(startingLayout);
        const applyOutcome = applyOperations(manifest, startingLayout, OperationList.parse(fixtureCase.operations));

        expect(startingLayout).toEqual(layoutBefore);
        if (fixtureCase.expect.errors) {
          expect(applyOutcome.applied).toBe(false);
          // The wording is compared too where a case records it, as the engine is held to the same words.
          const expectedErrors = fixtureCase.expect.errors;
          const reportedErrors = applyOutcome.applied
            ? []
            : applyOutcome.errors.map(({ index, code, message }, errorPosition) => ({
                index,
                code,
                ...(expectedErrors[errorPosition]?.message !== undefined && { message }),
              }));
          expect(reportedErrors).toEqual(expectedErrors);
        } else {
          const { offScreen, ...startingLayoutOnScreen } = startingLayout;
          expect(applyOutcome).toEqual({
            applied: true,
            layout: {
              ...startingLayoutOnScreen,
              order: fixtureCase.expect.order ?? startingLayout.order,
              items: { ...startingLayout.items, ...fixtureCase.expect.items },
              ...(offScreen && fixtureCase.expect.offScreen !== null && { offScreen }),
            },
          });
        }
      });
    }
  });
}
