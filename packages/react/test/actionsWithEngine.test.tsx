// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionError,
  Adaptive,
  AdaptiveAction,
  AdaptiveProvider,
  AdaptiveRegion,
  PromptBar,
  PromptPanel,
  useAdaptiveAction,
  type ActionArguments,
} from "../src/index";
import { createFakeEngine, renderDashboardWithEngine, MOVE_TRANSACTIONS_FIRST } from "./dashboardWithFakeEngine";

afterEach(cleanup);

const NAME_PARAMETERS = {
  firstName: { type: "text" as const, description: "First name", required: false },
  lastName: { type: "text" as const, description: "Last name", required: false },
};

/** A profile screen: no region to rearrange, only things the application can do. */
function renderProfileScreen(
  engine: ReturnType<typeof createFakeEngine>,
  runs: {
    updateName?: (actionArguments: ActionArguments) => unknown;
    openCustomer?: (actionArguments: ActionArguments) => unknown;
    updatePhoto?: (actionArguments: ActionArguments) => unknown;
  } = {},
) {
  function ProfileScreen() {
    const [showPhotoAction, setShowPhotoAction] = useState(true);
    useAdaptiveAction({
      name: "updateName",
      title: "Change your name",
      description: "Changes the signed-in user's name.",
      parameters: NAME_PARAMETERS,
      confirm: ({ firstName, lastName }) => `Change your name to ${[firstName, lastName].filter(Boolean).join(" ")}?`,
      run: runs.updateName ?? (() => "Your name has been changed."),
    });
    return (
      <>
        <AdaptiveAction
          name="openCustomer"
          title="Open a customer's record"
          mode="read"
          parameters={{ customerName: { type: "text", description: "Customer" } }}
          run={runs.openCustomer ?? (() => {})}
        />
        {showPhotoAction && (
          <AdaptiveAction
            name="updatePhoto"
            title="Change your profile picture"
            parameters={{ photo: { type: "file", description: "Picture", accept: ["image/*"] } }}
            run={runs.updatePhoto ?? (() => {})}
          />
        )}
        <button type="button" onClick={() => setShowPhotoAction(false)}>
          Leave the photo page
        </button>
      </>
    );
  }
  const renderResult = render(
    <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
      <ProfileScreen />
      <PromptPanel regionId="profile" defaultOpen />
    </AdaptiveProvider>,
  );
  const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
  const sendRequest = async (request: string) => {
    fireEvent.change(promptInput(), { target: { value: request } });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
    });
  };
  const planRequests = () =>
    engine.receivedCalls.filter((call) => call.endpointPath === "v1/plan").map((call) => call.requestBody);
  return { renderResult, promptInput, sendRequest, planRequests };
}

