import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, NOTHING_HEARD_MESSAGE } from "../engine/engineErrorMessages";
import { useRegionStoreRegistry } from "../region/regionContext";

/**
 * `starting` is the wait for the browser to hand over the microphone, which
 * the first time includes asking the user for permission.
 */
export type DictationStatus = "idle" | "starting" | "recording" | "transcribing";

export interface DictationOptions {
  /**
   * Called with everything made out of the current recording so far. `isFinal`
   * is true on the last call for a recording. Today there is one call per
   * recording; a caller that replaces what the previous call gave it will keep
   * working when text arrives while the user is still speaking.
   */
  onTranscript: (transcript: string, isFinal: boolean) => void;
  /** Names likely to be spoken, such as the titles on the screen. */
  vocabularyHints?: readonly string[];
  /** A recording is ended for the user after this long. Default 60. */
  maxSeconds?: number;
  /** False puts off asking the engine whether it offers dictation. Default true. */
  enabled?: boolean;
}

/** The name of the custom property that carries how loud the user is, from 0 to 1. */
export const SOUND_LEVEL_PROPERTY = "--clickless-dictation-level";

const RECORDING_FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
// Plenty for speech, and it keeps a minute of it far inside what the engine takes.
const RECORDING_BITS_PER_SECOND = 32_000;
const SOUND_MEASURED_EVERY_MS = 50;
// Loudness is the root mean square of the signal, where 1 is the loudest a
// microphone can report. A quiet room stays under this and speech goes well over it.
const QUIETEST_SPEECH_LOUDNESS = 0.01;
// Speech sits around 0.05 to 0.25, so it is scaled up to fill the range shown.
const LOUDNESS_TO_SHOWN_LEVEL = 4;

const MICROPHONE_BLOCKED_MESSAGE = "Allow microphone access in your browser to speak your request.";
const NO_MICROPHONE_MESSAGE = "We couldn't find a microphone. You can still type what you want.";
const MICROPHONE_FAILED_MESSAGE = "The microphone couldn't be started. Please try again, or type what you want.";

function describeMicrophoneError(microphoneError: unknown): string {
  // Read by name alone: not every browser's DOMException is an Error.
  const errorName =
    typeof microphoneError === "object" && microphoneError !== null && "name" in microphoneError
      ? String(microphoneError.name)
      : "";
  if (errorName === "NotAllowedError" || errorName === "SecurityError") return MICROPHONE_BLOCKED_MESSAGE;
  if (errorName === "NotFoundError" || errorName === "OverconstrainedError") return NO_MICROPHONE_MESSAGE;
  return MICROPHONE_FAILED_MESSAGE;
}

interface SoundMeter {
  stop: () => void;
}

/**
 * Reports how loud the microphone is, several times a second. Returns null in
 * a browser that cannot measure it. A timer is used and not animation frames,
 * which stop while the page is in the background and would miss what was said.
 */
function startSoundMeter(microphoneStream: MediaStream, onLoudness: (loudness: number) => void): SoundMeter | null {
  const AudioContextClass: typeof AudioContext | undefined =
    window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  let audioContext: AudioContext | undefined;
  let analyser: AnalyserNode;
  try {
    audioContext = new AudioContextClass();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(microphoneStream).connect(analyser);
    // Some browsers start a context paused when it was not made in a click.
    void audioContext.resume?.().catch(() => {});
  } catch {
    void audioContext?.close().catch(() => {});
    return null;
  }
  const runningContext = audioContext;
  const waveformSamples = new Uint8Array(analyser.fftSize);
  const measureTimer = setInterval(() => {
    // A paused context reports silence whatever is said, so it reports nothing.
    if (runningContext.state !== "running") return;
    analyser.getByteTimeDomainData(waveformSamples);
    let sumOfSquares = 0;
    for (const waveformSample of waveformSamples) sumOfSquares += ((waveformSample - 128) / 128) ** 2;
    onLoudness(Math.sqrt(sumOfSquares / waveformSamples.length));
  }, SOUND_MEASURED_EVERY_MS);
  return {
    stop: () => {
      clearInterval(measureTimer);
      void runningContext.close().catch(() => {});
    },
  };
}

interface RecordingSession {
  attemptNumber: number;
  microphoneStream: MediaStream;
  recorder: MediaRecorder;
  recordedParts: Blob[];
  soundMeter: SoundMeter | null;
  /** Whether the loudness was ever measured. If not, silence cannot be told from speech. */
  loudnessMeasured: boolean;
  heardSpeech: boolean;
  elapsedTimer: ReturnType<typeof setInterval> | undefined;
  microphoneReleased: boolean;
}

