// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "../src/index";
import { EngineClient, isEngineUnavailable, isWorthRetrying } from "../src/engine/engineClient";
import {
  describeError,
  ENGINE_UNAVAILABLE_MESSAGE,
  PREVIEW_NO_LONGER_FITS_MESSAGE,
  WOULD_EMPTY_PAGE_MESSAGE,
} from "../src/engine/engineErrorMessages";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST } from "./dashboardWithFakeEngine";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("when the engine cannot be used as expected", () => {
  it("says plainly what cannot be done when no token can be got, and lets the page's own changes through", async () => {
    const engine = createFakeEngine();
    const signedOutEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        getToken: async (): Promise<string> => {
          throw new Error("session expired");
        },
      },
    };
    const { renderResult, regionApi } = renderDashboardWithEngine(signedOutEngine);
    // The saved layout could not be fetched, and the user is told so.
    await renderResult.findByText(/Personalising isn't available right now, so this screen may not show your saved changes/);
    expect(regionApi().loadFailed).toBe(true);

    let applyOutcome: unknown;
    await act(async () => {
      applyOutcome = await regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST);
    });
    expect(applyOutcome).toMatchObject({ applied: true });
    expect(regionApi().hasUnsavedChanges).toBe(true);
    expect(engine.receivedCalls).toEqual([]);

    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "transactions first" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    const alertElement = await renderResult.findByRole("alert");
    expect(alertElement.textContent).toBe("Personalising isn't available right now. Please try again in a little while.");
  });

  it("refuses a reply that is not the engine's", async () => {
    const engine = createFakeEngine();
    const proxiedEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) =>
          String(requestInput).endsWith("/plan")
            ? new Response("<html>Sign in</html>", { status: 200 })
            : engine.engineOptions.fetch(requestInput, requestInit)) as typeof fetch,
      },
    };
    const { regionApi } = renderDashboardWithEngine(proxiedEngine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    let planError: unknown;
    await act(async () => {
      planError = await regionApi().planFromPrompt("transactions first").catch((rejectionReason) => rejectionReason);
    });
    expect((planError as EngineError).code).toBe("bad_response");
    expect(regionApi().preview).toBeNull();
  });
});

