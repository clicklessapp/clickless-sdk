import type { HistoryEntry } from "../engine/engineResponses";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useChangeHistory } from "../hooks/useChangeHistory";
import { useDictation } from "../hooks/useDictation";
import { useActionRunHistory } from "../hooks/useActionRunHistory";
import { saysSomethingNew, usePromptBar, type PromptTurn } from "../hooks/usePromptBar";
import { useRegionGroup } from "../hooks/useRegionGroup";
import {
  attachmentChipStyle,
  borderStyle,
  buttonStyle,
  dangerColor,
  historyEntryDetailsStyle,
  linkButtonStyle,
  mutedColor,
  primaryButtonStyle,
  recordingColor,
  replyBubbleStyle,
  surfaceColor,
  userBubbleStyle,
} from "./promptPanelStyles";
import { builtInColorVariables, usePanelColorScheme, type ColorSchemeSetting } from "./hostColorScheme";
import { userFacingTitleOf } from "../region/userFacingTitle";
import { useRegionStoreRegistry } from "../region/regionContext";
import { ClicklessUiErrorBoundary } from "./ClicklessUiErrorBoundary";
import { WORKING_WORDING, WorkingDots } from "./WorkingDots";
import { regionIdsKeyOf } from "../hooks/useRegionGroup";
import { useFocusAfterPromptAction } from "./focusAfterPromptAction";
import { OriginalToolbar } from "./OriginalToolbar";

/** The wording of the microphone button and of what replaces it while the user speaks. */
export interface DictationLabels {
  /** The microphone button's name, read out by screen readers and shown on hover. */
  speak: string;
  /** Shown while the browser hands over the microphone. */
  starting: string;
  /** Shown while the user is speaking. */
  listening: string;
  /** Shown while what they said is turned into text. */
  transcribing: string;
  /** The button that ends the recording and keeps it. */
  done: string;
  /** The button that throws the recording away. */
  cancel: string;
}

const DEFAULT_DICTATION_LABELS: DictationLabels = {
  speak: "Speak your request",
  starting: "Getting the microphone ready…",
  listening: "Listening…",
  transcribing: "Turning your words into text…",
  done: "Done",
  cancel: "Cancel",
};

/** What a microphone button of your own is given by `renderDictationButton`. */
export interface DictationButtonProps {
  /** Asks for the microphone and starts recording. */
  start: () => void;
  /** True while the panel is working on something else, when speaking cannot begin. */
  disabled: boolean;
  /** The button's name, from `dictationLabels.speak`. */
  label: string;
}

type VerticalEdge = "bottom" | "top";
type HorizontalEdge = "right" | "left";
/** The corner of the screen the panel's button sits in. */
export type PromptPanelPosition = `${VerticalEdge}-${HorizontalEdge}`;

export interface PromptPanelProps {
  /**
   * The region the panel changes. Give several ids when the screen is made of
   * more than one region, such as a page and a sidebar every page shares:
   * `regionId={["dashboard", "sidebar"]}`. One prompt is then planned across
   * all of them, and its preview is kept, discarded and undone in all of them
   * together, while each region's layout is still saved on its own. A region
   * that is not on the screen is left out until it is.
   * A list may name up to 8 regions.
   */
  regionId: string | readonly string[];
  /**
   * The corner of the screen the button sits in. The panel opens from the same
   * corner: above the button at the bottom of the screen, below it at the top.
   * Default "bottom-right". Any other value is treated as "bottom-right". To
   * move the button in from the edges, for example
   * clear of a tab bar, set `--clickless-launcher-offset-x` and
   * `--clickless-launcher-offset-y` to a length with its unit: `0px`, not `0`.
   */
  position?: PromptPanelPosition;
  /**
   * Text on the button that opens the panel. While a preview is waiting and
   * the panel is minimised, the button reads "Keep or discard?" instead, and
   * "Seeing original" while the screen shows how it first looked. While
   * personalising is not available the button is dimmed, and still opens the
   * panel, which says why and can still undo.
   */
  label?: string;
  /** The panel's heading, and its name for screen readers. */
  title?: string;
  placeholder?: string;
  /** How many past changes to show at first, and to load each time. */
  pageSize?: number;
  defaultOpen?: boolean;
  /**
   * Close the panel when the user clicks elsewhere on the page. Default true.
   * A click elsewhere, like the Escape key, is easy to do by accident, so
   * neither closes it while a preview is waiting, because Keep and Discard are
   * in it. Nor does a click elsewhere while the user is in the middle of a
   * request: while one is being worked on, while there is one in the box, or
   * while the answer to the latest one is showing, as when it says to open a
   * tab on the page and ask again. The Minimise button and the button that
   * opened it always do.
   */
  closeOnOutsideClick?: boolean;
  /**
   * Offer a microphone button for speaking a request. It appears only when the
   * engine is set up to turn speech into text and the browser can record.
   * What the user says goes to the engine's speech-to-text provider, so it is
   * off unless you turn it on.
   */
  dictation?: boolean;
  /** Replaces any of the microphone's wording. What is left out keeps its default. */
  dictationLabels?: Partial<DictationLabels>;
  /**
   * Draws the microphone button in place of the built-in one, in the same spot
   * and only when the built-in one would show, so it needs `dictation` too.
   * Give your button `props.label` as its accessible name.
   */
  renderDictationButton?: (props: DictationButtonProps) => ReactNode;
  /**
   * The colours it is drawn in: "light", "dark", or "auto" to follow the page.
   * Default: AdaptiveProvider's `colorScheme`, which is "auto" unless set.
   */
  colorScheme?: ColorSchemeSetting;
}

