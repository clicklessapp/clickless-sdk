import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Action, ActionCall, findActionsFailure, validateActionCalls, type AttachedFile } from "../src/index";
import { fixturesDirectory } from "./sharedContract";

const actionFixturesDirectory = fixturesDirectory + "actions/";
const readFixtureJson = (fileName: string) => JSON.parse(readFileSync(actionFixturesDirectory + fileName, "utf8"));
const actionsNamed = (actionsOrFileName: unknown): unknown =>
  typeof actionsOrFileName === "string" ? readFixtureJson(`${actionsOrFileName}.json`) : actionsOrFileName;

interface CallsFixtureCase {
  name: string;
  actions: string;
  attachedFiles?: AttachedFile[];
  calls: unknown[];
  expect: { errors: { index: number; code: string; message?: string }[] };
}

describe("calls.json", () => {
  for (const fixtureCase of readFixtureJson("calls.json") as CallsFixtureCase[]) {
    it(fixtureCase.name, () => {
      const actions = Action.array().parse(actionsNamed(fixtureCase.actions));
      const actionCalls = ActionCall.array().parse(fixtureCase.calls);
      const expectedErrors = fixtureCase.expect.errors;
      const reportedErrors = validateActionCalls(actions, actionCalls, fixtureCase.attachedFiles).map(
        ({ index, code, message }, errorPosition) => ({
          index,
          code,
          // The wording is compared where a case records it, as the engine is held to the same words.
          ...(expectedErrors[errorPosition]?.message !== undefined && { message }),
        }),
      );
      expect(reportedErrors).toEqual(expectedErrors);
    });
  }
});

describe("declarations.json", () => {
  const declarationCases = readFixtureJson("declarations.json") as {
    name: string;
    actions: unknown;
    accepted: boolean;
    message?: string;
  }[];
  for (const fixtureCase of declarationCases) {
    it(fixtureCase.name, () => {
      const parsedActions = Action.array().safeParse(actionsNamed(fixtureCase.actions));
      const failure = parsedActions.success ? findActionsFailure(parsedActions.data) : "refused by the schema";
      expect(failure === undefined).toBe(fixtureCase.accepted);
      if (fixtureCase.message !== undefined) expect(failure).toBe(fixtureCase.message);
    });
  }
});
