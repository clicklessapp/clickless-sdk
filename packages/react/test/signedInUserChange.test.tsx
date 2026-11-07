// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptBar, useAdaptiveRegion } from "../src/index";
import { createFakeEngine, MOVE_TRANSACTIONS_FIRST, type RegionApi } from "./dashboardWithFakeEngine";

afterEach(cleanup);

/** A token shaped as the host's backend signs one, naming its user in `sub`. */
function tokenFor(userId: string, tenantId = "acme"): string {
  const encodeTokenPart = (tokenPart: object) => btoa(JSON.stringify(tokenPart)).replace(/=+$/, "");
  return `${encodeTokenPart({ alg: "HS256", typ: "JWT" })}.${encodeTokenPart({ sub: userId, tenant: tenantId })}.signature`;
}

/** A dashboard whose engine is given the token of whoever is signed in when it asks. */
function renderForSignedInUser(engine: ReturnType<typeof createFakeEngine>, firstUserId: string) {
  let signedInUserId = firstUserId;
  let signedInTenantId = "acme";
  // While held, the host is slow to give tokens, and gives each one for whoever is signed in once it does.
  let heldTokens: Promise<void> | null = null;
  const engineOptions = {
    ...engine.engineOptions,
    getToken: async () => {
      await heldTokens;
      return tokenFor(signedInUserId, signedInTenantId);
    },
  };
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return null;
  }
  const dashboardFor = (userId: string) => (
    <AdaptiveProvider userId={userId} engine={engineOptions}>
      <RegionApiProbe />
      <PromptBar regionId="dashboard" />
      <AdaptiveRegion id="dashboard" version="1">
        <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
          revenue
        </Adaptive>
        <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
          txns
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>
  );
  const renderResult = render(dashboardFor(firstUserId));
  return {
    renderResult,
    regionApi: () => regionApiValue,
    promptInput: () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement,
    holdTokens: () => {
      let releaseTokens!: () => void;
      heldTokens = new Promise<void>((resolve) => (releaseTokens = resolve));
      return () =>
        act(async () => {
          heldTokens = null;
          releaseTokens();
        });
    },
    signIn: (userId: string) =>
      act(async () => {
        signedInUserId = userId;
        renderResult.rerender(dashboardFor(userId));
      }),
    /** Shows a page without ClickLess, as many applications do once their user signs out. */
    signOut: () =>
      act(async () => {
        renderResult.rerender(<p>Signed out</p>);
      }),
    /** The same user id is signed in to another tenant, a different account, on the same page. */
    switchTenant: (tenantId: string) => {
      signedInTenantId = tenantId;
    },
    /** Another user signs in and lands on a page without ClickLess. */
    signInElsewhere: (userId: string) =>
      act(async () => {
        signedInUserId = userId;
        renderResult.rerender(<p>Customer list</p>);
      }),
  };
}