describe("actions", () => {
  it("asks the planner with the screen's actions, and runs a change only once it is confirmed", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua", lastName: "King" } }],
      message: "",
    });
    const updateName = vi.fn(() => "Your name has been changed.");
    const { renderResult, promptInput, sendRequest, planRequests } = renderProfileScreen(engine, { updateName });

    await sendRequest("my name is Joshua King now");

    const [planRequest] = planRequests();
    expect(planRequest.regions).toEqual([]);
    expect(planRequest.screenId).toBe("profile");
    expect(planRequest.conversation).toEqual([]);
    expect(planRequest.actions.map((action: { name: string }) => action.name).sort()).toEqual([
      "openCustomer",
      "updateName",
      "updatePhoto",
    ]);
    expect(planRequest.actions.find((action: { name: string }) => action.name === "updateName")).toEqual({
      name: "updateName",
      title: "Change your name",
      description: "Changes the signed-in user's name.",
      mode: "write",
      parameters: NAME_PARAMETERS,
    });
    // What was asked stays in view, and the box is ready for the next request.
    expect(renderResult.getByText("my name is Joshua King now")).toBeTruthy();
    expect(promptInput().value).toBe("");
    // Said once, beside Confirm, and not again in a reply above it.
    const confirmation = renderResult.container.querySelector("[data-clickless-confirmation]")!;
    expect(confirmation.querySelector('[role="status"]')!.textContent).toBe("Change your name to Joshua King?");
    expect(renderResult.container.querySelector('[data-clickless-bubble="reply"]')).toBeNull();
    expect(updateName).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Confirm" }));
    });

    expect(updateName).toHaveBeenCalledWith({ firstName: "Joshua", lastName: "King" });
    expect(renderResult.getByText("Your name has been changed.")).toBeTruthy();
    expect(renderResult.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("says plainly that a change waiting to be confirmed was cancelled by a new request", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua", lastName: "King" } }],
      message: "",
    });
    const updateName = vi.fn(() => "Your name has been changed.");
    const { renderResult, sendRequest } = renderProfileScreen(engine, { updateName });
    await sendRequest("my name is Joshua King now");
    expect(renderResult.getByRole("button", { name: "Confirm" })).toBeTruthy();

    engine.setPlanAcrossRegionsReply({ changes: [], message: "Which photo do you mean?" });
    await sendRequest("change my photo");

    expect(renderResult.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(renderResult.getByText("Cancelled, as you asked for something else.")).toBeTruthy();
    expect(renderResult.queryByText(/The user asked/)).toBeNull();
    expect(updateName).not.toHaveBeenCalled();
  });

  it("lists each change to confirm on a line of its own, with no reply above them", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [
        { name: "updateName", arguments: { firstName: "Joshua" } },
        { name: "updatePhoto", arguments: { photo: 0 } },
      ],
      message: "",
    });
    const { renderResult, sendRequest } = renderProfileScreen(engine);
    fireEvent.change(renderResult.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["png"], "a.png", { type: "image/png" })] },
    });

    await sendRequest("call me Joshua and use this as my picture");

    const summaries = renderResult.container.querySelectorAll("[data-clickless-confirmation] p");
    expect([...summaries].map((summary) => summary.textContent)).toEqual([
      "Change your name to Joshua?",
      "Change your profile picture. Picture: a.png.",
    ]);
    expect(renderResult.container.querySelector('[data-clickless-bubble="reply"]')).toBeNull();
  });

  it("shows only what will be done in the one-line bar, when the request is only for that", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "",
    });
    function ProfileBar() {
      useAdaptiveAction({
        name: "updateName",
        title: "Change your name",
        parameters: NAME_PARAMETERS,
        confirm: ({ firstName }) => `Change your first name to ${firstName}?`,
        run: () => {},
      });
      return <PromptBar regionId="profile" />;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <ProfileBar />
      </AdaptiveProvider>,
    );

    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: "call me Joshua" } });
    await act(async () => {
      fireEvent.submit(renderResult.getByLabelText("Describe a change to this screen").closest("form")!);
    });

    const status = renderResult.getByRole("status");
    expect(status.querySelectorAll("span")).toHaveLength(1);
    expect(status.querySelector("span")!.textContent).toBe("Change your first name to Joshua?");
  });

  it("runs nothing when the user cancels, and says so to the planner next time", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "",
    });
    const updateName = vi.fn();
    const { renderResult, sendRequest, planRequests } = renderProfileScreen(engine, { updateName });

    await sendRequest("call me Joshua");
    fireEvent.click(renderResult.getByRole("button", { name: "Cancel" }));
    expect(updateName).not.toHaveBeenCalled();
    expect(renderResult.getByText("Cancelled.")).toBeTruthy();

    engine.setPlanAcrossRegionsReply({ changes: [], message: "Okay." });
    await sendRequest("never mind");
    expect(planRequests()[1].conversation).toEqual([
      { request: "call me Joshua", reply: "[Outcome: Change your name — cancelled.]" },
    ]);
  });

  it("runs an action that only changes what is shown at once, without asking", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "openCustomer", arguments: { customerName: "Bella" } }],
      message: "Opening Bella's record.",
    });
    const openCustomer = vi.fn();
    const { renderResult, sendRequest } = renderProfileScreen(engine, { openCustomer });

    await sendRequest("open bella");

    expect(openCustomer).toHaveBeenCalledWith({ customerName: "Bella" });
    expect(renderResult.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(renderResult.getByText("Opening Bella's record.")).toBeTruthy();
  });

  it("keeps a read action quiet when it works, the reply already saying what it shows", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "openCustomer", arguments: { customerName: "Bella" } }],
      message: "Opening Bella's record.",
    });
    const { renderResult, sendRequest } = renderProfileScreen(engine, { openCustomer: () => "Opened Bella's record." });

    await sendRequest("open bella");

    expect(renderResult.getByText("Opening Bella's record.")).toBeTruthy();
    expect(renderResult.queryByText("Opened Bella's record.")).toBeNull();
  });

  it("shows a read action's answer above the change it informs, when the action asks for that", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [
        { name: "findTimes", arguments: {} },
        { name: "updateName", arguments: { firstName: "Joshua" } },
      ],
      message: "Finding new times.",
    });
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <AdaptiveAction
          name="findTimes"
          title="Find new times"
          mode="read"
          showResult
          parameters={{}}
          run={() => "New times: Bella 09:40, Ann 10:00."}
        />
        <AdaptiveAction
          name="updateName"
          title="Change your name"
          parameters={NAME_PARAMETERS}
          confirm={({ firstName }) => `Change your name to ${String(firstName)}?`}
          run={() => {}}
        />
        <PromptPanel regionId="profile" defaultOpen />
      </AdaptiveProvider>,
    );
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "find new times and change my name to Joshua" },
    });
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Send" })));

    await renderResult.findByText("New times: Bella 09:40, Ann 10:00.");
    expect(renderResult.getByRole("button", { name: "Confirm" })).toBeTruthy();
    const answer = renderResult.getByText("New times: Bella 09:40, Ann 10:00.");
    const confirmation = renderResult.getByText("Change your name to Joshua?");
    expect(answer.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sends earlier requests and answers, so an answer to a question is understood", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [], message: "What should your last name be?" });
    const { renderResult, sendRequest, planRequests } = renderProfileScreen(engine);

    await sendRequest("change my last name");
    expect(renderResult.getByText("What should your last name be?")).toBeTruthy();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { lastName: "King" } }],
      message: "",
    });
    await sendRequest("King");

    expect(planRequests()[1].conversation).toEqual([
      { request: "change my last name", reply: "What should your last name be?" },
    ]);
    expect(renderResult.getByText("Change your name to King?")).toBeTruthy();
  });

  it("tells the user in a sentence why an action failed", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "",
    });
    const updateName = vi
      .fn()
      .mockRejectedValueOnce(new ActionError("Names can only be changed by the practice manager."))
      .mockRejectedValueOnce(new Error("HTTP 500 from /api/me"));
    const { renderResult, sendRequest } = renderProfileScreen(engine, { updateName });

    await sendRequest("call me Joshua");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Confirm" }));
    });
    expect(renderResult.getByRole("alert").textContent).toBe("Names can only be changed by the practice manager.");

    await sendRequest("call me Joshua");
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Confirm" }));
    });
    // What the application threw is not for the user's eyes.
    expect(renderResult.getByRole("alert").textContent).toBe("That couldn't be done. Please try again.");
  });

  it("refuses an action the screen stopped offering while the planner worked", async () => {
    const engine = createFakeEngine();
    let answerPlan!: () => void;
    const planAnswered = new Promise<void>((resolve) => (answerPlan = resolve));
    const engineFetch = engine.engineOptions.fetch;
    engine.engineOptions.fetch = async (input, init) => {
      if (String(input).endsWith("/v1/plan")) await planAnswered;
      return engineFetch(input, init);
    };
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updatePhoto", arguments: { photo: 0 } }],
      message: "",
    });
    const updatePhoto = vi.fn();
    const { renderResult, sendRequest } = renderProfileScreen(engine, { updatePhoto });
    const picture = new File(["png"], "me.png", { type: "image/png" });
    fireEvent.change(renderResult.container.querySelector('input[type="file"]')!, { target: { files: [picture] } });

    const requestSent = sendRequest("use this as my picture");
    fireEvent.click(renderResult.getByRole("button", { name: "Leave the photo page" }));
    answerPlan();
    await requestSent;
    await waitFor(() => expect(renderResult.getByRole("alert").textContent).toBe("That can't be done on this screen right now."));
    expect(updatePhoto).not.toHaveBeenCalled();
  });

  it("hands an attached file to the action, and only its name and type to the engine", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updatePhoto", arguments: { photo: 0 } }],
      message: "",
    });
    const updatePhoto = vi.fn();
    const { renderResult, sendRequest, planRequests } = renderProfileScreen(engine, { updatePhoto });
    const picture = new File(["png"], "me.png", { type: "image/png" });

    fireEvent.change(renderResult.container.querySelector('input[type="file"]')!, { target: { files: [picture] } });
    expect(renderResult.getByRole("list", { name: "Attached files" }).textContent).toContain("me.png");
    await sendRequest("use this as my picture");
    expect(planRequests()[0].attachedFiles).toEqual([{ name: "me.png", type: "image/png" }]);
    // The confirmation names the file, since the action gave no sentence of its own.
    expect(renderResult.getByText("Change your profile picture. Picture: me.png.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Confirm" }));
    });
    expect(updatePhoto).toHaveBeenCalledWith({ photo: picture });
    expect(renderResult.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("tells the engine which action ran and how it ended, never with what values", async () => {
    const engine = createFakeEngine();
    const updateName = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    const openCustomer = vi.fn();
    const { renderResult, sendRequest } = renderProfileScreen(engine, { updateName, openCustomer });
    const nameCall = {
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua", lastName: "King" } }],
      message: "",
    };
    const confirmButton = () => renderResult.getByRole("button", { name: "Confirm" });

    engine.setPlanAcrossRegionsReply(nameCall);
    await sendRequest("I'm Joshua King");
    await act(async () => fireEvent.click(confirmButton()));
    engine.setPlanAcrossRegionsReply(nameCall);
    await sendRequest("I'm Joshua King");
    await act(async () => fireEvent.click(confirmButton()));
    engine.setPlanAcrossRegionsReply(nameCall);
    await sendRequest("I'm Joshua King");
    fireEvent.click(renderResult.getByRole("button", { name: "Cancel" }));
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "openCustomer", arguments: { customerName: "Bella" } }],
      message: "Opening Bella's record.",
    });
    await sendRequest("open bella");

    await waitFor(() => expect(engine.recordedActionRuns).toHaveLength(4));
    expect(engine.recordedActionRuns.map(({ id: _id, ...reportedRun }) => reportedRun)).toEqual([
      { screenId: "profile", actionName: "updateName", actionTitle: "Change your name", mode: "write", parameterNames: ["firstName", "lastName"], outcome: "done" },
      { screenId: "profile", actionName: "updateName", actionTitle: "Change your name", mode: "write", parameterNames: ["firstName", "lastName"], outcome: "failed" },
      { screenId: "profile", actionName: "updateName", actionTitle: "Change your name", mode: "write", parameterNames: ["firstName", "lastName"], outcome: "cancelled" },
      { screenId: "profile", actionName: "openCustomer", actionTitle: "Open a customer's record", mode: "read", parameterNames: ["customerName"], outcome: "done" },
    ]);
    expect(JSON.stringify(engine.recordedActionRuns)).not.toMatch(/Joshua|King|Bella/);
  });

  it("lists the actions run before after the page is loaded again, by their titles", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { lastName: "King" } }],
      message: "",
    });
    const firstVisit = renderProfileScreen(engine);
    await firstVisit.sendRequest("my last name is King");
    await act(async () => fireEvent.click(firstVisit.renderResult.getByRole("button", { name: "Confirm" })));
    // In the conversation already, so not listed a second time.
    await waitFor(() => expect(engine.recordedActionRuns).toHaveLength(1));
    expect(firstVisit.renderResult.container.querySelector("[data-clickless-action-run]")).toBeNull();
    cleanup();

    const { renderResult } = renderProfileScreen(engine);
    const listedRun = await waitFor(() => {
      const runElement = renderResult.container.querySelector("[data-clickless-action-run]");
      expect(runElement).not.toBeNull();
      return runElement!;
    });
    expect(listedRun.getAttribute("data-clickless-action-run")).toBe("done");
    expect(listedRun.querySelector("p")!.textContent).toBe("Change your name");
    expect(listedRun.textContent).toContain("Done");
    expect(renderResult.queryByText("Describe a change and you will see a preview before anything is saved.")).toBeNull();
  });

  it("opens at the latest entry once the actions run before have loaded", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { lastName: "King" } }],
      message: "",
    });
    const firstVisit = renderProfileScreen(engine);
    await firstVisit.sendRequest("my last name is King");
    await act(async () => fireEvent.click(firstVisit.renderResult.getByRole("button", { name: "Confirm" })));
    await waitFor(() => expect(engine.recordedActionRuns).toHaveLength(1));
    cleanup();

    // jsdom lays nothing out, so the conversation grows by the actions listed in it.
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return 100 + 100 * this.querySelectorAll("[data-clickless-action-run]").length;
      },
    });
    try {
      const { renderResult } = renderProfileScreen(engine);
      const listedRun = await waitFor(() => {
        const runElement = renderResult.container.querySelector("[data-clickless-action-run]");
        expect(runElement).not.toBeNull();
        return runElement!;
      });
      const conversation = listedRun.closest('div[style*="overflow-y: auto"]') as HTMLElement;
      await waitFor(() => expect(conversation.scrollTop).toBe(200));
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    }
  });

  it("sends a long file name cut short rather than having the whole request refused", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({ changes: [], message: "Which picture?" });
    const { renderResult, sendRequest, planRequests } = renderProfileScreen(engine);
    const longName = `${"a".repeat(240)}.png`;
    fireEvent.change(renderResult.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["png"], longName, { type: "image/png" })] },
    });

    await sendRequest("use this");

    expect(planRequests()[0].attachedFiles).toEqual([{ name: longName.slice(0, 200), type: "image/png" }]);
  });

  it("names a field given no description in words, in what the user confirms", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateReminders", arguments: { phoneNumber: "07700 900123", remind_by_text: true } }],
      message: "",
    });
    function RemindersScreen() {
      useAdaptiveAction({
        name: "updateReminders",
        title: "Change your reminders",
        parameters: { phoneNumber: { type: "text" }, remind_by_text: { type: "boolean" } },
        run: () => {},
      });
      return null;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <RemindersScreen />
        <PromptPanel regionId="reminders" defaultOpen />
      </AdaptiveProvider>,
    );
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: "remind me by text" } });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
    });

    expect(
      renderResult.getByText("Change your reminders. Phone number: 07700 900123, Remind by text: yes."),
    ).toBeTruthy();
  });

  describe("what runs is what was confirmed", () => {
    /** A customer's record whose customer can change while the panel stays the same. */
    function renderRecord(engine: ReturnType<typeof createFakeEngine>, addNote: (customer: string, note: string) => void) {
      function CustomerRecord({ customer }: { customer: string }) {
        useAdaptiveAction({
          name: "addNote",
          title: "Add a note",
          parameters: { note: { type: "text", description: "Note" } },
          confirm: ({ note }) => `Add "${note}" to ${customer}'s record?`,
          run: ({ note }) => addNote(customer, String(note)),
        });
        return null;
      }
      const page = (customer: string | null) => (
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          {customer && <CustomerRecord customer={customer} />}
          <PromptPanel regionId="customer-record" defaultOpen />
        </AdaptiveProvider>
      );
      const renderResult = render(page("Alice"));
      return { renderResult, showCustomer: (customer: string | null) => renderResult.rerender(page(customer)) };
    }

    async function askForANote(renderResult: ReturnType<typeof render>) {
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
        target: { value: "note that she prefers email" },
      });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
      });
    }

    function engineThatPlansANote() {
      const engine = createFakeEngine();
      engine.setPlanAcrossRegionsReply({
        changes: [],
        actionCalls: [{ name: "addNote", arguments: { note: "prefers email" } }],
        message: "",
      });
      return engine;
    }

    it("runs the action as it was when shown, even after the screen moved to another record", async () => {
      const addNote = vi.fn();
      const { renderResult, showCustomer } = renderRecord(engineThatPlansANote(), addNote);
      await askForANote(renderResult);
      expect(renderResult.getByText(`Add "prefers email" to Alice's record?`)).toBeTruthy();

      showCustomer("Bob");
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Confirm" })));

      expect(addNote).toHaveBeenCalledWith("Alice", "prefers email");
      expect(addNote).not.toHaveBeenCalledWith("Bob", expect.anything());
    });

    it("runs nothing when the action left the screen while it waited", async () => {
      const addNote = vi.fn();
      const engine = engineThatPlansANote();
      const { renderResult, showCustomer } = renderRecord(engine, addNote);
      await askForANote(renderResult);

      showCustomer(null);

      expect(renderResult.queryByRole("button", { name: "Confirm" })).toBeNull();
      expect(renderResult.getByRole("alert").textContent).toBe("This screen changed, so that wasn't done. Please ask again.");
      expect(addNote).not.toHaveBeenCalled();
      await waitFor(() => expect(engine.recordedActionRuns.map((run) => run.outcome)).toEqual(["cancelled"]));
    });

    it("runs a confirmed change once, however quickly Confirm is pressed again", async () => {
      const addNote = vi.fn();
      const { renderResult } = renderRecord(engineThatPlansANote(), addNote);
      await askForANote(renderResult);
      const confirmButton = renderResult.getByRole("button", { name: "Confirm" });

      await act(async () => {
        fireEvent.click(confirmButton);
        fireEvent.click(confirmButton);
      });

      expect(addNote).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps what comes after a change waiting behind it, in the order planned", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [
        { name: "openCustomer", arguments: { customerName: "Bella" } },
        { name: "updateName", arguments: { firstName: "Joshua" } },
        { name: "openCustomer", arguments: { customerName: "Max" } },
      ],
      message: "Opening Bella's record.",
    });
    const runOrder: string[] = [];
    const { renderResult, sendRequest } = renderProfileScreen(engine, {
      openCustomer: ({ customerName }) => runOrder.push(`open ${customerName}`),
      updateName: () => runOrder.push("rename"),
    });

    await sendRequest("open bella, call me joshua, then open max");
    expect(runOrder).toEqual(["open Bella"]);
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Confirm" })));
    expect(runOrder).toEqual(["open Bella", "rename", "open Max"]);
  });

  it("keeps the attached files as they were while a change that uses them waits", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updatePhoto", arguments: { photo: 0 } }],
      message: "",
    });
    const { renderResult, sendRequest } = renderProfileScreen(engine);
    fireEvent.change(renderResult.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["png"], "a.png", { type: "image/png" })] },
    });
    await sendRequest("use this");

    expect((renderResult.getByRole("button", { name: "Remove a.png" }) as HTMLButtonElement).disabled).toBe(true);
    expect((renderResult.getByRole("button", { name: "Attach a file" }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("a preview and an action that only changes what is shown", () => {
    async function renderChartWithPageOpener(openPage: () => void) {
      const engine = createFakeEngine();
      engine.setPlanAcrossRegionsReply({
        changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
        actionCalls: [{ name: "openPage", arguments: { page: "tables" } }],
        message: "Revenue is hidden.",
      });
      function Dashboard() {
        useAdaptiveAction({
          name: "openPage",
          title: "Open a page",
          mode: "read",
          parameters: { page: { type: "text", values: ["tables"] } },
          confirm: () => "Open the Tables page.",
          run: openPage,
        });
        return (
          <AdaptiveRegion id="dashboard" version="1">
            <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
              revenue
            </Adaptive>
            <Adaptive id="sales" title="Sales" defaults={{ w: 6, h: 3 }}>
              sales
            </Adaptive>
          </AdaptiveRegion>
        );
      }
      const renderResult = render(
        <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
          <Dashboard />
          <PromptPanel regionId="dashboard" defaultOpen />
        </AdaptiveProvider>,
      );
      await waitFor(() => expect(engine.receivedCalls.some((call) => call.endpointPath === "layout")).toBe(true));
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
        target: { value: "hide revenue and take me to tables" },
      });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
      });
      return { engine, renderResult };
    }

    it("waits for the preview to be kept, so leaving the page cannot lose it", async () => {
      const openPage = vi.fn();
      const { engine, renderResult } = await renderChartWithPageOpener(openPage);

      expect(openPage).not.toHaveBeenCalled();
      expect(renderResult.getByText("Then: Open the Tables page.")).toBeTruthy();
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Keep" })));

      expect(engine.receivedCalls.some((call) => call.endpointPath === "revisions")).toBe(true);
      await waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    });

    it("is turned down with the preview when the preview is discarded", async () => {
      const openPage = vi.fn();
      const { engine, renderResult } = await renderChartWithPageOpener(openPage);
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Discard" })));

      expect(openPage).not.toHaveBeenCalled();
      await waitFor(() => expect(engine.recordedActionRuns.map((run) => run.outcome)).toEqual(["cancelled"]));
      // The reply said it would happen, so the user is told it did not.
      expect(renderResult.getByText("Discarded, so this wasn't done: Open the Tables page.")).toBeTruthy();
    });

    it("keeps what waited for the preview while a follow-up leaves the preview showing", async () => {
      const openPage = vi.fn();
      const { engine, renderResult } = await renderChartWithPageOpener(openPage);
      engine.setPlanAcrossRegionsReply({ changes: [], message: "It shows the last twelve months." });
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
        target: { value: "what does the chart show?" },
      });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
      });
      await renderResult.findByText("It shows the last twelve months.");

      // The preview is still the one that request made, so what it asked for still waits on it.
      expect(openPage).not.toHaveBeenCalled();
      expect(engine.recordedActionRuns).toEqual([]);
      expect(renderResult.getByRole("button", { name: "Keep" })).toBeTruthy();
    });

    it("turns down what waited for the preview when a follow-up finds the screen changed elsewhere", async () => {
      const openPage = vi.fn();
      const { engine, renderResult } = await renderChartWithPageOpener(openPage);
      // In another tab, the user changed this screen.
      engine.regionState.revision = 1;
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
        target: { value: "and make it bigger" },
      });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
      });

      await renderResult.findByText("This screen was changed somewhere else. It has been refreshed, so please try again.");
      expect(renderResult.queryByRole("button", { name: "Keep" })).toBeNull();
      expect(renderResult.queryByText("Then: Open the Tables page.")).toBeNull();
      expect(openPage).not.toHaveBeenCalled();
      await waitFor(() => expect(engine.recordedActionRuns.map((run) => run.outcome)).toEqual(["cancelled"]));
      expect(renderResult.getByText("This screen changed, so that wasn't done. Please ask again.")).toBeTruthy();

      engine.setPlanAcrossRegionsReply({ changes: [], message: "Okay." });
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: "thanks" } });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
      });
      const [askingTurn] = engine.receivedCalls.filter((call) => call.endpointPath === "v1/plan").at(-1)!.requestBody
        .conversation;
      expect(askingTurn.reply).toContain(
        "[Outcome: Open a page — not done, as the screen changed before it was confirmed.]",
      );
    });

    it("leaves an action that only changes what is shown out of the past changes", async () => {
      const { engine, renderResult } = await renderChartWithPageOpener(() => {});
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Keep" })));
      await waitFor(() => expect(engine.recordedActionRuns).toHaveLength(1));
      cleanup();

      const { renderResult: laterVisit } = await renderChartWithPageOpener(() => {});
      await act(async () => {});
      expect(laterVisit.container.querySelector("[data-clickless-action-run]")).toBeNull();
    });
  });

  it("says in the one-line bar what will happen once the preview is kept or discarded", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
      actionCalls: [{ name: "openPage", arguments: { page: "tables" } }],
      message: "Revenue is hidden.",
    });
    function Dashboard() {
      useAdaptiveAction({
        name: "openPage",
        title: "Open a page",
        mode: "read",
        parameters: { page: { type: "text", values: ["tables"] } },
        confirm: () => "Open the Tables page.",
        run: () => {},
      });
      return (
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="sales" title="Sales" defaults={{ w: 6, h: 3 }}>
            sales
          </Adaptive>
        </AdaptiveRegion>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Dashboard />
        <PromptBar regionId="dashboard" />
      </AdaptiveProvider>,
    );
    await waitFor(() => expect(engine.receivedCalls.some((call) => call.endpointPath === "layout")).toBe(true));

    const promptInput = renderResult.getByLabelText("Describe a change to this screen");
    fireEvent.change(promptInput, { target: { value: "hide revenue and take me to tables" } });
    await act(async () => {
      fireEvent.submit(promptInput.closest("form")!);
    });

    expect(renderResult.getByText("Revenue is hidden.")).toBeTruthy();
    expect(renderResult.container.querySelector("[data-clickless-after-preview]")!.textContent).toBe(
      "Then: Open the Tables page.",
    );
  });

  it("keeps a change waiting to be confirmed when a request opens another page that offers it too", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [
        { name: "openPage", arguments: { page: "profile" } },
        { name: "updateName", arguments: { firstName: "Joshua" } },
      ],
      message: "Opening your profile.",
    });
    const updateName = vi.fn();
    function Application() {
      const [page, setPage] = useState("overview");
      useAdaptiveAction({
        name: "openPage",
        title: "Open a page",
        mode: "read",
        parameters: { page: { type: "text", values: ["overview", "profile"] } },
        run: ({ page: nextPage }) => setPage(String(nextPage)),
      });
      useAdaptiveAction({ name: "updateName", title: "Change your name", parameters: NAME_PARAMETERS, run: updateName });
      return <PromptPanel regionId={page} defaultOpen />;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Application />
      </AdaptiveProvider>,
    );
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "show my profile and call me Joshua" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
    });

    // On the profile page now, still asked to confirm, and nothing run yet.
    expect(renderResult.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(updateName).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Confirm" })));
    expect(updateName).toHaveBeenCalledWith({ firstName: "Joshua" });
    await waitFor(() =>
      expect(engine.recordedActionRuns.map((run) => [run.actionName, run.outcome])).toEqual([
        ["openPage", "done"],
        ["updateName", "done"],
      ]),
    );
    expect(engine.recordedActionRuns[1]!.screenId).toBe("overview");
  });

  it("keeps the reply in view when the request opens another page", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "openPage", arguments: { page: "forms" } }],
      message: "The revenue chart can't be red here. Opening the Forms page.",
    });
    function Application() {
      const [page, setPage] = useState("overview");
      useAdaptiveAction({
        name: "openPage",
        title: "Open a page",
        mode: "read",
        parameters: { page: { type: "text", values: ["overview", "forms"] } },
        run: ({ page: nextPage }) => setPage(String(nextPage)),
      });
      return <PromptPanel regionId={page} defaultOpen />;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Application />
      </AdaptiveProvider>,
    );
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "make the revenue chart red and take me to the forms page" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
    });

    // On the Forms page now, with the answer still there to read.
    await waitFor(() => expect(engine.receivedCalls.length).toBeGreaterThan(0));
    expect(renderResult.getByText("make the revenue chart red and take me to the forms page")).toBeTruthy();
    expect(renderResult.getByText("The revenue chart can't be red here. Opening the Forms page.")).toBeTruthy();
  });

  it("shows the request that opened another page after that page's saved changes", async () => {
    const engine = createFakeEngine();
    const earlierVisit = renderDashboardWithEngine(engine);
    await waitFor(() => expect(earlierVisit.regionApi().loading).toBe(false));
    const { applyOperations } = earlierVisit.regionApi();
    await act(() => applyOperations(MOVE_TRANSACTIONS_FIRST, "transactions first", "Transactions moved up."));
    await act(() => applyOperations([{ type: "hide", id: "revenue" }], "hide revenue", "Revenue is hidden."));
    cleanup();

    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "openPage", arguments: { page: "dashboard" } }],
      message: "Opening the dashboard.",
    });
    function Application() {
      const [page, setPage] = useState("overview");
      useAdaptiveAction({
        name: "openPage",
        title: "Open a page",
        mode: "read",
        parameters: { page: { type: "text", values: ["overview", "dashboard"] } },
        run: ({ page: nextPage }) => setPage(String(nextPage)),
      });
      return (
        <>
          {page === "dashboard" && (
            <AdaptiveRegion id="dashboard" version="1">
              <Adaptive id="balance" title="Account balance" locked defaults={{ w: 12, h: 1 }}>
                balance
              </Adaptive>
              <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
                revenue
              </Adaptive>
              <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
                txns
              </Adaptive>
            </AdaptiveRegion>
          )}
          <PromptPanel regionId={page} defaultOpen />
        </>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Application />
      </AdaptiveProvider>,
    );
    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "take me to the dashboard" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
    });

    // The dashboard's changes were saved before this visit, so the request comes after them.
    await renderResult.findByText("hide revenue");
    const shownBubbles = () =>
      [...renderResult.container.querySelectorAll("[data-clickless-bubble]")].map((bubbleElement) => bubbleElement.textContent);
    await waitFor(() =>
      expect(shownBubbles()).toEqual([
        "transactions first",
        "Transactions moved up.",
        "hide revenue",
        "Revenue is hidden.",
        "take me to the dashboard",
        "Opening the dashboard.",
      ]),
    );
  });

  it("previews a change to the page and asks to confirm an action from the same request", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "Revenue is hidden.",
    });
    const updateName = vi.fn();
    function Dashboard() {
      useAdaptiveAction({ name: "updateName", title: "Change your name", parameters: NAME_PARAMETERS, run: updateName });
      return (
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="sales" title="Sales" defaults={{ w: 6, h: 3 }}>
            sales
          </Adaptive>
        </AdaptiveRegion>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Dashboard />
        <PromptPanel regionId="dashboard" defaultOpen />
      </AdaptiveProvider>,
    );
    await waitFor(() => expect(engine.receivedCalls.some((call) => call.endpointPath === "layout")).toBe(true));

    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), {
      target: { value: "hide revenue and call me Joshua" },
    });
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
    });

    const planRequest = engine.receivedCalls.find((call) => call.endpointPath === "v1/plan")!.requestBody;
    expect(planRequest.regions.map((region: { manifest: { regionId: string } }) => region.manifest.regionId)).toEqual([
      "dashboard",
    ]);
    expect(renderResult.container.querySelector<HTMLElement>('[data-clickless-item="revenue"]')!.style.display).toBe(
      "none",
    );
    expect(renderResult.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(renderResult.getByRole("button", { name: "Confirm" })).toBeTruthy();
    // The reply covers the preview, and what Confirm will do is said beside it.
    expect(renderResult.getByText("Revenue is hidden.")).toBeTruthy();
    expect(renderResult.container.querySelector("[data-clickless-confirmation]")!.textContent).toContain(
      "Change your name. First name: Joshua.",
    );

    // Keeping the change puts the request in the history; what the action did still shows.
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Keep" })));
    updateName.mockResolvedValueOnce("Your name has been changed.");
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Confirm" })));
    await waitFor(() => expect(renderResult.getByText("Your name has been changed.")).toBeTruthy());
    expect(renderResult.getAllByText("hide revenue and call me Joshua")).toHaveLength(1);
    // The screen was saved before the name was changed, and they read in that order.
    const shownBubbles = [...renderResult.container.querySelectorAll("[data-clickless-bubble]")].map(
      (bubbleElement) => bubbleElement.textContent,
    );
    expect(shownBubbles.slice(-2)).toEqual([
      "Your change to this screen is saved. The rest still needs you to confirm it.",
      "Your name has been changed.",
    ]);
    expect(renderResult.getByText("Your name has been changed.").getAttribute("role")).toBe("status");
  });

  it("keeps a later request in its own place after sentences said while a change to data waited", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "Revenue is hidden.",
    });
    function Dashboard() {
      useAdaptiveAction({ name: "updateName", title: "Change your name", parameters: NAME_PARAMETERS, run: vi.fn() });
      return (
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="sales" title="Sales" defaults={{ w: 6, h: 3 }}>
            sales
          </Adaptive>
        </AdaptiveRegion>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Dashboard />
        <PromptPanel regionId="dashboard" defaultOpen />
      </AdaptiveProvider>,
    );
    await waitFor(() => expect(engine.receivedCalls.some((call) => call.endpointPath === "layout")).toBe(true));
    const sendPrompt = async (prompt: string) => {
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: prompt } });
      await act(async () => {
        fireEvent.click(renderResult.getByRole("button", { name: "Send" }));
      });
    };
    const shownBubbles = () =>
      [...renderResult.container.querySelectorAll("[data-clickless-bubble]")].map((bubbleElement) => bubbleElement.textContent);

    await sendPrompt("hide revenue and call me Joshua");
    await act(async () => fireEvent.click(await renderResult.findByRole("button", { name: "Keep" })));
    await renderResult.findByText("Your change to this screen is saved. The rest still needs you to confirm it.");
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(shownBubbles().at(-1)).toMatch(/^Undone/));
    const undoneSentence = shownBubbles().at(-1)!;

    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "sales" }] }],
      message: "Sales is hidden.",
    });
    await sendPrompt("hide sales");
    await act(async () => fireEvent.click(await renderResult.findByRole("button", { name: "Keep" })));
    await renderResult.findByText("Your change to this screen is saved.");

    // Each line reads where it was said, and the kept request is shown once, as saved.
    expect(renderResult.getAllByText("hide sales")).toHaveLength(1);
    const bubbles = shownBubbles();
    expect(bubbles.slice(bubbles.indexOf(undoneSentence))).toEqual([
      undoneSentence,
      "Cancelled, as you asked for something else.",
      "hide sales",
      "Sales is hidden.",
      "Your change to this screen is saved.",
    ]);
  });

  it("plans a follow-up on a screen with actions from the preview, and leaves waiting what the request before asked for", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "Revenue is hidden, and I'll change your first name to Joshua.",
    });
    const updateName = vi.fn();
    function Dashboard() {
      useAdaptiveAction({ name: "updateName", title: "Change your name", parameters: NAME_PARAMETERS, run: updateName });
      return (
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
            txns
          </Adaptive>
          <Adaptive id="notes" title="Notes" defaults={{ w: 12, h: 2 }}>
            notes
          </Adaptive>
        </AdaptiveRegion>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Dashboard />
        <PromptPanel regionId="dashboard" defaultOpen />
      </AdaptiveProvider>,
    );
    await waitFor(() => expect(engine.receivedCalls.some((call) => call.endpointPath === "layout")).toBe(true));
    const sendRequest = async (request: string) => {
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: request } });
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Send" })));
    };
    const isHidden = (componentId: string) =>
      renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!.style.display === "none";

    await sendRequest("hide revenue and call me Joshua");
    expect(renderResult.getByRole("button", { name: "Confirm" })).toBeTruthy();

    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "txns" }] }],
      message: "Transactions is hidden too.",
    });
    await sendRequest("and hide transactions");
    await renderResult.findByText("Transactions is hidden too.");

    const followUpRequest = engine.receivedCalls.filter((call) => call.endpointPath === "v1/plan").at(-1)!.requestBody;
    expect(followUpRequest.regions[0].preview).toEqual({ operations: [{ type: "hide", id: "revenue" }], baseRevision: 0 });
    // The action belongs to the request the follow-up built on, which is still waiting to be kept.
    expect(renderResult.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(engine.recordedActionRuns).toEqual([]);
    expect(isHidden("revenue")).toBe(true);
    expect(isHidden("txns")).toBe(true);

    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Keep" })));
    // Keep saved only the screen, and says the change to data still waits.
    await renderResult.findByText("Your change to this screen is saved. The rest still needs you to confirm it.");
    expect(engine.receivedCalls.filter((call) => call.endpointPath === "revisions").at(-1)!.requestBody).toMatchObject({
      operations: [
        { type: "hide", id: "revenue" },
        { type: "hide", id: "txns" },
      ],
      prompt: "hide revenue and call me Joshua\nand hide transactions",
    });
    // The history shows the follow-up now, with the request it built on.
    expect(renderResult.queryByText("and hide transactions")).toBeNull();
    updateName.mockResolvedValueOnce("Your name has been changed.");
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Confirm" })));
    await waitFor(() => expect(renderResult.getByText("Your name has been changed.")).toBeTruthy());

    // What came of the action belongs to the request that asked for it, not to the follow-up.
    engine.setPlanAcrossRegionsReply({ changes: [], message: "Okay." });
    await sendRequest("thanks");
    const [askingTurn, followUpTurn] = engine.receivedCalls.filter((call) => call.endpointPath === "v1/plan").at(-1)!
      .requestBody.conversation;
    expect(askingTurn.reply).toContain("[Outcome: Change your name — done.]");
    expect(followUpTurn.reply).toBe("Transactions is hidden too.");
  });

  it("turns down what waited on a preview when a request replaces it", async () => {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [{ regionId: "dashboard", operations: [{ type: "hide", id: "revenue" }] }],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Joshua" } }],
      message: "Revenue is hidden, and I'll change your first name to Joshua.",
    });
    function Dashboard() {
      useAdaptiveAction({ name: "updateName", title: "Change your name", parameters: NAME_PARAMETERS, run: () => {} });
      return (
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
          <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
            txns
          </Adaptive>
        </AdaptiveRegion>
      );
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <Dashboard />
        <PromptPanel regionId="dashboard" defaultOpen />
      </AdaptiveProvider>,
    );
    await waitFor(() => expect(engine.receivedCalls.some((call) => call.endpointPath === "layout")).toBe(true));
    const sendRequest = async (request: string) => {
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: request } });
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Send" })));
    };
    await sendRequest("hide revenue and call me Joshua");

    // An answer with an action of its own is a new request, not a follow-up to the old one's.
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "updateName", arguments: { firstName: "Josh" } }],
      message: "I'll change your first name to Josh.",
    });
    await sendRequest("actually, call me Josh");
    await renderResult.findByText("I'll change your first name to Josh.");
    await waitFor(() =>
      expect(engine.recordedActionRuns.map((actionRun) => [actionRun.actionName, actionRun.outcome])).toEqual([
        ["updateName", "cancelled"],
      ]),
    );
    expect(renderResult.getAllByRole("button", { name: "Confirm" })).toHaveLength(1);

    // The note goes to the request whose action was turned down, not to the one that replaced it.
    engine.setPlanAcrossRegionsReply({ changes: [], message: "Okay." });
    await sendRequest("thanks");
    const [askingTurn, replacingTurn] = engine.receivedCalls.filter((call) => call.endpointPath === "v1/plan").at(-1)!
      .requestBody.conversation;
    expect(askingTurn.reply).toContain(
      "[Outcome: Change your name — cancelled, as the user asked for something else.]",
    );
    expect(replacingTurn.reply).toBe("I'll change your first name to Josh.");
  });
});

