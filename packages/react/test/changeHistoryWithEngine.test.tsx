// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useChangeHistory } from "../src/hooks/useChangeHistory";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST } from "./dashboardWithFakeEngine";

afterEach(cleanup);

describe("useChangeHistory", () => {
  it("stops saying it is loading when one read of the newest changes overtakes another", async () => {
    const engine = createFakeEngine();
    let releaseHistoryRequest!: () => void;
    const historyRequestHeld = new Promise<void>((resolve) => (releaseHistoryRequest = resolve));
    const slowHistoryEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) => {
          if (String(requestInput).includes("/revisions?")) await historyRequestHeld;
          return engine.engineOptions.fetch(requestInput, requestInit);
        }) as typeof fetch,
      },
    };
    let changeHistory!: ReturnType<typeof useChangeHistory>;
    function ChangeHistoryProbe() {
      changeHistory = useChangeHistory("dashboard");
      return null;
    }
    const { regionApi } = renderDashboardWithEngine(slowHistoryEngine, <ChangeHistoryProbe />);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    // Two saved changes, each of which starts a read while the first is still held.
    await act(() => regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST, "transactions first", "Moved."));
    await act(() => regionApi().applyOperations([{ type: "hide", id: "revenue" }], "hide revenue", "Hidden."));
    expect(changeHistory.loading).toBe(true);

    await act(async () => {
      releaseHistoryRequest();
      await historyRequestHeld;
    });
    await waitFor(() => expect(changeHistory.loading).toBe(false));
    expect(changeHistory.entries.map((entry) => entry.prompt)).toEqual(["transactions first", "hide revenue"]);
  });
});