// Themed with CSS custom properties so it needs no stylesheet. Set any of these
// on the page or on a parent element:
//   --clickless-accent, --clickless-accent-text, --clickless-border, --clickless-surface,
//   --clickless-text, --clickless-muted, --clickless-danger
//   --clickless-user-bubble, --clickless-user-text          the user's prompts
//   --clickless-reply-bubble, --clickless-reply-text,
//   --clickless-reply-border                                 the replies
//   --clickless-bubble-radius
//   --clickless-recording                                    the sound-level bars
//   --clickless-unavailable-opacity  the button while personalising is not available (0.55)
//   --clickless-panel-z-index       how far in front of the page the button and panel sit (1000)
//   --clickless-launcher-offset-x, --clickless-launcher-offset-y
//                                   how far the button sits from the screen's edges (16px).
//                                   A length with its unit: the panel's size is worked out
//                                   from it, which a bare 0 would break.
// Bubbles also carry data-clickless-bubble="user", "reply" or "working" (the sign shown
// while a request waits for its answer) for a stylesheet to target.
// Each runs in the direction of its own words, so an English reply on a
// right-to-left page reads left to right, with its full stop at the end.
// While the screen shows how it first looked, the bar saying so carries
// data-clickless-original="showing", and each section drawn differently from
// the user's version carries data-clickless-preview="changed", as in a preview.
// While personalising is not available the button carries data-clickless-unavailable.
// The microphone button carries data-clickless-dictation="start". What replaces
// it while the user speaks carries "starting", "recording" or "transcribing".
// While it is "recording" the SDK sets --clickless-dictation-level on it: a number
// from 0 (silence) to 1 (loud), for a host that wants to draw the level its own way.
const MAX_INPUT_HEIGHT = 200;
const LAUNCHER_OFFSET_X = "var(--clickless-launcher-offset-x, 16px)";
const LAUNCHER_OFFSET_Y = "var(--clickless-launcher-offset-y, 16px)";
const PANEL_Z_INDEX = "var(--clickless-panel-z-index, 1000)";
// The panel opens clear of the button: the button's height and a gap.
const PANEL_CLEARANCE_FROM_LAUNCHER = "52px";
// Kept free between the panel and the far edge of the screen.
const PANEL_MARGIN_FROM_FAR_EDGE = "16px";
// The two screen edges each corner is measured from.
const CORNER_EDGES: Record<PromptPanelPosition, { verticalEdge: VerticalEdge; horizontalEdge: HorizontalEdge }> = {
  "bottom-right": { verticalEdge: "bottom", horizontalEdge: "right" },
  "bottom-left": { verticalEdge: "bottom", horizontalEdge: "left" },
  "top-right": { verticalEdge: "top", horizontalEdge: "right" },
  "top-left": { verticalEdge: "top", horizontalEdge: "left" },
};
const DEFAULT_POSITION: PromptPanelPosition = "bottom-right";
// The longest prompt the engine takes.
const MAX_PROMPT_LENGTH = 2000;

// How each past action run is labelled beside its time.
const ACTION_RUN_OUTCOME_WORDING = { done: "Done", failed: "Didn't work", cancelled: "Cancelled" } as const;
// How much taller than its resting height each bar grows at full loudness, in pixels.
const SOUND_BAR_GROWTH = [6, 12, 16, 10, 5];

const UNAVAILABLE_LAUNCHER_DESCRIPTION = "Personalising isn't available right now";