describe("what the planner is told of an action's result", () => {
  const INVOICE_DETAILS = "Invoice INV-2041 for Acme Ltd, £12,400, contact sam@acme.com, is marked paid.";
  const INVOICE_FAILURE = "Invoice INV-2041 for Acme Ltd was already paid by sam@acme.com.";

  /** An invoicing screen whose action says, in what it returns, things about the customer. */
  async function markInvoicePaidThenAskAgain(
    run: () => unknown,
    { shareResultWithPlanner }: { shareResultWithPlanner?: boolean } = {},
  ) {
    const engine = createFakeEngine();
    engine.setPlanAcrossRegionsReply({
      changes: [],
      actionCalls: [{ name: "markInvoicePaid", arguments: { invoiceNumber: "INV-2041" } }],
      message: "",
    });
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <AdaptiveAction
          name="markInvoicePaid"
          title="Mark an invoice paid"
          parameters={{ invoiceNumber: { type: "text", description: "Invoice number" } }}
          run={run}
          {...(shareResultWithPlanner !== undefined && { shareResultWithPlanner })}
        />
        <PromptPanel regionId="invoices" defaultOpen />
      </AdaptiveProvider>,
    );
    const sendRequest = async (request: string) => {
      fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: request } });
      await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Send" })));
    };
    await sendRequest("mark INV-2041 paid");
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Confirm" })));

    engine.setPlanAcrossRegionsReply({ changes: [], message: "Done." });
    await sendRequest("make the sidebar narrower");
    const [askingTurn] = engine.receivedCalls.filter((call) => call.endpointPath === "v1/plan").at(-1)!.requestBody
      .conversation;
    return { renderResult, sentReply: askingTurn.reply as string };
  }

  it("tells the planner only the action's title and that it was done, while the user sees what it returned", async () => {
    const { renderResult, sentReply } = await markInvoicePaidThenAskAgain(() => INVOICE_DETAILS);

    expect(renderResult.getByText(INVOICE_DETAILS)).toBeTruthy();
    expect(sentReply).toBe("[Outcome: Mark an invoice paid — done.]");
  });

  it("tells the planner only that it failed, while the user sees why", async () => {
    const { renderResult, sentReply } = await markInvoicePaidThenAskAgain(() => {
      throw new ActionError(INVOICE_FAILURE);
    });

    expect(renderResult.getByText(INVOICE_FAILURE)).toBeTruthy();
    expect(sentReply).toBe("[Outcome: Mark an invoice paid — failed.]");
  });

  it("tells the planner what it returned when the action shares it", async () => {
    const { renderResult, sentReply } = await markInvoicePaidThenAskAgain(() => INVOICE_DETAILS, {
      shareResultWithPlanner: true,
    });

    expect(renderResult.getByText(INVOICE_DETAILS)).toBeTruthy();
    expect(sentReply).toBe(`[Outcome: ${INVOICE_DETAILS}]`);
  });

  it("tells the planner why it failed when the action shares it", async () => {
    const { renderResult, sentReply } = await markInvoicePaidThenAskAgain(
      () => {
        throw new ActionError(INVOICE_FAILURE);
      },
      { shareResultWithPlanner: true },
    );

    expect(renderResult.getByText(INVOICE_FAILURE)).toBeTruthy();
    expect(sentReply).toBe(`[Outcome: ${INVOICE_FAILURE}]`);
  });
});
