// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptPanel, useDictation } from "../src/index";
import { createFakeEngine, renderDashboardWithEngine } from "./dashboardWithFakeEngine";

const SILENT_SAMPLE = 128;
const SPEECH_SAMPLE = 160;
const SOUND_LEVEL_PROPERTY = "--clickless-dictation-level";

/** What the stand-in browser did with the microphone, for a test to look at. */
let fakeMicrophone: {
  /** The value every sample of the signal has: 128 is silence. */
  sampleValue: number;
  getUserMedia: ReturnType<typeof vi.fn>;
  trackStops: ReturnType<typeof vi.fn>;
  recorders: FakeMediaRecorder[];
  audioContexts: FakeAudioContext[];
};

class FakeMediaRecorder {
  static isTypeSupported = (mimeFormat: string) => mimeFormat === "audio/webm;codecs=opus";
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    _stream: unknown,
    readonly recorderOptions: { mimeType?: string; audioBitsPerSecond?: number },
  ) {
    this.mimeType = recorderOptions.mimeType ?? "";
    fakeMicrophone.recorders.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["spoken audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  state = "running";
  closed = false;

  constructor() {
    fakeMicrophone.audioContexts.push(this);
  }

  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData: (waveformSamples: Uint8Array) => waveformSamples.fill(fakeMicrophone.sampleValue) };
  }

  createMediaStreamSource() {
    return { connect() {} };
  }

  resume() {
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

beforeEach(() => {
  fakeMicrophone = {
    sampleValue: SPEECH_SAMPLE,
    trackStops: vi.fn(),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: fakeMicrophone.trackStops }] })),
    recorders: [],
    audioContexts: [],
  };
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: fakeMicrophone.getUserMedia },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("speaking a request in PromptPanel", () => {
  const MICROPHONE_BUTTON = { name: "Speak your request" };

  /** Counts the times the engine is asked whether it turns speech into text. */
  function countFeaturesRequests(engine: ReturnType<typeof createFakeEngine>) {
    const featuresRequested = vi.fn();
    const engineFetch = engine.engineOptions.fetch;
    engine.engineOptions.fetch = (requestInput, requestInit) => {
      if (String(requestInput).endsWith("/v1/features")) featuresRequested();
      return engineFetch(requestInput, requestInit);
    };
    return featuresRequested;
  }

  async function renderPanel(engine = createFakeEngine(), panelElement = <PromptPanel dictation regionId="dashboard" defaultOpen />) {
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, panelElement);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    const promptInput = () => renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
    return { engine, renderResult, promptInput };
  }

  async function renderPanelAndStartSpeaking(transcriptionReply: Parameters<ReturnType<typeof createFakeEngine>["offerDictation"]>[0]) {
    const engine = createFakeEngine();
    engine.offerDictation(transcriptionReply);
    const panelSession = await renderPanel(engine);
    await act(async () => {
      fireEvent.click(await panelSession.renderResult.findByRole("button", MICROPHONE_BUTTON));
    });
    await panelSession.renderResult.findByText("Listening…");
    return panelSession;
  }

  const finishSpeaking = (renderResult: Awaited<ReturnType<typeof renderPanel>>["renderResult"]) =>
    act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Done" }));
    });

  it("has no microphone button unless the engine turns speech into text", async () => {
    const { renderResult, engine } = await renderPanel();
    // Give the answer time to arrive before deciding the button is not coming.
    await waitFor(() => expect(engine.receivedRecordings).toEqual([]));
    await act(async () => {});
    expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();
  });

  it("has no microphone button in a browser that cannot record, and does not ask the engine", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const engine = createFakeEngine();
    engine.offerDictation({ text: "" });
    const featuresRequested = countFeaturesRequests(engine);
    const { renderResult } = await renderPanel(engine);
    await act(async () => {});
    expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();
    expect(featuresRequested).not.toHaveBeenCalled();
  });

  it("has no microphone button, and does not ask the engine, unless the host turns it on", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "" });
    const featuresRequested = countFeaturesRequests(engine);
    const { renderResult } = await renderPanel(engine, <PromptPanel regionId="dashboard" defaultOpen />);
    await act(async () => {});
    expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();
    expect(featuresRequested).not.toHaveBeenCalled();
  });

  it("marks its microphone button for a stylesheet, and takes other wording for all of it", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    let handOverMicrophone!: (stream: unknown) => void;
    fakeMicrophone.getUserMedia.mockReturnValue(new Promise((resolve) => (handOverMicrophone = resolve)));
    const { renderResult } = await renderPanel(
      engine,
      <PromptPanel dictation
        regionId="dashboard"
        defaultOpen
        dictationLabels={{ speak: "Dictate", starting: "One moment", listening: "Go ahead", done: "Finished" }}
      />,
    );

    const microphoneButton = await renderResult.findByRole("button", { name: "Dictate" });
    expect(microphoneButton.getAttribute("data-clickless-dictation")).toBe("start");
    expect(microphoneButton.title).toBe("Dictate");
    fireEvent.click(microphoneButton);
    await renderResult.findByText("One moment");
    await act(async () => handOverMicrophone({ getTracks: () => [{ stop: fakeMicrophone.trackStops }] }));
    await renderResult.findByText("Go ahead");
    // Wording that was not replaced keeps its default.
    expect(renderResult.getByRole("button", { name: "Cancel" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Finished" }));
    });
  });

  it("draws the host's own microphone button in place of the built-in one", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const { renderResult, promptInput } = await renderPanel(
      engine,
      <PromptPanel dictation
        regionId="dashboard"
        defaultOpen
        dictationLabels={{ speak: "Talk to it" }}
        renderDictationButton={({ start, disabled, label }) => (
          <button type="button" className="host-mic" disabled={disabled} onClick={start}>
            {label}
          </button>
        )}
      />,
    );

    const hostButton = await renderResult.findByRole("button", { name: "Talk to it" });
    expect(hostButton.className).toBe("host-mic");
    expect(renderResult.container.querySelector('[data-clickless-dictation="start"]')).toBeNull();
    await act(async () => {
      fireEvent.click(hostButton);
    });
    await renderResult.findByText("Listening…");
    // Like the built-in one, it gives way to Done and Cancel while the user speaks.
    expect(renderResult.queryByRole("button", { name: "Talk to it" })).toBeNull();
    await finishSpeaking(renderResult);
    await waitFor(() => expect(promptInput().value).toBe("hide revenue"));
    expect(renderResult.getByRole("button", { name: "Talk to it" })).toBeTruthy();
  });

  it("does not draw the host's button when the engine offers no dictation", async () => {
    const { renderResult } = await renderPanel(
      createFakeEngine(),
      <PromptPanel dictation regionId="dashboard" defaultOpen renderDictationButton={() => <button type="button">Talk to it</button>} />,
    );
    await act(async () => {});
    expect(renderResult.queryByRole("button", { name: "Talk to it" })).toBeNull();
  });

  it("adds what was said after what was typed, and sends nothing until the user asks", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: " hide the revenue chart\n" });
    const { renderResult, promptInput } = await renderPanel(engine);
    fireEvent.change(promptInput(), { target: { value: "Put transactions first and " } });

    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });
    await renderResult.findByText("Listening…");
    // The box cannot be typed in, or sent, while the user is speaking.
    expect(promptInput().readOnly).toBe(true);
    expect((renderResult.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(renderResult.getByRole("button", { name: "Done" }));
    const soundBars = renderResult.container.querySelector<HTMLElement>('[data-clickless-dictation="recording"]')!;
    await waitFor(() => expect(soundBars.style.getPropertyValue(SOUND_LEVEL_PROPERTY)).toBe("1.00"));

    await finishSpeaking(renderResult);
    await waitFor(() => expect(promptInput().value).toBe("Put transactions first and hide the revenue chart"));

    expect(renderResult.queryByText("Listening…")).toBeNull();
    expect(document.activeElement).toBe(promptInput());
    expect(promptInput().readOnly).toBe(false);
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(fakeMicrophone.audioContexts.map((audioContext) => audioContext.closed)).toEqual([true]);
    expect(fakeMicrophone.recorders[0]!.recorderOptions).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });

    const [sentRecording] = engine.receivedRecordings;
    expect(engine.receivedRecordings).toHaveLength(1);
    expect(sentRecording!.contentType).toBe("audio/webm;codecs=opus");
    expect(await sentRecording!.recording.text()).toBe("spoken audio");
    expect(sentRecording!.hints).toEqual(["Account balance", "Revenue", "Transactions"]);
    expect(sentRecording!.token).toBe("Bearer signed-token");
    // Speaking fills the box. It does not ask for the change.
    expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "plan")).toBe(false);
  });

  it("marks a spoken prompt as made by voice when it is submitted", async () => {
    const { renderResult, engine, promptInput } = await renderPanelAndStartSpeaking({
      text: "hide revenue",
    });
    await finishSpeaking(renderResult);
    await waitFor(() => expect(promptInput().value).toBe("hide revenue"));
    await act(async () => {
      fireEvent.keyDown(promptInput(), { key: "Enter" });
    });
    await waitFor(() =>
      expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "plan")).toBe(true),
    );
    expect(
      engine.receivedCalls.find((engineCall) => engineCall.endpointPath === "plan")?.requestBody.viaVoice,
    ).toBe(true);
  });

  it("does not mark a typed prompt as made by voice", async () => {
    const engine = createFakeEngine();
    const { promptInput } = await renderPanel(engine);
    fireEvent.change(promptInput(), { target: { value: "hide revenue" } });
    await act(async () => {
      fireEvent.keyDown(promptInput(), { key: "Enter" });
    });
    await waitFor(() =>
      expect(engine.receivedCalls.some((engineCall) => engineCall.endpointPath === "plan")).toBe(true),
    );
    expect(
      engine.receivedCalls.find((engineCall) => engineCall.endpointPath === "plan")?.requestBody.viaVoice,
    ).toBeUndefined();
  });

  it("lets go of everything when the microphone is taken away mid-recording", async () => {
    const { renderResult, engine, promptInput } = await renderPanelAndStartSpeaking({ text: "hide revenue" });
    // Unplugged, or permission withdrawn: the browser ends the recording itself.
    await act(async () => fakeMicrophone.recorders[0]!.stop());

    await waitFor(() => expect(promptInput().value).toBe("hide revenue"));
    expect(engine.receivedRecordings).toHaveLength(1);
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(fakeMicrophone.audioContexts[0]!.closed).toBe(true);
    expect(renderResult.queryByText("Listening…")).toBeNull();
    expect(renderResult.getByRole("button", MICROPHONE_BUTTON)).toBeTruthy();
  });

  it("says so, and lets the microphone go, when recording cannot begin", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const { renderResult } = await renderPanel(engine);
    vi.spyOn(FakeMediaRecorder.prototype, "start").mockImplementationOnce(() => {
      throw new Error("the stream cannot be recorded");
    });
    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });

    expect((await renderResult.findByRole("alert")).textContent).toBe(
      "The microphone couldn't be started. Please try again, or type what you want.",
    );
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(fakeMicrophone.audioContexts[0]!.closed).toBe(true);
    expect(renderResult.getByRole("button", MICROPHONE_BUTTON)).toBeTruthy();
  });

  it("takes the button away, and ends a recording, when the host turns it off later", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const pageWithPanel = (offerDictation: boolean) => (
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <PromptPanel regionId="dashboard" defaultOpen dictation={offerDictation} />
        <AdaptiveRegion id="dashboard" version="1">
          <Adaptive id="revenue" title="Revenue" defaults={{ w: 6, h: 3 }}>
            revenue
          </Adaptive>
        </AdaptiveRegion>
      </AdaptiveProvider>
    );
    const renderResult = render(pageWithPanel(true));
    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });
    await renderResult.findByText("Listening…");
    const promptInputBefore = renderResult.getByLabelText("Describe a change to this screen");

    renderResult.rerender(pageWithPanel(false));

    // The same panel, told something new, and not a fresh one in its place.
    expect(renderResult.getByLabelText("Describe a change to this screen")).toBe(promptInputBefore);
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(renderResult.queryByText("Listening…")).toBeNull();
    expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();
    expect(engine.receivedRecordings).toEqual([]);
  });

  it("sends only hints the engine will take, in an address short enough to arrive", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const longTitles = Array.from({ length: 6 }, (_, titleIndex) => `${titleIndex}`.padEnd(80, "売"));
    const pageWithTitles = (
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <PromptPanel dictation regionId="dashboard" defaultOpen />
        <AdaptiveRegion id="dashboard" version="1">
          {["Revenue", "bad\0title", " Revenue ", ...longTitles, "Costs"].map((title, titleIndex) => (
            <Adaptive key={titleIndex} id={`section-${titleIndex}`} title={title} defaults={{ w: 6, h: 3 }}>
              section
            </Adaptive>
          ))}
        </AdaptiveRegion>
      </AdaptiveProvider>
    );
    const sentAddresses: string[] = [];
    const engineFetch = engine.engineOptions.fetch;
    engine.engineOptions.fetch = (requestInput, requestInit) => {
      sentAddresses.push(String(requestInput));
      return engineFetch(requestInput, requestInit);
    };
    const renderResult = render(pageWithTitles);
    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });
    await renderResult.findByText("Listening…");
    await finishSpeaking(renderResult);
    await waitFor(() => expect(engine.receivedRecordings).toHaveLength(1));

    const sentHints = engine.receivedRecordings[0]!.hints;
    // No NUL character, nothing twice, and the long ones only while there is room:
    // the short one after them still goes.
    expect(sentHints.slice(0, 1)).toEqual(["Revenue"]);
    expect(sentHints.at(-1)).toBe("Costs");
    expect(sentHints.some((sentHint) => sentHint.includes("\0"))).toBe(false);
    expect(sentHints.filter((sentHint) => sentHint.trim() === "Revenue")).toHaveLength(1);
    const longTitlesSent = sentHints.filter((sentHint) => sentHint.length === 80).length;
    expect(longTitlesSent).toBeGreaterThan(0);
    expect(longTitlesSent).toBeLessThan(longTitles.length);
    const transcriptionAddress = sentAddresses.find((sentAddress) => sentAddress.includes("/v1/transcriptions"))!;
    expect(new URL(transcriptionAddress).search.length).toBeLessThanOrEqual(2001);
  });

  it("leaves the focus where the user put it while their words were being turned into text", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const { renderResult, promptInput } = await renderPanel(
      engine,
      <>
        <input aria-label="A field of the application's own" />
        <PromptPanel dictation regionId="dashboard" defaultOpen closeOnOutsideClick={false} />
      </>,
    );
    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });
    await renderResult.findByText("Listening…");
    const applicationField = renderResult.getByLabelText("A field of the application's own");
    fireEvent.click(renderResult.getByRole("button", { name: "Done" }));
    applicationField.focus();

    await waitFor(() => expect(promptInput().value).toBe("hide revenue"));
    expect(document.activeElement).toBe(applicationField);
  });

  it("throws the recording away when cancelled", async () => {
    const { renderResult, engine, promptInput } = await renderPanelAndStartSpeaking({ text: "hide revenue" });
    fireEvent.click(renderResult.getByRole("button", { name: "Cancel" }));

    expect(renderResult.queryByText("Listening…")).toBeNull();
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(fakeMicrophone.audioContexts[0]!.closed).toBe(true);
    await act(async () => {});
    expect(engine.receivedRecordings).toEqual([]);
    expect(promptInput().value).toBe("");
    expect(renderResult.getByRole("button", MICROPHONE_BUTTON)).toBeTruthy();
  });

  it("lets the microphone go when the panel is put away", async () => {
    const { renderResult, engine } = await renderPanelAndStartSpeaking({ text: "hide revenue" });
    fireEvent.click(renderResult.getByRole("button", { name: "Minimise" }));

    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(engine.receivedRecordings).toEqual([]);
  });

  it("does not send a recording in which nothing was said", async () => {
    fakeMicrophone.sampleValue = SILENT_SAMPLE;
    const { renderResult, engine } = await renderPanelAndStartSpeaking({ text: "should never be asked for" });
    // Long enough for the silence to have been measured.
    await waitFor(() => expect(fakeMicrophone.audioContexts).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await finishSpeaking(renderResult);

    expect((await renderResult.findByRole("alert")).textContent).toBe("We couldn't hear anything. Please try again.");
    expect(engine.receivedRecordings).toEqual([]);
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
  });

  it("sends the recording when the browser cannot measure how loud it is", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { renderResult, engine, promptInput } = await renderPanelAndStartSpeaking({ text: "hide revenue" });
    await finishSpeaking(renderResult);
    await waitFor(() => expect(promptInput().value).toBe("hide revenue"));
    expect(engine.receivedRecordings).toHaveLength(1);
  });

  it.each([
    [{ text: "  " }, "We couldn't hear anything. Please try again."],
    [
      { error: [503, { code: "transcriber_unavailable", message: "The recording could not be transcribed" }] as [number, object] },
      "Speaking isn't available right now. You can still type what you want.",
    ],
    [
      { error: [429, { code: "too_many_requests", message: "At most 20 recordings a minute" }] as [number, object] },
      "You've asked for a lot in a short time. Please wait a minute and try again.",
    ],
  ])("says in plain words why a recording gave no text: %j", async (transcriptionReply, expectedSentence) => {
    const { renderResult, promptInput } = await renderPanelAndStartSpeaking(transcriptionReply);
    await finishSpeaking(renderResult);

    expect((await renderResult.findByRole("alert")).textContent).toBe(expectedSentence);
    expect(promptInput().value).toBe("");
    // Typing is the way on from here, and clears the sentence.
    fireEvent.change(promptInput(), { target: { value: "h" } });
    expect(renderResult.queryByRole("alert")).toBeNull();
  });

  it.each(["", "my password is hunter2"])(
    "says what the engine said, and puts nothing in the box, when it keeps back what was said: %j",
    async (spokenText) => {
      const safetyMessage = "That looked like a password or other private detail, so it wasn't sent. Please leave it out.";
      const { renderResult, promptInput } = await renderPanelAndStartSpeaking({ text: spokenText, message: safetyMessage });
      await finishSpeaking(renderResult);

      expect((await renderResult.findByRole("alert")).textContent).toBe(safetyMessage);
      expect(promptInput().value).toBe("");
    },
  );

  it.each([
    ["NotAllowedError", "Allow microphone access in your browser to speak your request."],
    ["NotFoundError", "We couldn't find a microphone. You can still type what you want."],
    ["NotReadableError", "The microphone couldn't be started. Please try again, or type what you want."],
  ])("says what to do when the microphone cannot be used: %s", async (errorName, expectedSentence) => {
    fakeMicrophone.getUserMedia.mockRejectedValue(Object.assign(new Error("refused"), { name: errorName }));
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const { renderResult } = await renderPanel(engine);
    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });

    expect((await renderResult.findByRole("alert")).textContent).toBe(expectedSentence);
    expect(fakeMicrophone.recorders).toEqual([]);
    expect(renderResult.getByRole("button", MICROPHONE_BUTTON)).toBeTruthy();
  });

  it("lets the microphone go if the user cancels while the browser is still asking for it", async () => {
    let handOverMicrophone!: (stream: unknown) => void;
    fakeMicrophone.getUserMedia.mockReturnValue(new Promise((resolve) => (handOverMicrophone = resolve)));
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const { renderResult } = await renderPanel(engine);
    fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    await renderResult.findByText("Getting the microphone ready…");

    fireEvent.click(renderResult.getByRole("button", { name: "Cancel" }));
    await act(async () => handOverMicrophone({ getTracks: () => [{ stop: fakeMicrophone.trackStops }] }));

    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(fakeMicrophone.recorders).toEqual([]);
    expect(renderResult.queryByText("Listening…")).toBeNull();
  });
});