const formatElapsedTime = (elapsedSeconds: number) =>
  `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

function PaperclipIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8" />
    </svg>
  );
}

function MicrophoneIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  );
}

const historyEntryTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * A button that stays in the corner of the screen and opens a panel for
 * describing changes, with the user's past changes above the prompt. The page
 * stays usable beside it, so a preview can be seen while deciding.
 */
export function PromptPanel(props: PromptPanelProps) {
  // Outside the boundary, so a panel placed outside AdaptiveProvider still says so.
  useRegionStoreRegistry();
  return (
    <ClicklessUiErrorBoundary resetKey={regionIdsKeyOf(props.regionId)}>
      <PromptPanelContents {...props} />
    </ClicklessUiErrorBoundary>
  );
}

/**
 * The second line of a sentence about something done, such as the request a
 * restore went back to. Dimmed from the bubble's own text colour rather than
 * given one, so it reads on whatever colour the host gives replies.
 */
function MessageDetail({ detail }: { detail: string | undefined }) {
  if (!detail) return null;
  return (
    <span dir="auto" style={{ display: "block", marginTop: 2, fontSize: "0.85em", opacity: 0.75 }}>
      {detail}
    </span>
  );
}

function PromptPanelContents({
  regionId,
  position = DEFAULT_POSITION,
  label = "Ask ClickLess",
  title = "Ask ClickLess",
  placeholder = "Describe how you want this screen to look",
  pageSize = 5,
  defaultOpen = false,
  closeOnOutsideClick = true,
  dictation: offerDictation = false,
  dictationLabels,
  renderDictationButton,
  colorScheme: colorSchemeSetting,
}: PromptPanelProps) {
  const dictationWording = { ...DEFAULT_DICTATION_LABELS, ...dictationLabels };
  const [isOpen, setIsOpen] = useState(defaultOpen);
  // A host written in plain JavaScript can pass a corner that does not exist.
  // The panel then takes the default one, where it can still be found.
  const { verticalEdge, horizontalEdge } = Object.hasOwn(CORNER_EDGES, position)
    ? CORNER_EDGES[position]
    : CORNER_EDGES[DEFAULT_POSITION];
  const promptBar = usePromptBar(regionId);
  const { groupSnapshot, regionIdsKey } = useRegionGroup(regionId);
  const { revision } = groupSnapshot;
  const changeHistory = useChangeHistory(regionId, { pageSize });
  const regionIdList = typeof regionId === "string" ? [regionId] : regionId;
  // Names the panel in the page. Made by React, as a region's id may hold
  // characters an element's id cannot, and two panels for one region need two.
  const panelElementId = `clickless-panel-${useId()}`;

  // The entry the screen currently matches. After a restore the latest saved
  // change is the restore itself, which is not listed, so remember its target.
  // It is remembered only once the restore has happened, and for these regions alone.
  const [lastRestore, setLastRestore] = useState<{
    regionIdsKey: string;
    targetRevision: number;
    madeRevision: number;
  } | null>(null);
  const shownRevision =
    lastRestore?.regionIdsKey === regionIdsKey && lastRestore.madeRevision === revision
      ? lastRestore.targetRevision
      : revision;

  async function restoreToRevision(targetRevision: number, restoredRequest?: string) {
    const madeRevision = await promptBar.restoreRevision(targetRevision, restoredRequest);
    if (madeRevision !== null) setLastRestore({ regionIdsKey, targetRevision, madeRevision });
  }
  const isBusy = promptBar.status !== "idle";
  // A request is being worked on, there is one in the box to send or send again, or the
  // answer to the latest one is showing, as when it says to open a tab and ask again.
  const inMiddleOfRequest =
    isBusy || promptBar.prompt.trim() !== "" || (promptBar.message === null && promptBar.latestReply !== null);

  // Minimised, the panel still offers the way back from the original. Once it
  // is taken off the page there is none, so the original goes with it.
  const { showOriginal } = promptBar;
  useEffect(() => () => showOriginal(false), [showOriginal]);

  const promptInput = useRef<HTMLTextAreaElement>(null);

  // What is said is added after what was already typed. The box cannot be typed
  // in while the user speaks, so what was there when they began is still there.
  const promptBeforeSpeaking = useRef("");
  // Whether the prompt now in the box came from speaking rather than typing, so
  // the change it leads to can be recorded as spoken. Any typing clears it.
  const promptCameFromVoice = useRef(false);
  const { setPrompt } = promptBar;
  // The names on this screen are what the user is likeliest to say.
  const sectionTitles = useMemo(
    () =>
      groupSnapshot.regions.flatMap(
        ({ snapshot }) => snapshot.manifest?.components.flatMap((component) => userFacingTitleOf(component) ?? []) ?? [],
      ),
    [groupSnapshot.regions],
  );
  const dictation = useDictation({
    enabled: offerDictation && isOpen,
    vocabularyHints: sectionTitles,
    onTranscript: (transcript) => {
      const promptTypedBefore = promptBeforeSpeaking.current.trimEnd();
      setPrompt(`${promptTypedBefore}${promptTypedBefore ? " " : ""}${transcript}`.slice(0, MAX_PROMPT_LENGTH));
      promptCameFromVoice.current = true;
    },
  });
  const isDictating = dictation.status !== "idle";
  const { cancel: cancelDictation, status: dictationStatus } = dictation;
  // A recording belongs to the screen and the open panel it was begun in.
  useEffect(() => cancelDictation, [regionIdsKey, isOpen, offerDictation, cancelDictation]);

  // The microphone button leaves the page while the user speaks, and the
  // buttons that replace it leave when they finish. The focus follows.
  const doneSpeakingButton = useRef<HTMLButtonElement>(null);
  const previousDictationStatus = useRef(dictationStatus);
  useEffect(() => {
    const previousStatus = previousDictationStatus.current;
    previousDictationStatus.current = dictationStatus;
    if (dictationStatus === "recording") doneSpeakingButton.current?.focus();
    else if (dictationStatus === "idle" && previousStatus !== "idle") {
      // Only when the focus was left with nowhere to be. A user who went on to
      // something else on the page while waiting keeps their place there.
      const focusedElement = document.activeElement;
      const focusWasLeftBehind =
        !focusedElement || focusedElement === document.body || panelElement.current?.contains(focusedElement);
      if (focusWasLeftBehind) promptInput.current?.focus();
    }
  }, [dictationStatus]);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    setPrefersReducedMotion(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  }, []);

  function startSpeaking() {
    promptBeforeSpeaking.current = promptBar.prompt;
    void dictation.start();
  }

  const conversationLog = useRef<HTMLDivElement>(null);
  const panelElement = useRef<HTMLElement>(null);
  const launcherButton = useRef<HTMLButtonElement>(null);

  const { previewing } = promptBar;
  useEffect(() => {
    if (!isOpen || !closeOnOutsideClick || previewing || inMiddleOfRequest) return;
    const onPointerDown = (event: PointerEvent) => {
      const clickedNode = event.target as Node;
      if (!panelElement.current?.contains(clickedNode) && !launcherButton.current?.contains(clickedNode)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen, closeOnOutsideClick, previewing, inMiddleOfRequest]);

  useEffect(() => {
    if (isOpen) promptInput.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape and a click elsewhere are easy to do by accident, so neither puts
      // the panel away while a preview is waiting. The Minimise button does.
      if (event.key !== "Escape" || previewing) return;
      // Escape that the page already used, or that ends a word being composed, is not for the panel.
      if (event.defaultPrevented || event.isComposing) return;
      // The panel is about to go. If the keyboard focus is in it, it must not go too.
      if (panelElement.current?.contains(document.activeElement)) launcherButton.current?.focus();
      setIsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, previewing]);

  // Keep, Discard, Undo, OK and the restore links can leave the page once
  // used, and the focus that was on them is kept instead of being lost.
  const thenKeepFocus = useFocusAfterPromptAction(promptInput, !isBusy && !changeHistory.loading);

  const fileInput = useRef<HTMLInputElement>(null);

  // Actions this user ran on this screen before, read back from the engine, so
  // they are still listed after the page is loaded again. Those recorded since
  // the panel opened are in the conversation already.
  const pastActionRuns = useActionRunHistory(promptBar.screenId, {
    enabled: isOpen,
    refreshKey: promptBar.recordedActionRunIds.length,
  });
  const earliestLoadedChange = changeHistory.entries[0];
  const historyTimeline = useMemo(() => {
    const listedActionRuns = pastActionRuns.filter(
      (actionRun) =>
        !promptBar.recordedActionRunIds.includes(actionRun.id) &&
        promptBar.describeActionRun(actionRun) !== null &&
        // Older than the earliest change loaded, it belongs among changes not loaded yet.
        (!changeHistory.hasEarlier ||
          !earliestLoadedChange ||
          Date.parse(actionRun.createdAt) >= Date.parse(earliestLoadedChange.createdAt)),
    );
    return [
      ...changeHistory.entries.map((historyEntry) => ({ kind: "change" as const, historyEntry, at: historyEntry.createdAt })),
      ...listedActionRuns.map((actionRun) => ({ kind: "action" as const, actionRun, at: actionRun.createdAt })),
    ].sort((firstItem, secondItem) => Date.parse(firstItem.at) - Date.parse(secondItem.at));
  }, [
    changeHistory.entries,
    changeHistory.hasEarlier,
    earliestLoadedChange,
    pastActionRuns,
    promptBar.recordedActionRunIds,
    promptBar.describeActionRun,
  ]);

  // Keep the newest entry and the latest reply in view, as a conversation does.
  const newestRevision = changeHistory.entries.at(-1)?.revision;
  useEffect(() => {
    if (isOpen && conversationLog.current) conversationLog.current.scrollTop = conversationLog.current.scrollHeight;
  }, [
    isOpen,
    newestRevision,
    promptBar.message,
    promptBar.previewing,
    promptBar.promptTurns,
    promptBar.pendingActionCalls,
    // A request just sent, with its sign of work, shows at once and is kept in view too.
    promptBar.requestInProgress,
    // The actions run before are read only once the panel opens, and arrive after it has scrolled.
    pastActionRuns,
  ]);

  // What was said since the panel was opened goes after the changes saved up
  // to then, and before those saved later, so it reads in the order it happened.
  const { promptTurns } = promptBar;
  const conversation = useMemo(() => {
    const conversationItems: (
      | (typeof historyTimeline)[number]
      | { kind: "turn"; promptTurn: PromptTurn; turnPosition: number }
    )[] = [];
    let nextTurnPosition = 0;
    const addTurnsSaidBefore = (revision: number) => {
      while (nextTurnPosition < promptTurns.length && promptTurns[nextTurnPosition]!.afterRevision < revision) {
        conversationItems.push({ kind: "turn", promptTurn: promptTurns[nextTurnPosition]!, turnPosition: nextTurnPosition });
        nextTurnPosition++;
      }
    };
    for (const timelineItem of historyTimeline) {
      if (timelineItem.kind === "change") addTurnsSaidBefore(timelineItem.historyEntry.revision);
      conversationItems.push(timelineItem);
    }
    addTurnsSaidBefore(Infinity);
    return conversationItems;
  }, [historyTimeline, promptTurns]);

  // The box grows with what is typed, so the whole request stays visible, up to
  // a height that leaves room for the conversation above it.
  const { prompt } = promptBar;
  useEffect(() => {
    const promptInputElement = promptInput.current;
    if (!promptInputElement) return;
    promptInputElement.style.height = "auto";
    if (promptInputElement.scrollHeight > 0) {
      promptInputElement.style.height = `${Math.min(promptInputElement.scrollHeight + 2, MAX_INPUT_HEIGHT)}px`;
      promptInputElement.style.overflowY = promptInputElement.scrollHeight + 2 > MAX_INPUT_HEIGHT ? "auto" : "hidden";
    }
  }, [prompt, isOpen]);

  function reusePrompt(pastPrompt: string) {
    promptBar.setPrompt(pastPrompt);
    promptCameFromVoice.current = false;
    promptInput.current?.focus();
  }

  const colorScheme = usePanelColorScheme(colorSchemeSetting);
  const unavailableDescriptionId = `${panelElementId}-unavailable`;

  // Requests since the panel was opened that are not saved changes (questions,
  // actions, previews not kept), and sentences about what was done between them.
  // A sentence moved into the conversation was heard already, so it is never announced again.
  const latestNewTurnPosition = promptTurns.map(saysSomethingNew).lastIndexOf(true);
  const renderPromptTurn = (promptTurn: PromptTurn, turnPosition: number) => {
    const isLatestTurn = turnPosition === latestNewTurnPosition;
    return (
      <article key={`turn-${turnPosition}`} style={{ display: "grid", gap: 6 }}>
        {/* A kept change's request and reply are shown by its entry in the history. A sentence about something done has no request. */}
        {!promptTurn.savedAsChange && promptTurn.request && (
          <>
            <p dir="auto" data-clickless-bubble="user" style={userBubbleStyle}>
              {promptTurn.request}
            </p>
            {/* A request only for changes to confirm gets no reply: the confirmation says what will happen. */}
            {promptTurn.reply.trim() && (
              <p dir="auto" data-clickless-bubble="reply" role={isLatestTurn ? "status" : undefined} style={replyBubbleStyle}>
                {promptTurn.reply}
              </p>
            )}
          </>
        )}
        {promptTurn.outcomes.map((outcome, outcomePosition) => (
          <p
            key={outcomePosition}
            dir="auto"
            data-clickless-bubble="reply"
            role={isLatestTurn ? (outcome.isError ? "alert" : "status") : undefined}
            style={{
              ...replyBubbleStyle,
              ...(outcome.isError && { color: dangerColor, borderColor: dangerColor }),
            }}
          >
            {outcome.text}
            <MessageDetail detail={outcome.detail} />
          </p>
        ))}
      </article>
    );
  };

  const renderHistoryEntry = (historyEntry: HistoryEntry) => (
        <article key={historyEntry.revision} style={{ display: "grid", gap: 6 }}>
          <p dir="auto" data-clickless-bubble="user" style={userBubbleStyle}>
            {historyEntry.prompt}
          </p>
          <div style={{ ...historyEntryDetailsStyle, justifyContent: "flex-end" }}>
            <time dateTime={historyEntry.createdAt}>
              {historyEntryTimeFormat.format(new Date(historyEntry.createdAt))}
            </time>
            <button type="button" onClick={() => reusePrompt(historyEntry.prompt ?? "")} style={linkButtonStyle}>
              Reuse
            </button>
            {historyEntry.revision === shownRevision ? (
              <span>Current</span>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                onClick={thenKeepFocus(() => void restoreToRevision(historyEntry.revision, historyEntry.prompt ?? undefined))}
                style={linkButtonStyle}
              >
                Restore to this point
              </button>
            )}
          </div>
          {historyEntry.message && (
            <p dir="auto" data-clickless-bubble="reply" style={replyBubbleStyle}>
              {historyEntry.message}
            </p>
          )}
        </article>
  );

  return (
    <>
      <button
        ref={launcherButton}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelElementId}
        aria-describedby={promptBar.available ? undefined : unavailableDescriptionId}
        title={promptBar.available ? undefined : UNAVAILABLE_LAUNCHER_DESCRIPTION}
        data-clickless-unavailable={promptBar.available ? undefined : ""}
        onClick={() => setIsOpen(!isOpen)}
        style={{
          ...builtInColorVariables(colorScheme),
          ...primaryButtonStyle,
          position: "fixed",
          [horizontalEdge]: LAUNCHER_OFFSET_X,
          [verticalEdge]: LAUNCHER_OFFSET_Y,
          zIndex: PANEL_Z_INDEX,
          borderRadius: 999,
          padding: "10px 16px",
          boxShadow: "0 4px 14px rgba(0, 0, 0, 0.2)",
          // Dimmed, not disabled: the panel says why, and can still undo.
          ...(!promptBar.available && { opacity: "var(--clickless-unavailable-opacity, 0.55)", boxShadow: "none" }),
        }}
      >
        {/* A preview stays on the screen while the panel is tucked away, and
            must not be taken for a saved change. */}
        {isOpen ? "Close" : previewing ? "Keep or discard?" : promptBar.showingOriginal ? "Seeing original" : label}
      </button>

      {/* The reply is in the panel, which is not there to say it when a
          preview arrives while minimised. This says it to a screen reader. */}
      <span
        role="status"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap",
        }}
      >
        {!isOpen && previewing
          ? "A preview is showing. Open the panel to keep or discard it."
          : !isOpen && promptBar.showingOriginal
            ? "The screen is showing how it first looked. Open the panel to go back to your version."
            : ""}
      </span>
      {!promptBar.available && (
        <span id={unavailableDescriptionId} hidden>
          {UNAVAILABLE_LAUNCHER_DESCRIPTION}
        </span>
      )}

      {isOpen && (
        <section
          ref={panelElement}
          id={panelElementId}
          role="dialog"
          aria-label={title}
          data-clickless-prompt-panel={regionIdList.join(" ")}
          style={{
            ...builtInColorVariables(colorScheme),
            position: "fixed",
            [horizontalEdge]: LAUNCHER_OFFSET_X,
            [verticalEdge]: `calc(${LAUNCHER_OFFSET_Y} + ${PANEL_CLEARANCE_FROM_LAUNCHER})`,
            zIndex: PANEL_Z_INDEX,
            width: `min(380px, calc(100vw - ${LAUNCHER_OFFSET_X} - ${PANEL_MARGIN_FROM_FAR_EDGE}))`,
            maxHeight: `min(620px, calc(100vh - ${LAUNCHER_OFFSET_Y} - ${PANEL_CLEARANCE_FROM_LAUNCHER} - ${PANEL_MARGIN_FROM_FAR_EDGE}))`,
            display: "flex",
            flexDirection: "column",
            background: surfaceColor,
            color: "var(--clickless-text, var(--clickless-built-in-text, #0b0b0b))",
            border: borderStyle,
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0, 0, 0, 0.18)",
            overflow: "hidden",
          }}
        >
          <header
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingBlock: 8,
              paddingInlineStart: 14,
              paddingInlineEnd: 8,
              borderBottom: borderStyle,
              fontWeight: 600,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{title}</span>
            {/* Tucks the panel away to show the whole screen. The conversation,
                and any preview, are still there when it is opened again. */}
            <button
              type="button"
              aria-label="Minimise"
              title="Minimise"
              onClick={() => {
                setIsOpen(false);
                launcherButton.current?.focus();
              }}
              // Big enough to press whatever size of writing the page uses.
              style={{ ...buttonStyle, minWidth: 32, minHeight: 32, padding: "4px 10px", fontWeight: 600 }}
            >
              <span aria-hidden="true">–</span>
            </button>
          </header>

          <OriginalToolbar
            showingOriginal={promptBar.showingOriginal}
            differsFromOriginal={promptBar.differsFromOriginal}
            canRevert={groupSnapshot.hasHistory}
            isBusy={isBusy}
            previewing={previewing}
            showOriginal={promptBar.showOriginal}
            revertToOriginal={() => void restoreToRevision(0)}
            thenKeepFocus={thenKeepFocus}
          />

          <div
            ref={conversationLog}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: 14,
              display: "grid",
              gap: 14,
              alignContent: "start",
            }}
          >
            {changeHistory.hasEarlier && (
              <button type="button" disabled={changeHistory.loading} onClick={thenKeepFocus(changeHistory.loadEarlier)} style={linkButtonStyle}>
                {changeHistory.loading ? "Loading…" : "See earlier changes"}
              </button>
            )}

            {historyTimeline.length === 0 &&
              !changeHistory.loading &&
              promptBar.promptTurns.length === 0 &&
              !promptBar.message &&
              !promptBar.notice && (
              <p style={{ margin: 0, color: mutedColor }}>
                {promptBar.offersActions
                  ? "Ask for a change to this screen, or for something to be done for you. You'll see what will happen before anything changes."
                  : "Describe a change and you will see a preview before anything is saved."}
              </p>
            )}

            {conversation.map((timelineItem) =>
              timelineItem.kind === "turn" ? (
                renderPromptTurn(timelineItem.promptTurn, timelineItem.turnPosition)
              ) : timelineItem.kind === "action" ? (
                <article
                  key={`action-${timelineItem.actionRun.id}`}
                  data-clickless-action-run={timelineItem.actionRun.outcome}
                  style={{ display: "grid", gap: 4 }}
                >
                  <p dir="auto" style={{ ...replyBubbleStyle, justifySelf: "stretch", maxWidth: "none" }}>
                    {promptBar.describeActionRun(timelineItem.actionRun)}
                  </p>
                  <div style={historyEntryDetailsStyle}>
                    <span>{ACTION_RUN_OUTCOME_WORDING[timelineItem.actionRun.outcome]}</span>
                    <time dateTime={timelineItem.actionRun.createdAt}>
                      {historyEntryTimeFormat.format(new Date(timelineItem.actionRun.createdAt))}
                    </time>
                  </div>
                </article>
              ) : (
                renderHistoryEntry(timelineItem.historyEntry)
              ),
            )}

            {/* Shown the moment it is sent, with a sign of work, until its answer takes its place. */}
            {promptBar.requestInProgress !== null && (
              <article style={{ display: "grid", gap: 6 }}>
                <p dir="auto" data-clickless-bubble="user" style={userBubbleStyle}>
                  {promptBar.requestInProgress}
                </p>
                <p data-clickless-bubble="working" role="status" style={replyBubbleStyle}>
                  <WorkingDots /> {WORKING_WORDING}
                </p>
              </article>
            )}

            {changeHistory.error && (
              <p role="alert" dir="auto" style={{ margin: 0, color: dangerColor }}>
                {changeHistory.error}
              </p>
            )}

            {promptBar.notice && (
              <div role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span dir="auto" style={{ flex: 1 }}>{promptBar.notice}</span>
                <button type="button" onClick={thenKeepFocus(promptBar.dismissNotice)} style={buttonStyle}>
                  OK
                </button>
              </div>
            )}

            {promptBar.message && (
              <p
                role={promptBar.message.isError ? "alert" : "status"}
                dir="auto"
                data-clickless-bubble="reply"
                style={{
                  ...replyBubbleStyle,
                  ...(promptBar.message.isError && { color: dangerColor, borderColor: dangerColor }),
                }}
              >
                {promptBar.message.text}
                <MessageDetail detail={promptBar.message.detail} />
              </p>
            )}
          </div>

          <form
            style={{ display: "grid", gap: 8, padding: 14, borderTop: borderStyle }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!isDictating) promptBar.submitPrompt({ viaVoice: promptCameFromVoice.current });
            }}
          >
            {promptBar.previewing && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={thenKeepFocus(promptBar.keepPreview)}
                  style={{ ...primaryButtonStyle, flex: 1 }}
                >
                  {promptBar.status === "saving" ? "Saving…" : "Keep"}
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={thenKeepFocus(promptBar.discardPreview)}
                  style={{ ...buttonStyle, flex: 1 }}
                >
                  Discard
                </button>
              </div>
            )}
            {promptBar.previewing && promptBar.callsAfterPreview && (
              <p dir="auto" data-clickless-after-preview style={{ margin: 0, color: mutedColor }}>
                Then: {promptBar.callsAfterPreview.map((waitingCall) => waitingCall.summary).join(" ")}
              </p>
            )}
            {promptBar.pendingActionCalls && (
              <div data-clickless-confirmation style={{ display: "grid", gap: 8 }}>
                {/* Announced, as it is the only place that says what Confirm will do. */}
                <div role="status" style={{ display: "grid", gap: 8 }}>
                  {promptBar.pendingActionCalls.map((pendingCall, callPosition) => (
                    <p key={callPosition} dir="auto" style={{ margin: 0, fontWeight: 600 }}>
                      {pendingCall.summary}
                    </p>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={thenKeepFocus(promptBar.confirmActionCalls)}
                    style={{ ...primaryButtonStyle, flex: 1 }}
                  >
                    {promptBar.status === "saving" ? "Working…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={thenKeepFocus(promptBar.cancelActionCalls)}
                    style={{ ...buttonStyle, flex: 1 }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {promptBar.attachedFiles.length > 0 && (
              <ul aria-label="Attached files" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {promptBar.attachedFiles.map((attachedFile, filePosition) => (
                  <li key={filePosition} data-clickless-attachment style={{ ...attachmentChipStyle }}>
                    <span style={{ overflowWrap: "anywhere" }}>{attachedFile.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachedFile.name}`}
                      // What waits to be confirmed was worked out with these files.
                      disabled={isBusy || promptBar.pendingActionCalls !== null}
                      onClick={() => promptBar.removeAttachedFile(filePosition)}
                      style={{ ...linkButtonStyle, textDecoration: "none" }}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isDictating && (
              <div
                ref={dictation.soundLevelRef}
                data-clickless-dictation={dictation.status}
                style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 34 }}
              >
                {dictation.status === "recording" &&
                  (prefersReducedMotion ? (
                    <span
                      aria-hidden="true"
                      style={{ width: 10, height: 10, borderRadius: 999, background: recordingColor }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{ display: "flex", alignItems: "center", gap: 2, height: 22 }}
                    >
                      {SOUND_BAR_GROWTH.map((barGrowth, barIndex) => (
                        <span
                          key={barIndex}
                          style={{
                            width: 3,
                            borderRadius: 2,
                            background: recordingColor,
                            height: `calc(4px + var(--clickless-dictation-level, 0) * ${barGrowth}px)`,
                            transition: "height 80ms linear",
                          }}
                        />
                      ))}
                    </span>
                  ))}
                <span role="status" style={{ flex: 1, minWidth: 0 }}>
                  {dictation.status === "recording"
                    ? dictationWording.listening
                    : dictation.status === "transcribing"
                      ? dictationWording.transcribing
                      : dictationWording.starting}
                </span>
                {dictation.status === "recording" && (
                  <>
                    {/* Outside the status above, or a screen reader would read out every second. */}
                    <span aria-hidden="true" style={{ color: mutedColor, fontVariantNumeric: "tabular-nums" }}>
                      {formatElapsedTime(dictation.elapsedSeconds)}
                    </span>
                    <button ref={doneSpeakingButton} type="button" onClick={dictation.stop} style={primaryButtonStyle}>
                      {dictationWording.done}
                    </button>
                  </>
                )}
                <button type="button" onClick={dictation.cancel} style={buttonStyle}>
                  {dictationWording.cancel}
                </button>
              </div>
            )}
            {dictation.error && (
              <p role="alert" dir="auto" style={{ margin: 0, color: dangerColor }}>
                {dictation.error}
              </p>
            )}
            <textarea
              ref={promptInput}
              dir="auto"
              aria-label="Describe a change to this screen"
              placeholder={placeholder}
              value={promptBar.prompt}
              onChange={(event) => {
                dictation.clearError();
                promptBar.setPrompt(event.target.value);
                promptCameFromVoice.current = false;
              }}
              onPaste={(event) => {
                // A picture pasted into the box is attached, for an action that takes one.
                const pastedFiles = [...event.clipboardData.files];
                if (!promptBar.acceptsFiles || pastedFiles.length === 0 || promptBar.pendingActionCalls) return;
                event.preventDefault();
                promptBar.attachFiles(pastedFiles);
              }}
              onKeyDown={(event) => {
                // While a word is being composed (Japanese, Chinese, Korean),
                // Enter chooses it. Key code 229 is how Safari reports that.
                const isComposing = event.nativeEvent.isComposing || event.keyCode === 229;
                if (event.key === "Enter" && !event.shiftKey && !isComposing) {
                  event.preventDefault();
                  if (!isDictating) promptBar.submitPrompt({ viaVoice: promptCameFromVoice.current });
                }
              }}
              maxLength={MAX_PROMPT_LENGTH}
              rows={2}
              // Read-only, not disabled, while busy: a disabled box drops the keyboard focus.
              readOnly={isBusy || isDictating}
              aria-busy={isBusy || isDictating}
              style={{
                ...buttonStyle,
                cursor: "text",
                whiteSpace: "pre-wrap",
                resize: "none",
                lineHeight: 1.4,
                maxHeight: MAX_INPUT_HEIGHT,
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                disabled={isBusy || isDictating || promptBar.prompt.trim() === ""}
                style={{ ...primaryButtonStyle, flex: 1 }}
              >
                {promptBar.status === "planning" ? "Working…" : promptBar.offersActions ? "Send" : "Preview"}
              </button>
              {promptBar.acceptsFiles && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                      promptBar.attachFiles([...(event.target.files ?? [])]);
                      // The same file can be chosen again after it is removed.
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Attach a file"
                    title="Attach a file"
                    disabled={isBusy || promptBar.pendingActionCalls !== null}
                    onClick={() => fileInput.current?.click()}
                    style={{ ...buttonStyle, display: "grid", placeItems: "center", minWidth: 40 }}
                  >
                    <PaperclipIcon />
                  </button>
                </>
              )}
              {offerDictation &&
                dictation.available &&
                !isDictating &&
                (renderDictationButton ? (
                  renderDictationButton({ start: startSpeaking, disabled: isBusy, label: dictationWording.speak })
                ) : (
                  <button
                    type="button"
                    data-clickless-dictation="start"
                    aria-label={dictationWording.speak}
                    title={dictationWording.speak}
                    disabled={isBusy}
                    onClick={startSpeaking}
                    style={{ ...buttonStyle, display: "grid", placeItems: "center", minWidth: 40 }}
                  >
                    <MicrophoneIcon />
                  </button>
                ))}
              {promptBar.canUndo && !promptBar.previewing && (
                <button type="button" disabled={isBusy} onClick={thenKeepFocus(promptBar.undoLastChange)} style={buttonStyle}>
                  Undo
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </>
  );
}