describe("when the engine, or the host's token, never answers", () => {
  const UNAVAILABLE_ON_LOAD =
    "Personalising isn't available right now, so this screen may not show your saved changes. Everything on it still works.";

  it("gives up on a token that never comes, says so, and lets the page's own changes through", async () => {
    vi.useFakeTimers();
    try {
      const engine = createFakeEngine();
      const engineWithoutToken = {
        ...engine,
        engineOptions: { ...engine.engineOptions, getToken: () => new Promise<string>(() => {}) },
      };
      const { renderResult, regionApi, drawOrderOf } = renderDashboardWithEngine(engineWithoutToken);
      expect(regionApi().loading).toBe(true);

      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(regionApi().loading).toBe(false);
      expect(regionApi().loadFailed).toBe(true);
      expect(renderResult.getByText(UNAVAILABLE_ON_LOAD)).toBeTruthy();
      expect((renderResult.getByLabelText("Describe a change to this screen") as HTMLInputElement).readOnly).toBe(false);

      let applyOutcome: unknown;
      await act(async () => {
        applyOutcome = await regionApi().applyOperations(MOVE_TRANSACTIONS_FIRST);
      });
      expect(applyOutcome).toMatchObject({ applied: true });
      expect(drawOrderOf("txns")).toBe("1");
      expect(engine.receivedCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a token that never comes", () => new Promise<string>(() => {}), (async () => new Promise(() => {})) as typeof fetch],
    // A `fetch` of the host's own that pays no attention to being stopped.
    ["a request that ignores being stopped", () => "signed-token", (async () => new Promise(() => {})) as typeof fetch],
    [
      "an answer whose body never finishes arriving",
      () => "signed-token",
      (async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response) as typeof fetch,
    ],
  ])("gives up on %s once the time limit has passed", async (_description, getToken, fetchThatNeverFinishes) => {
    vi.useFakeTimers();
    try {
      const engineClient = new EngineClient({ url: "https://engine.test", getToken, fetch: fetchThatNeverFinishes });
      const readLayoutPromise = engineClient.readLayout("dashboard").catch((rejectionReason) => rejectionReason);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(engineClient.isReachable).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const readLayoutError = await readLayoutPromise;
      expect((readLayoutError as EngineError).code).toBe("timeout");
      expect(engineClient.isReachable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on turning a recording into text once its own time limit has passed", async () => {
    vi.useFakeTimers();
    try {
      const engineClient = new EngineClient({
        url: "https://engine.test",
        getToken: () => "signed-token",
        fetch: (async () => new Promise(() => {})) as typeof fetch,
      });
      const transcriptionPromise = engineClient
        .transcribeRecording(new Blob(["audio"]))
        .catch((rejectionReason) => rejectionReason);
      await vi.advanceTimersByTimeAsync(45_000);
      const transcriptionError = await transcriptionPromise;
      expect((transcriptionError as EngineError).code).toBe("timeout");
      expect(describeError(transcriptionError)).toBe("Personalising isn't available right now. Please try again in a little while.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the default view when the saved layout comes back as something else", async () => {
    const engine = createFakeEngine();
    const engineWithGarbledLayout = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        fetch: (async (requestInput, requestInit) =>
          String(requestInput).endsWith("/layout")
            ? new Response(JSON.stringify({ revision: "seven", layout: [1, 2] }), { status: 200 })
            : engine.engineOptions.fetch(requestInput, requestInit)) as typeof fetch,
      },
    };
    const { renderResult, regionApi, drawOrderOf } = renderDashboardWithEngine(engineWithGarbledLayout);
    await renderResult.findByText(UNAVAILABLE_ON_LOAD);
    expect(regionApi().loadFailed).toBe(true);
    expect(regionApi().layout!.order).toEqual(["balance", "revenue", "txns"]);
    expect(drawOrderOf("revenue")).toBe("1");
  });
});

describe("what the user is told when the engine cannot help", () => {
  it("gives up on a request that takes too long", async () => {
    vi.useFakeTimers();
    try {
      const fetchThatNeverAnswers = ((_requestInput, requestInit) =>
        new Promise((_resolve, reject) => {
          requestInit!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch;
      const engineClient = new EngineClient({ url: "https://engine.test", getToken: () => "signed-token", fetch: fetchThatNeverAnswers });
      const readLayoutPromise = engineClient.readLayout("dashboard").catch((rejectionReason) => rejectionReason);
      await vi.advanceTimersByTimeAsync(30_000);
      const readLayoutError = await readLayoutPromise;
      expect(readLayoutError).toBeInstanceOf(EngineError);
      expect((readLayoutError as EngineError).code).toBe("timeout");
      expect(describeError(readLayoutError)).toBe("Personalising isn't available right now. Please try again in a little while.");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [503, "service_busy", true, true],
    [500, "internal_error", false, true],
    [413, "request_too_large", true, false],
    [403, "forbidden", true, false],
    [401, "unauthorized", true, true],
  ] as const)(
    "after a %i %s, counts the engine as reachable: %s, and the request as worth trying again: %s",
    async (status, errorCode, staysReachable, worthRetrying) => {
      const engineClient = new EngineClient({
        url: "https://engine.test",
        getToken: () => "signed-token",
        fetch: (async () =>
          new Response(JSON.stringify({ detail: { code: errorCode, message: "…" } }), { status })) as typeof fetch,
      });
      const readLayoutError = await engineClient.readLayout("dashboard").catch((rejectionReason) => rejectionReason);
      expect((readLayoutError as EngineError).code).toBe(errorCode);
      expect(engineClient.isReachable).toBe(staysReachable);
      expect(isWorthRetrying(readLayoutError)).toBe(worthRetrying);
    },
  );

  it("tells the user the engine is busy without calling it unavailable", async () => {
    const engine = createFakeEngine();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    engine.failNextRequest(503, { code: "service_busy", message: "…" });
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "transactions first" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });
    expect((await renderResult.findByRole("alert")).textContent).toBe(
      "Lots of people are asking right now. Please try again in a moment.",
    );
    expect(renderResult.queryByText(/isn't available right now/)).toBeNull();
  });

  it("has a plain sentence for every way the engine can refuse", () => {
    const sentenceFor = (status: number, errorCode: string) =>
      describeError(new EngineError("the engine's own words", status, errorCode));
    expect(sentenceFor(429, "too_many_requests")).toBe(
      "You've asked for a lot in a short time. Please wait a minute and try again.",
    );
    expect(sentenceFor(401, "error")).toBe("You have been signed out. Please sign in again.");
    expect(sentenceFor(403, "error")).toBe("You don't have permission to change this screen.");
    expect(sentenceFor(503, "service_busy")).toBe("Lots of people are asking right now. Please try again in a moment.");
    expect(sentenceFor(413, "request_too_large")).toBe("That was too much to send in one go. Please try something shorter.");
    expect(sentenceFor(500, "internal_error")).toBe(
      "Personalising isn't available right now. Please try again in a little while.",
    );
    for (const [status, errorCode] of [[200, "bad_response"], [0, "network"], [0, "timeout"], [0, "token"], [502, "error"]] as const) {
      expect(sentenceFor(status, errorCode)).toBe("Personalising isn't available right now. Please try again in a little while.");
    }
    expect(sentenceFor(503, "planner_unavailable")).toBe("Changes can't be made by typing right now. Please try again in a little while.");
    for (const errorCode of ["manifest_too_large", "invalid_manifest", "unstorable_value", "duplicate_region"]) {
      expect(sentenceFor(422, errorCode)).toBe("This screen can't be changed right now.");
    }
    expect(sentenceFor(400, "region_mismatch")).toBe("Something went wrong. Please try again.");
  });
});

describe("an engine address that is not secure", () => {
  it.each(["http://engine.example.com", "http://engine.test", "http://localhost.example.com", "ftp://engine.example.com", "//engine.example.com"])(
    "sends nothing to %s, not even asking for a token, and says why once",
    async (engineUrl) => {
      const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const getToken = vi.fn(() => "signed-token");
      const engineFetch = vi.fn() as unknown as typeof fetch;
      const engineClient = new EngineClient({ url: engineUrl, getToken, fetch: engineFetch });

      const firstError = await engineClient.readLayout("dashboard").catch((rejectionReason) => rejectionReason);
      await engineClient.readLayout("dashboard").catch(() => {});

      expect(isEngineUnavailable(firstError)).toBe(true);
      expect(describeError(firstError)).toBe(ENGINE_UNAVAILABLE_MESSAGE);
      expect(getToken).not.toHaveBeenCalled();
      expect(engineFetch).not.toHaveBeenCalled();
      expect(consoleWarning).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["https://engine.example.com", "http://localhost:8010", "http://127.0.0.1:8010", "http://[::1]:8010", "http://engine.localhost", "/clickless"])(
    "calls the engine at %s",
    async (engineUrl) => {
      const engineFetch = vi.fn(async () => new Response(JSON.stringify({ revision: 0, layout: null, canUndo: false })));
      const engineClient = new EngineClient({ url: engineUrl, getToken: () => "signed-token", fetch: engineFetch as typeof fetch });

      await engineClient.readLayout("dashboard").catch(() => {});

      expect(engineFetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("an error reply whose details are not what the engine sends", () => {
  it.each([
    ["errors that are not a list", { code: "invalid_operations", message: "…", errors: {} }],
    ["errors of the wrong kind", { code: "invalid_operations", message: "…", errors: ["empty_region"] }],
    ["region ids that are not a list", { code: "conflict", message: "…", regionIds: "dashboard" }],
  ])("leaves out %s and still tells the user plainly", async (_description, errorDetail) => {
    const engineClient = new EngineClient({
      url: "https://engine.test",
      getToken: () => "signed-token",
      fetch: (async () => new Response(JSON.stringify({ detail: errorDetail }), { status: 422 })) as typeof fetch,
    });

    const engineError = (await engineClient.readLayout("dashboard").catch((rejectionReason) => rejectionReason)) as EngineError;

    expect(engineError.errors).toBeUndefined();
    expect(engineError.regionIds).toBeUndefined();
    expect(() => describeError(engineError)).not.toThrow();
  });

  it("keeps the details that are what the engine sends", async () => {
    const engineClient = new EngineClient({
      url: "https://engine.test",
      getToken: () => "signed-token",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            detail: {
              code: "invalid_operations",
              message: "…",
              errors: [{ index: 0, code: "empty_region", message: "…" }],
              regionIds: ["dashboard"],
            },
          }),
          { status: 422 },
        )) as typeof fetch,
    });

    const engineError = (await engineClient.readLayout("dashboard").catch((rejectionReason) => rejectionReason)) as EngineError;

    expect(engineError.errors).toHaveLength(1);
    expect(engineError.regionIds).toEqual(["dashboard"]);
    expect(describeError(engineError)).toBe(WOULD_EMPTY_PAGE_MESSAGE);
  });

  it("does not leave the prompt bar busy", async () => {
    const engine = createFakeEngine();
    engine.setPlanReply({ error: [422, { code: "invalid_operations", message: "…", errors: {} }] });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine);
    await waitFor(() => expect(regionApi().loading).toBe(false));

    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: "transactions first" } });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Preview" }));
    });

    await renderResult.findByText(PREVIEW_NO_LONGER_FITS_MESSAGE);
    expect((renderResult.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