/**
 * Records a spoken prompt and has the engine turn it into text, which it does
 * by passing the recording to OpenAI's speech-to-text service. Use it to build
 * your own microphone button, or render `PromptPanel` with `dictation`.
 *
 * Nothing is recorded until `start` is called, and the microphone is let go as
 * soon as the recording ends. Must be rendered inside `AdaptiveProvider`.
 */
export function useDictation(dictationOptions: DictationOptions) {
  const { onTranscript, vocabularyHints, maxSeconds = 60, enabled = true } = dictationOptions;
  const storeRegistry = useRegionStoreRegistry();
  const [dictationAvailable, setDictationAvailable] = useState(false);
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [dictationError, setDictationError] = useState<string | null>(null);

  // What the recording functions read when they run, which is long after the
  // render that made them.
  const latestOptions = useRef({ onTranscript, vocabularyHints, maxSeconds });
  // After every render, on purpose: `onTranscript` need not keep its identity.
  useEffect(() => {
    latestOptions.current = { onTranscript, vocabularyHints, maxSeconds };
  });

  // The same as `status`, readable at once by a second click that arrives
  // before the first has rendered.
  const currentStatus = useRef<DictationStatus>("idle");
  const changeStatus = useCallback((nextStatus: DictationStatus) => {
    currentStatus.current = nextStatus;
    setStatus(nextStatus);
  }, []);
  // Counts recordings begun and cancelled, so one that was cancelled, or
  // replaced, drops its answer when it arrives.
  const latestAttempt = useRef(0);
  const activeSession = useRef<RecordingSession | null>(null);
  const soundLevelElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const browserCanRecord =
      typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
    if (!browserCanRecord) return;
    let ignoreAnswer = false;
    void storeRegistry.isDictationOffered().then((dictationOffered) => {
      if (!ignoreAnswer) setDictationAvailable(dictationOffered);
    });
    return () => {
      ignoreAnswer = true;
    };
  }, [enabled, storeRegistry]);

  const releaseMicrophone = useCallback((session: RecordingSession) => {
    if (session.microphoneReleased) return;
    session.microphoneReleased = true;
    clearInterval(session.elapsedTimer);
    session.soundMeter?.stop();
    session.soundMeter = null;
    for (const track of session.microphoneStream.getTracks()) track.stop();
    soundLevelElement.current?.style.removeProperty(SOUND_LEVEL_PROPERTY);
  }, []);

  const transcribeSession = useCallback(
    async (session: RecordingSession) => {
      if (session.attemptNumber !== latestAttempt.current) return;
      activeSession.current = null;
      // A recorder also stops by itself, when the microphone is unplugged or
      // taken away. Nothing has let go of it then, or said the recording is over.
      releaseMicrophone(session);
      if (currentStatus.current === "recording") changeStatus("transcribing");
      const recordingBlob = new Blob(session.recordedParts, {
        type: session.recorder.mimeType || session.recordedParts[0]?.type || "",
      });
      // A recording known to be silent is not sent: it would cost a paid call to learn the same.
      const knownToBeSilent = session.loudnessMeasured && !session.heardSpeech;
      if (recordingBlob.size === 0 || knownToBeSilent || !storeRegistry.engine) {
        setDictationError(NOTHING_HEARD_MESSAGE);
        changeStatus("idle");
        return;
      }
      try {
        const { text: spokenText, message } = await storeRegistry.engine.transcribeRecording(
          recordingBlob,
          latestOptions.current.vocabularyHints,
        );
        if (session.attemptNumber !== latestAttempt.current) return;
        const transcript = spokenText.trim();
        const engineMessage = message?.trim();
        // The engine kept back what was said, and says why in its own words.
        if (engineMessage) setDictationError(engineMessage);
        else if (transcript) latestOptions.current.onTranscript(transcript, true);
        else setDictationError(NOTHING_HEARD_MESSAGE);
      } catch (transcriptionError) {
        if (session.attemptNumber !== latestAttempt.current) return;
        setDictationError(describeError(transcriptionError));
      }
      changeStatus("idle");
    },
    [storeRegistry, changeStatus, releaseMicrophone],
  );

  /** Ends the recording and turns it into text. */
  const stopRecording = useCallback(() => {
    const session = activeSession.current;
    if (!session || currentStatus.current !== "recording") return;
    changeStatus("transcribing");
    // The recorder hands over its last part, then `onstop` sends the recording.
    if (session.recorder.state !== "inactive") session.recorder.stop();
    releaseMicrophone(session);
  }, [changeStatus, releaseMicrophone]);

  /** Ends the recording, or the wait for its text, and throws it away. */
  const cancelRecording = useCallback(() => {
    latestAttempt.current++;
    const session = activeSession.current;
    activeSession.current = null;
    if (session) {
      session.recorder.onstop = null;
      if (session.recorder.state !== "inactive") session.recorder.stop();
      releaseMicrophone(session);
    }
    if (currentStatus.current !== "idle") changeStatus("idle");
  }, [changeStatus, releaseMicrophone]);

  /** Asks for the microphone and starts recording. Does nothing unless idle. */
  const startRecording = useCallback(async () => {
    if (currentStatus.current !== "idle") return;
    const attemptNumber = ++latestAttempt.current;
    setDictationError(null);
    setElapsedSeconds(0);
    changeStatus("starting");

    let microphoneStream: MediaStream;
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (microphoneError) {
      if (attemptNumber !== latestAttempt.current) return;
      setDictationError(describeMicrophoneError(microphoneError));
      changeStatus("idle");
      return;
    }
    // Cancelled while the browser was asking: let the microphone go at once.
    if (attemptNumber !== latestAttempt.current) {
      for (const track of microphoneStream.getTracks()) track.stop();
      return;
    }

    let recorder: MediaRecorder;
    try {
      const recordingFormat = RECORDING_FORMATS.find((candidateFormat) =>
        MediaRecorder.isTypeSupported?.(candidateFormat),
      );
      recorder = new MediaRecorder(microphoneStream, {
        ...(recordingFormat && { mimeType: recordingFormat }),
        audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
      });
    } catch {
      for (const track of microphoneStream.getTracks()) track.stop();
      setDictationError(MICROPHONE_FAILED_MESSAGE);
      changeStatus("idle");
      return;
    }

    const session: RecordingSession = {
      attemptNumber,
      microphoneStream,
      recorder,
      recordedParts: [],
      soundMeter: null,
      loudnessMeasured: false,
      heardSpeech: false,
      elapsedTimer: undefined,
      microphoneReleased: false,
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) session.recordedParts.push(event.data);
    };
    recorder.onstop = () => void transcribeSession(session);
    recorder.onerror = () => {
      if (session.attemptNumber !== latestAttempt.current) return;
      cancelRecording();
      setDictationError(MICROPHONE_FAILED_MESSAGE);
    };
    session.soundMeter = startSoundMeter(microphoneStream, (loudness) => {
      session.loudnessMeasured = true;
      if (loudness >= QUIETEST_SPEECH_LOUDNESS) session.heardSpeech = true;
      // Written straight to the element: several times a second is too often to render.
      soundLevelElement.current?.style.setProperty(
        SOUND_LEVEL_PROPERTY,
        Math.min(1, loudness * LOUDNESS_TO_SHOWN_LEVEL).toFixed(2),
      );
    });
    const startedAt = Date.now();
    session.elapsedTimer = setInterval(() => {
      const secondsSoFar = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(secondsSoFar);
      if (secondsSoFar >= latestOptions.current.maxSeconds) stopRecording();
    }, 250);
    activeSession.current = session;
    try {
      recorder.start();
    } catch {
      cancelRecording();
      setDictationError(MICROPHONE_FAILED_MESSAGE);
      return;
    }
    changeStatus("recording");
  }, [changeStatus, transcribeSession, cancelRecording, stopRecording]);

  // Leaving the page must not leave the microphone on.
  useEffect(() => cancelRecording, [cancelRecording]);

  return {
    /** True when the engine offers dictation and this browser can record. False until both are known. */
    available: dictationAvailable,
    status,
    /** Whole seconds recorded so far. */
    elapsedSeconds,
    /** A sentence for the user about why the last recording gave no text, or null. */
    error: dictationError,
    /** Puts the error away, as when the user starts typing instead. */
    clearError: useCallback(() => setDictationError(null), []),
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
    /**
     * Give this to the element that shows the sound level, or one around it. While recording, its
     * `--clickless-dictation-level` custom property is set to a number from 0
     * (silence) to 1 (loud) several times a second.
     */
    soundLevelRef: useCallback((element: HTMLElement | null) => {
      soundLevelElement.current = element;
    }, []),
  };
}
