// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EngineError } from "../src/engine/engineClient";
import { describeError } from "../src/engine/engineErrorMessages";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, useAdaptiveRegion } from "../src/index";

afterEach(cleanup);

type RegionApi = ReturnType<typeof useAdaptiveRegion>;

function renderCards() {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("cards");
    return null;
  }
  const renderResult = render(
    <AdaptiveProvider userId="user-1">
      <RegionApiProbe />
      <AdaptiveRegion id="cards" version="1">
        <Adaptive id="revenue" kind="card" defaults={{ w: 6, h: 2 }}>
          <span>revenue body</span>
        </Adaptive>
        <Adaptive id="sales" kind="card" defaults={{ w: 6, h: 2 }}>
          <span>sales body</span>
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  return { renderResult, regionApi: () => regionApiValue };
}

it("refuses a change from the application's own controls that would hide everything", async () => {
  const { renderResult, regionApi } = renderCards();
  let applyOutcome!: Awaited<ReturnType<RegionApi["applyOperations"]>>;
  await act(async () => {
    applyOutcome = await regionApi().applyOperations([
      { type: "hide", id: "revenue" },
      { type: "hide", id: "sales" },
    ]);
  });

  expect(applyOutcome).toMatchObject({ applied: false, errors: [{ index: 1, code: "empty_region" }] });
  expect(renderResult.getByText("revenue body")).toBeTruthy();
  expect(renderResult.getByText("sales body")).toBeTruthy();
});

it("refuses to preview a change that would hide everything", () => {
  const { regionApi } = renderCards();
  let previewOutcome!: ReturnType<RegionApi["previewOperations"]>;
  act(() => {
    previewOutcome = regionApi().previewOperations([
      { type: "hide", id: "revenue" },
      { type: "hide", id: "sales" },
    ]);
  });

  expect(previewOutcome).toMatchObject({ applied: false, errors: [{ code: "empty_region" }] });
  expect(regionApi().preview).toBeNull();
});

it("tells the user plainly when the engine refuses a change that would hide everything", () => {
  const refusal = new EngineError("No operation was applied", 422, "invalid_operations", [
    { index: 1, code: "empty_region", message: "this would leave nothing showing in this region" },
  ]);

  expect(describeError(refusal)).toBe("That would leave this page empty, so nothing was changed.");
});