describe("speaking a request when the engine lets it down", () => {
  const MICROPHONE_BUTTON = { name: "Speak your request" };

  /** The stand-in engine, offering dictation, with the features question and recordings able to fail. */
  function createEngineWithFailingSpeech() {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const speechFailures = {
      features: null as "error" | "hang" | null,
      transcription: null as "network" | "token" | null,
    };
    const failingEngine = {
      ...engine,
      engineOptions: {
        ...engine.engineOptions,
        getToken: async () => {
          if (speechFailures.transcription === "token") throw new Error("the host's sign-in service is down");
          return "signed-token";
        },
        fetch: (async (requestInput, requestInit) => {
          const requestAddress = String(requestInput);
          if (requestAddress.endsWith("/v1/features")) {
            if (speechFailures.features === "error") return new Response("Internal server error", { status: 500 });
            // Pays no attention to being stopped, as some hosts' own `fetch` does not.
            if (speechFailures.features === "hang") return new Promise(() => {});
          }
          if (requestAddress.includes("/v1/transcriptions") && speechFailures.transcription === "network") {
            throw new TypeError("Failed to fetch");
          }
          return engine.engineOptions.fetch(requestInput, requestInit);
        }) as typeof fetch,
      },
    };
    return { engine: failingEngine, speechFailures };
  }

  it("offers no microphone, and still takes typed requests, when asking what the engine can do fails", async () => {
    const { engine, speechFailures } = createEngineWithFailingSpeech();
    speechFailures.features = "error";
    engine.setPlanReply({ operations: [{ type: "hide", id: "revenue" }], message: "Revenue is hidden." });
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel dictation regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(async () => {});
    expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();

    fireEvent.change(renderResult.getByLabelText("Describe a change to this screen"), { target: { value: "hide revenue" } });
    await act(async () => fireEvent.click(renderResult.getByRole("button", { name: "Preview" })));
    expect(await renderResult.findByText("Revenue is hidden.")).toBeTruthy();
  });

  it("offers no microphone, and holds nothing up, while asking what the engine can do gets no answer", async () => {
    vi.useFakeTimers();
    try {
      const { engine, speechFailures } = createEngineWithFailingSpeech();
      speechFailures.features = "hang";
      const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel dictation regionId="dashboard" defaultOpen />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(regionApi().loading).toBe(false);
      const promptInput = renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
      expect(promptInput.readOnly).toBe(false);
      expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();

      // Given up on at the time limit, and still no microphone.
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(renderResult.queryByRole("button", MICROPHONE_BUTTON)).toBeNull();
      expect(promptInput.readOnly).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["network", "the engine cannot be reached"],
    ["token", "the host cannot give a token"],
  ] as const)("says plainly that nothing came of a recording when %s fails (%s)", async (failingPart, _description) => {
    const { engine, speechFailures } = createEngineWithFailingSpeech();
    const { renderResult, regionApi } = renderDashboardWithEngine(engine, <PromptPanel dictation regionId="dashboard" defaultOpen />);
    await waitFor(() => expect(regionApi().loading).toBe(false));
    await act(async () => {
      fireEvent.click(await renderResult.findByRole("button", MICROPHONE_BUTTON));
    });
    await renderResult.findByText("Listening…");

    speechFailures.transcription = failingPart;
    await act(async () => {
      fireEvent.click(renderResult.getByRole("button", { name: "Done" }));
    });
    expect((await renderResult.findByRole("alert")).textContent).toBe(
      "Personalising isn't available right now. Please try again in a little while.",
    );
    const promptInput = renderResult.getByLabelText("Describe a change to this screen") as HTMLTextAreaElement;
    expect(promptInput.value).toBe("");
    expect(promptInput.readOnly).toBe(false);
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(engine.receivedRecordings).toEqual([]);
  });
});

describe("useDictation", () => {
  it("ends a recording for the user once it reaches the longest allowed", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    const heardTranscripts: [string, boolean][] = [];
    function SpeakButton() {
      const dictation = useDictation({
        maxSeconds: 0,
        onTranscript: (transcript, isFinal) => heardTranscripts.push([transcript, isFinal]),
      });
      return dictation.available ? <button onClick={dictation.start}>{dictation.status}</button> : null;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <SpeakButton />
      </AdaptiveProvider>,
    );

    fireEvent.click(await renderResult.findByRole("button", { name: "idle" }));
    await renderResult.findByRole("button", { name: "recording" });
    await waitFor(() => expect(heardTranscripts).toEqual([["hide revenue", true]]));
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    await renderResult.findByRole("button", { name: "idle" });
  });

  it("lets the microphone go when unmounted mid-recording", async () => {
    const engine = createFakeEngine();
    engine.offerDictation({ text: "hide revenue" });
    function SpeakButton() {
      const dictation = useDictation({ onTranscript: () => {} });
      return dictation.available ? <button onClick={dictation.start}>{dictation.status}</button> : null;
    }
    const renderResult = render(
      <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
        <SpeakButton />
      </AdaptiveProvider>,
    );
    fireEvent.click(await renderResult.findByRole("button", { name: "idle" }));
    await renderResult.findByRole("button", { name: "recording" });

    renderResult.unmount();
    expect(fakeMicrophone.trackStops).toHaveBeenCalledTimes(1);
    expect(engine.receivedRecordings).toEqual([]);
  });
});