describe("when another user signs in without the page reloading", () => {
  it("does not show them what the last user typed and did not send", async () => {
    const engine = createFakeEngine();
    const { regionApi, promptInput, signIn } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    fireEvent.change(promptInput(), { target: { value: "move the customer's notes up" } });

    await signIn("next-user");

    expect(promptInput().value).toBe("");
  });

  it("never saves the last user's unsaved change to the next user's account", async () => {
    const engine = createFakeEngine();
    const { regionApi, signIn } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    engine.failNextRequest(503, { code: "error", message: "…" });
    await act(async () => {
      await regionApi()
        .applyOperations(MOVE_TRANSACTIONS_FIRST)
        .catch(() => {});
    });
    expect(regionApi().hasUnsavedChanges).toBe(true);

    await signIn("next-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    // The engine is back, which is when an unsaved change is sent again.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    const callsForNextUser = engine.receivedCalls.filter((call) => call.token === `Bearer ${tokenFor("next-user")}`);
    expect(callsForNextUser.map((call) => `${call.method} ${call.endpointPath}`)).toEqual(["GET layout"]);
    expect(engine.regionState.revision).toBe(0);
    expect(regionApi().hasUnsavedChanges).toBe(false);
  });

  it("never sends a change that was waiting on its token with the next user's", async () => {
    const engine = createFakeEngine();
    const { regionApi, holdTokens, signIn } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const releaseTokens = holdTokens();
    act(() => {
      void regionApi()
        .applyOperations(MOVE_TRANSACTIONS_FIRST)
        .catch(() => {});
    });

    await signIn("next-user");
    await releaseTokens();
    await waitFor(() => expect(regionApi().loading).toBe(false));

    const callsForNextUser = engine.receivedCalls.filter((call) => call.token === `Bearer ${tokenFor("next-user")}`);
    expect(callsForNextUser.map((call) => `${call.method} ${call.endpointPath}`)).toEqual(["GET layout"]);
    expect(engine.regionState.revision).toBe(0);
  });

  it("never sends it with the next user's token when signing out showed a page without ClickLess", async () => {
    const engine = createFakeEngine();
    const { regionApi, holdTokens, signOut, signIn } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const releaseTokens = holdTokens();
    act(() => {
      void regionApi()
        .applyOperations(MOVE_TRANSACTIONS_FIRST)
        .catch(() => {});
    });

    await signOut();
    await signIn("next-user");
    await releaseTokens();
    await waitFor(() => expect(regionApi().loading).toBe(false));

    const callsForNextUser = engine.receivedCalls.filter((call) => call.token === `Bearer ${tokenFor("next-user")}`);
    expect(callsForNextUser.map((call) => `${call.method} ${call.endpointPath}`)).toEqual(["GET layout"]);
    expect(engine.regionState.revision).toBe(0);
  });

  it("does not show them the last user's request or the reply to it", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ operations: MOVE_TRANSACTIONS_FIRST, message: "Moved the transactions up." });
    const { renderResult, regionApi, promptInput, signIn } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    fireEvent.change(promptInput(), { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    await renderResult.findByText("Moved the transactions up.");

    await signIn("next-user");

    expect(renderResult.queryByText("Moved the transactions up.")).toBeNull();
    expect(renderResult.queryByText("transactions first")).toBeNull();
  });

  it("never sends it with the next user's token when they sign in to a page without ClickLess", async () => {
    const engine = createFakeEngine();
    const { regionApi, holdTokens, signOut, signInElsewhere } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const callCountBeforeChange = engine.receivedCalls.length;
    const releaseTokens = holdTokens();
    act(() => {
      void regionApi()
        .applyOperations(MOVE_TRANSACTIONS_FIRST)
        .catch(() => {});
    });

    await signOut();
    await signInElsewhere("next-user");
    await releaseTokens();
    await act(async () => {});

    expect(engine.receivedCalls.slice(callCountBeforeChange)).toEqual([]);
    expect(engine.regionState.revision).toBe(0);
  });

  it("never sends it with a token for the same user id in another tenant", async () => {
    const engine = createFakeEngine();
    const { regionApi, holdTokens, switchTenant } = renderForSignedInUser(engine, "first-user");
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const callCountBeforeChange = engine.receivedCalls.length;
    const releaseTokens = holdTokens();
    act(() => {
      void regionApi()
        .applyOperations(MOVE_TRANSACTIONS_FIRST)
        .catch(() => {});
    });

    switchTenant("globex");
    await releaseTokens();
    await act(async () => {});

    expect(engine.receivedCalls.slice(callCountBeforeChange)).toEqual([]);
    expect(engine.regionState.revision).toBe(0);
  });
});

describe("a userId that is not the token's user", () => {
  it("sends nothing, keeps the page working, and says why once", async () => {
    const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = createFakeEngine();
    const engineOptions = { ...engine.engineOptions, getToken: () => tokenFor("someone-else") };
    const renderResult = render(
      <AdaptiveProvider userId="first-user" engine={engineOptions}>
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>,
    );
    await act(async () => {});

    expect(renderResult.getByText("revenue")).toBeTruthy();
    expect(engine.receivedCalls).toEqual([]);
    expect(consoleWarning).toHaveBeenCalledTimes(1);
    expect(String(consoleWarning.mock.calls[0]![0])).toContain("userId must be the token's `sub`");
    consoleWarning.mockRestore();
  });
});
