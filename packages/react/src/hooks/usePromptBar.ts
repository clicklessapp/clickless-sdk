import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LayoutChange, Manifest } from "@clickless/core";
import {
  ACTION_NO_LONGER_AVAILABLE_MESSAGE,
  SCREEN_CHANGED_BEFORE_CONFIRM_MESSAGE,
  describeNotRunForPlanner,
  prepareActionCalls,
  runActionCall,
  type PreparedActionCall,
} from "../actions/actionCalls";
import { getServerActions } from "../actions/actionRegistry";
import { EngineError, type ConversationTurn } from "../engine/engineClient";
import { describeError, PREVIEW_NO_LONGER_FITS_MESSAGE } from "../engine/engineErrorMessages";
import type { UndoneChange } from "../engine/engineResponses";
import { useRegionStoreRegistry } from "../region/regionContext";
import type { RegionGroupSnapshot } from "../region/regionGroup";
import type { UndoResult } from "../region/regionStore";
import { describeHistoryEntry } from "./useChangeHistory";
import { useEngineReachable } from "./useEngineReachable";
import { useRegionGroup } from "./useRegionGroup";
import { userFacingTitleOf } from "../region/userFacingTitle";

export type PromptBarStatus = "idle" | "planning" | "saving";

/** A sentence about something done, shown to the user. */
export interface PromptBarMessage {
  text: string;
  isError: boolean;
  /** A second line under `text`, such as the request a restore went back to. */
  detail?: string;
}

/** One request made since the bar was opened, and what came of it. */
export interface PromptTurn {
  /**
   * Empty for sentences said here without a request, kept where they were
   * said: that a change was saved or the page put back, or what came of an
   * earlier request's actions once such a sentence came after it. They are in
   * `outcomes`.
   */
  request: string;
  /**
   * What the planner answered: what it previewed or is opening, what could not
   * be done, or a question. Empty when the request was only for changes to
   * confirm, which the confirmation itself describes.
   */
  reply: string;
  /**
   * What happened when actions ran, one sentence each. `text` is what the user
   * is shown. `noteForPlanner` is what later requests tell the planner: the
   * action's title and how it ended, or `text` for an action with
   * `shareResultWithPlanner` that ran.
   */
  outcomes: (PromptBarMessage & { noteForPlanner: string })[];
  /** True once its preview was kept, which puts it in the history of saved changes. */
  savedAsChange: boolean;
  /**
   * The point in the history of saved changes the screen was at when it was
   * said, in the numbering of `HistoryEntry.revision`, so it can be shown after
   * the changes saved up to then and before those saved later. For one kept as
   * a change, the point that change made.
   */
  afterRevision: number;
}

// How many earlier requests are sent with a new one, so a follow-up such as an
// answer to a question can be understood. The engine takes no more.
const MAX_CONVERSATION_TURNS_SENT = 6;
const MAX_REPLY_LENGTH_SENT = 2000;
// Files the user may attach to one request, and the longest name or type of one
// sent. The engine takes no more.
const MAX_ATTACHED_FILES = 5;
const MAX_ATTACHED_FILE_DESCRIPTION_LENGTH = 200;
// Added when an undo leaves part of the change where it was changed again since.
const KEPT_ELSEWHERE_NOTE = "Part of that change stays in place elsewhere, because that part was changed again since.";
// Said when Undo is asked for after an action, which it cannot take back.
const NOTHING_TO_UNDO_SINCE_ACTION_MESSAGE =
  "There's no change to undo since your last request. To reverse what it did, ask for that instead.";
// The longest request quoted back to the user when telling them what an undo took back.
const MAX_QUOTED_REQUEST_LENGTH = 80;
// Said of changes waiting to be confirmed, or to follow a preview, when a new request is sent instead.
const CANCELLED_FOR_NEW_REQUEST_MESSAGE = "Cancelled, as you asked for something else.";
// Why waiting calls never ran, as the planner is told it after each one's title.
const CANCELLED_FOR_NEW_REQUEST_REASON = "cancelled, as the user asked for something else";
const SCREEN_CHANGED_BEFORE_CONFIRM_REASON = "not done, as the screen changed before it was confirmed";
const CANCELLED_REASON = "cancelled";
const PREVIEW_DISCARDED_REASON = "not done, as the preview was discarded";
// Said once a preview is kept. Keep saves only how the screen looks, so it
// says so, and says when a change to data from the same request still waits.
const SCREEN_CHANGE_SAVED_MESSAGE = "Your change to this screen is saved.";
const SCREEN_CHANGE_SAVED_REST_WAITS_MESSAGE = "Your change to this screen is saved. The rest still needs you to confirm it.";

/** The text cut to a number of characters, as the engine counts them, never splitting one in two. */
function cutToCharacters(text: string, maxCharacters: number): string {
  const characters = [...text];
  return characters.length <= maxCharacters ? text : characters.slice(0, maxCharacters).join("");
}

/**
 * True when the turn says something the user has not heard yet: a request, or
 * what came of one's actions. A sentence moved in from the bar's message was
 * heard when it was said, and tells the planner nothing.
 */
export function saysSomethingNew(promptTurn: PromptTurn): boolean {
  return Boolean(promptTurn.request) || promptTurn.outcomes.some((outcome) => outcome.noteForPlanner);
}

function conversationToSend(promptTurns: readonly PromptTurn[]): ConversationTurn[] {
  // A turn with no request tells the planner what came of the request before it.
  const requestTurns: { request: string; reply: string; outcomeNotes: string[] }[] = [];
  for (const promptTurn of promptTurns) {
    const outcomeNotes = promptTurn.outcomes.map((outcome) => outcome.noteForPlanner).filter(Boolean);
    if (promptTurn.request) requestTurns.push({ request: promptTurn.request, reply: promptTurn.reply, outcomeNotes });
    else requestTurns.at(-1)?.outcomeNotes.push(...outcomeNotes);
  }
  return requestTurns.slice(-MAX_CONVERSATION_TURNS_SENT).map((promptTurn) => {
    // What `run` said stays in the browser unless its action shares it.
    const outcomeNotes = promptTurn.outcomeNotes.join(" ");
    // A request only for changes to confirm has an empty reply, so its outcome stands alone.
    const reply = outcomeNotes ? `${promptTurn.reply} [Outcome: ${outcomeNotes}]`.trim() : promptTurn.reply;
    return { request: promptTurn.request, reply: cutToCharacters(reply, MAX_REPLY_LENGTH_SENT) };
  });
}

/** What an undo took back, as a phrase: the request in the user's words, or what the change did. */
function describeUndoneChange(undoneChange: UndoneChange | null, screenManifest: Manifest | null): string {
  if (!undoneChange) return "your last change to this screen";
  const request = undoneChange.prompt?.trim();
  if (request) {
    const fitsWhole = [...request].length <= MAX_QUOTED_REQUEST_LENGTH;
    return `“${fitsWhole ? request : `${cutToCharacters(request, MAX_QUOTED_REQUEST_LENGTH).trimEnd()}…`}”`;
  }
  // The history calls a restore "went back", which after "Undone:" would read as what the undo did.
  if (undoneChange.kind === "restore") return "going back to an earlier version of this screen";
  const changeDescription = describeHistoryEntry(undoneChange, screenManifest);
  return changeDescription.charAt(0).toLowerCase() + changeDescription.slice(1);
}

/** What the user is told once an undo is done: what it took back, and where, if not everywhere. */
function describeUndo({ keptElsewhere, undoneChange }: UndoResult, screenManifest: Manifest | null): string {
  const undoneDescription = describeUndoneChange(undoneChange, screenManifest);
  return keptElsewhere ? `Undone here: ${undoneDescription}. ${KEPT_ELSEWHERE_NOTE}` : `Undone: ${undoneDescription}.`;
}

/**
 * The regions on the screen as one manifest, so a change that reached several
 * can be described by the names of what it changed in each.
 */
function manifestOfScreen(regions: RegionGroupSnapshot["regions"]): Manifest | null {
  const manifestsOnScreen = regions.flatMap(({ snapshot }) => snapshot.manifest ?? []);
  if (manifestsOnScreen.length <= 1) return manifestsOnScreen[0] ?? null;
  return { ...manifestsOnScreen[0]!, components: manifestsOnScreen.flatMap((manifest) => manifest.components) };
}

function joinWithAnd(sectionNames: string[]): string {
  return sectionNames.length <= 1
    ? (sectionNames[0] ?? "")
    : `${sectionNames.slice(0, -1).join(", ")} and ${sectionNames.at(-1)}`;
}

/** The sections changed in one way, by name when every one has a title, and counted when any has none. */
function describeSections(sectionTitles: (string | null)[], startsSentence = false): string {
  const namedTitles = sectionTitles.filter((sectionTitle): sectionTitle is string => sectionTitle !== null);
  if (namedTitles.length === sectionTitles.length) return joinWithAnd(namedTitles);
  if (sectionTitles.length > 1) return `${sectionTitles.length} sections`;
  return startsSentence ? "A section" : "a section";
}

/**
 * One sentence telling the user how their saved layout was changed to fit the
 * screen, counting every region the bar speaks for as part of that one screen.
 */
function describeSavedLayoutAdjustments(regions: RegionGroupSnapshot["regions"]) {
  const adjustments = regions.flatMap(({ snapshot }) =>
    snapshot.loading || !snapshot.manifest
      ? []
      : snapshot.savedLayoutAdjustments.map((adjustment) => {
          const component = snapshot.manifest!.components.find((candidate) => candidate.id === adjustment.id);
          return { type: adjustment.type, title: component ? userFacingTitleOf(component) : null };
        }),
  );
  if (adjustments.length === 0) return null;
  const titlesOfAdjusted = (adjustmentType: LayoutChange["type"]) =>
    adjustments.filter((adjustment) => adjustment.type === adjustmentType).map((adjustment) => adjustment.title);

  const addedTitles = titlesOfAdjusted("added");
  const adjustedTitles = titlesOfAdjusted("adjusted");
  const removedCount = adjustments.filter((adjustment) => adjustment.type === "removed").length;
  const sentenceParts = [
    addedTitles.length > 0 && `${describeSections(addedTitles, true)} ${addedTitles.length === 1 ? "was" : "were"} added`,
    removedCount > 0 && `${removedCount} ${removedCount === 1 ? "section was" : "sections were"} removed`,
    adjustedTitles.length > 0 && `some settings on ${describeSections(adjustedTitles)} were reset`,
  ].filter((sentencePart): sentencePart is string => Boolean(sentencePart));
  return `This screen has been updated since you arranged it: ${sentenceParts.join("; ")}.`;
}

/** What the user is told while the engine can be reached: that the saved layout could not be read, or how it was adjusted. */
function describeAvailableNotice(groupSnapshot: RegionGroupSnapshot, adjustmentsNotice: string | null): string | null {
  if (groupSnapshot.loadFailed) return "Your saved changes to this screen couldn't be loaded just now, so it may not show them.";
  return adjustmentsNotice;
}

/** What the user is told while the engine cannot be reached, which depends on what that leaves undone. */
function describeUnavailability(groupSnapshot: RegionGroupSnapshot): string {
  if (groupSnapshot.hasUnsavedChanges) {
    return "Personalising isn't available right now. Your changes still work while you're here, and will be saved when it's back, unless they clash with changes you saved before.";
  }
  if (groupSnapshot.loadFailed) {
    return "Personalising isn't available right now, so this screen may not show your saved changes. Everything on it still works.";
  }
  return "Personalising isn't available right now. Everything else on this page still works.";
}

/**
 * State and actions for a prompt bar. Use it to build your own, or render `PromptBar`.
 *
 * Give several region ids when one screen is made of more than one region,
 * such as a page and a sidebar every page shares. A prompt is then planned for
 * all of them at once, and its preview is kept, discarded and undone in all of
 * them together, while each region's layout is still saved on its own.
 */
export function usePromptBar(regionId: string | readonly string[]) {
  const { regionGroup, groupSnapshot, regionIdsKey } = useRegionGroup(regionId);
  const storeRegistry = useRegionStoreRegistry();
  // What is typed is kept for the regions it was typed for, so it is there
  // again when the bar comes back to them, and is never shown for others.
  const readDraft = useCallback(() => storeRegistry.draftFor(regionIdsKey), [storeRegistry, regionIdsKey]);
  const prompt = useSyncExternalStore(storeRegistry.subscribeToDrafts, readDraft, readDraft);
  const setPrompt = useCallback(
    (nextPrompt: string | ((previousPrompt: string) => string)) => {
      const text = typeof nextPrompt === "function" ? nextPrompt(storeRegistry.draftFor(regionIdsKey)) : nextPrompt;
      storeRegistry.keepDraft(regionIdsKey, text);
    },
    [storeRegistry, regionIdsKey],
  );
  const [status, setStatus] = useState<PromptBarStatus>("idle");
  const [message, setMessageState] = useState<PromptBarMessage | null>(null);
  // The same, readable at once when something else is asked or done before the next render.
  const messageNow = useRef<PromptBarMessage | null>(null);
  const setMessage = useCallback((nextMessage: PromptBarMessage | null) => {
    messageNow.current = nextMessage;
    setMessageState(nextMessage);
  }, []);
  const [promptTurns, setPromptTurnsState] = useState<PromptTurn[]>([]);
  // The same, as it is now, before the next render: a request's place among
  // the turns is read from it as its turn is added.
  const promptTurnsNow = useRef<PromptTurn[]>([]);
  const setPromptTurns = useCallback((updateTurns: (turnsSoFar: PromptTurn[]) => PromptTurn[]) => {
    promptTurnsNow.current = updateTurns(promptTurnsNow.current);
    setPromptTurnsState(promptTurnsNow.current);
  }, []);
  // True while `message` says why a request failed that was put back in the box.
  const messageIsForRequestInBox = useRef(false);
  // Once something else is asked or done, the sentence about the last thing
  // done stays where it was said, above what comes next.
  const moveMessageIntoConversation = useCallback(() => {
    const shownMessage = messageNow.current;
    const requestIsInBox = messageIsForRequestInBox.current;
    messageIsForRequestInBox.current = false;
    if (!shownMessage) return;
    setMessage(null);
    // Why a request failed goes with it, as the request is back in the box to send again.
    if (requestIsInBox) return;
    setPromptTurns((turnsSoFar) => [
      ...turnsSoFar,
      {
        request: "",
        reply: "",
        outcomes: [{ ...shownMessage, noteForPlanner: "" }],
        savedAsChange: false,
        afterRevision: regionGroup.getSnapshot().revision,
      },
    ]);
  }, [setMessage, setPromptTurns, regionGroup]);
  const [requestInProgress, setRequestInProgress] = useState<string | null>(null);
  // Whether the latest request's answer is still the one being looked at: not
  // once its preview is discarded, or another request is made.
  const [latestTurnIsCurrent, setLatestTurnIsCurrent] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  // Changes waiting for the user to confirm them.
  const [pendingActionCalls, setPendingActionCallsState] = useState<PreparedActionCall[] | null>(null);
  // The same, readable at once by a click that comes before the next render,
  // and by the clean-up when the bar is pointed at other regions.
  const pendingActionCallsNow = useRef<PreparedActionCall[] | null>(null);
  // The screen they were asked for on, which they are recorded under even if the bar has moved on.
  const pendingActionCallsScreenId = useRef("");
  const setPendingActionCalls = useCallback(
    (preparedCalls: PreparedActionCall[] | null) => {
      pendingActionCallsNow.current = preparedCalls;
      if (preparedCalls) pendingActionCallsScreenId.current = (JSON.parse(regionIdsKey) as string[])[0]!;
      setPendingActionCallsState(preparedCalls);
    },
    [regionIdsKey],
  );
  // Actions that only change what is shown, waiting for a preview to be kept or
  // discarded: one that opens another page would otherwise take the user away
  // from a preview before they could decide on it.
  const [callsAfterPreview, setCallsAfterPreviewState] = useState<PreparedActionCall[] | null>(null);
  const callsAfterPreviewNow = useRef<PreparedActionCall[] | null>(null);
  const setCallsAfterPreview = useCallback((preparedCalls: PreparedActionCall[] | null) => {
    callsAfterPreviewNow.current = preparedCalls;
    setCallsAfterPreviewState(preparedCalls);
  }, []);
  /** Every call waiting, to be confirmed or to follow a preview, in the order they would run. */
  const allWaitingCalls = useCallback(
    () => [...(pendingActionCallsNow.current ?? []), ...(callsAfterPreviewNow.current ?? [])],
    [],
  );
  // True from Confirm until the confirmed calls have run, so nothing runs twice.
  const confirmedCallsRunning = useRef(false);
  // Reports the pending calls as turned down, for when they are dropped without the user's say.
  const dropPendingActionCalls = useRef<() => void>(() => {});
  // The same, for only the calls waiting for a preview to be decided on.
  const dropCallsAfterPreview = useRef<() => void>(() => {});
  // The place among the turns of the request whose calls are waiting, which
  // is told what came of them: a follow-up may come between.
  const waitingCallsTurnIndex = useRef(0);
  // The requests whose answers make up the preview on screen, oldest first, by
  // their place among the turns: a follow-up adds its change to the preview.
  const previewTurns = useRef<{ turnIndex: number; request: string }[]>([]);
  // Whether the request that proposed them was spoken, which their records say too.
  const latestRequestViaVoice = useRef(false);
  // The engine's numbers for the runs recorded since the bar was opened, which
  // the conversation shows already and a list of past runs need not repeat.
  const [recordedActionRunIds, setRecordedActionRunIds] = useState<number[]>([]);
  const offeredActions = useSyncExternalStore(
    storeRegistry.actions.subscribe,
    storeRegistry.actions.getActions,
    getServerActions,
  );
  const latestActionRunSequence = useSyncExternalStore(
    storeRegistry.subscribeToActionRuns,
    storeRegistry.latestActionRunSequence,
    () => 0,
  );

  // A draft belongs to the regions it was written for. Whatever is still under
  // way for the old ones is counted out, so its answer is dropped.
  const latestActionId = useRef(0);
  useEffect(
    () => () => {
      latestActionId.current++;
      dropCallsAfterPreview.current();
      setMessage(null);
      // Confirmed changes still running finish, and say how they went, on the new screen.
      if (!confirmedCallsRunning.current) setStatus("idle");
      // What was typed and not sent stays with the old regions, for when the bar comes back to them.
      // The conversation carries over, so a reply is not lost when a request
      // opens another page: the user reads it there. So does a change waiting to
      // be confirmed, unless its action is not offered on the new screen (see
      // the effect on `offeredActions`). A preview only made sense on the
      // screen it was for, so what waited for it ends with it.
      setAttachedFiles([]);
      setRecordedActionRunIds([]);
      carriedTurnCount.current = promptTurnsNow.current.length;
    },
    [regionIdsKey, setMessage],
  );

  // The conversation carried over was said before anything saved on this
  // screen from now on, and its revisions were counted for the old one. These
  // are the first so many turns, as turns are only ever added after them.
  const carriedTurnCount = useRef(0);
  const { revision: screenRevision } = groupSnapshot;
  // Its revision is known once a region of it is on the screen with its saved layout.
  const screenRevisionKnown =
    !groupSnapshot.loading && groupSnapshot.regions.some((region) => region.snapshot.manifest !== null);
  useEffect(() => {
    const turnsToStamp = carriedTurnCount.current;
    if (turnsToStamp === 0 || !screenRevisionKnown) return;
    carriedTurnCount.current = 0;
    setPromptTurns((turnsSoFar) =>
      turnsSoFar.map((promptTurn, position) =>
        position < turnsToStamp ? { ...promptTurn, afterRevision: screenRevision } : promptTurn,
      ),
    );
  }, [regionIdsKey, screenRevisionKnown, screenRevision, setPromptTurns]);

  const regionIds = useMemo(() => JSON.parse(regionIdsKey) as string[], [regionIdsKey]);
  /**
   * Tells the engine an action ran, or was turned down, and how it ended: the
   * action and the names of its fields, never their values. Record-keeping
   * only: the user never waits on it, and is never told if it fails.
   */
  const reportActionRun = useCallback(
    (preparedCall: PreparedActionCall, outcome: "done" | "failed" | "cancelled", screenId = regionIds[0]!) => {
      if (outcome === "done") storeRegistry.noteActionRun();
      const { engine } = storeRegistry;
      if (!engine) return;
      const { name, title } = preparedCall.registeredAction.declaration;
      void engine
        .recordActionRun({
          screenId,
          actionName: name,
          actionTitle: title,
          mode: preparedCall.mode,
          parameterNames: Object.keys(preparedCall.actionArguments),
          outcome,
          ...(latestRequestViaVoice.current && { viaVoice: true }),
        })
        .then(
          (runRecorded) => {
            if (runRecorded.id !== undefined) setRecordedActionRunIds((idsSoFar) => [...idsSoFar, runRecorded.id!]);
          },
          () => {},
        );
    },
    [storeRegistry, regionIds],
  );

  /** Adds what came of the latest request's actions to it. */
  const addOutcomesToLatestTurn = useCallback((outcomes: PromptTurn["outcomes"]) => {
    setPromptTurns((turnsSoFar) =>
      turnsSoFar.length === 0
        ? turnsSoFar
        : [...turnsSoFar.slice(0, -1), { ...turnsSoFar.at(-1)!, outcomes: [...turnsSoFar.at(-1)!.outcomes, ...outcomes] }],
    );
  }, [setPromptTurns]);

  /**
   * Adds what came of waiting calls to the request that asked for them, by its
   * place among the turns, read when the calls were taken: a later request
   * may have calls of its own waiting by the time these end.
   */
  const addOutcomesToTurn = useCallback(
    (turnIndex: number, outcomes: PromptTurn["outcomes"]) => {
      const afterRevision = regionGroup.getSnapshot().revision;
      setPromptTurns((turnsSoFar) => {
        // After a sentence said below the request, they go below it too, in the
        // order things happened. Only sentences are there, so the planner still
        // reads them as what came of that request.
        const onlySentencesSince =
          turnIndex < turnsSoFar.length - 1 && turnsSoFar.slice(turnIndex + 1).every((promptTurn) => !promptTurn.request);
        if (onlySentencesSince) {
          return [...turnsSoFar, { request: "", reply: "", outcomes, savedAsChange: false, afterRevision }];
        }
        return turnsSoFar.map((promptTurn, position) =>
          position === turnIndex ? { ...promptTurn, outcomes: [...promptTurn.outcomes, ...outcomes] } : promptTurn,
        );
      });
    },
    [regionGroup, setPromptTurns],
  );

  /**
   * Resolves to true when the action did what was asked and this bar is still
   * the one it was for. The action resolves to what to tell the user: a
   * sentence, nothing, or `{ failureReason }` with the reason it could not be done.
   */
  const runAction = useCallback(
    async (
      statusWhileRunning: PromptBarStatus,
      performAction: () => Promise<string | null | { failureReason: string } | { text: string; detail: string }>,
    ): Promise<boolean> => {
      const actionId = ++latestActionId.current;
      moveMessageIntoConversation();
      setStatus(statusWhileRunning);
      try {
        const actionOutcome = await performAction();
        if (actionId !== latestActionId.current) return false;
        const actionFailed = typeof actionOutcome === "object" && actionOutcome !== null && "failureReason" in actionOutcome;
        setMessage(
          actionOutcome === null
            ? null
            : actionFailed
              ? { text: actionOutcome.failureReason, isError: true }
              : typeof actionOutcome === "string"
                ? { text: actionOutcome, isError: false }
                : { ...actionOutcome, isError: false },
        );
        setStatus("idle");
        return !actionFailed;
      } catch (error) {
        if (actionId !== latestActionId.current) return false;
        setMessage({ text: describeError(error), isError: true });
        setStatus("idle");
        return false;
      }
    },
    [moveMessageIntoConversation, setMessage],
  );

  const { planFromPrompt, commitPreview, cancelPreview, undoLastChange: undoRegionChange, showOriginal } = regionGroup;

  const engineReachable = useEngineReachable();
  const adjustmentsNotice = useMemo(
    () => describeSavedLayoutAdjustments(groupSnapshot.regions),
    [groupSnapshot.regions],
  );
  const notice = engineReachable
    ? describeAvailableNotice(groupSnapshot, adjustmentsNotice)
    : describeUnavailability(groupSnapshot);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const dismissNotice = useCallback(() => setDismissedNotice(notice), [notice]);

  // Bring what the preview changes, or what the original has that the screen
  // now does not, into view, so the user need not hunt for it. With several
  // regions that is the first change in the first of them to have one.
  const previewedRegion = groupSnapshot.regions.find(
    ({ snapshot }) => snapshot.preview !== null || snapshot.original !== null,
  );
  const previewedRegionId = previewedRegion?.regionId;
  const previewLayout = previewedRegion?.snapshot.preview ?? previewedRegion?.snapshot.original;
  const changedComponentIds = previewedRegion?.snapshot.changedComponentIds;
  useEffect(() => {
    const firstChangedId = previewLayout?.order.find((componentId) => changedComponentIds?.has(componentId));
    if (firstChangedId === undefined || previewedRegionId === undefined) return;
    // Found through the region's store, since a region without a grid has no element of its own.
    storeRegistry.storeFor(previewedRegionId).elementOf(firstChangedId)?.scrollIntoView?.({
      behavior: "smooth",
      block: "center",
    });
  }, [storeRegistry, previewLayout, changedComponentIds, previewedRegionId]);

  // Closing or reloading the browser tab would lose a preview the user has not
  // decided on, so the browser asks first, and only then. A page change inside
  // the application is the host's to allow, and only takes the preview off.
  const { previewing } = groupSnapshot;
  useEffect(() => {
    if (!previewing) return;
    const askBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", askBeforeLeaving);
    return () => window.removeEventListener("beforeunload", askBeforeLeaving);
  }, [previewing]);

  const submitPrompt = useCallback(
    (submitOptions?: { viaVoice?: boolean }) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || status !== "idle") return;
      // Asking for something else instead is an answer too. What waits on a
      // preview belongs to the request that made it, so while a preview shows
      // that is settled once the answer comes: a follow-up that builds on the
      // preview leaves it waiting.
      const callsWereWaiting = Boolean(pendingActionCallsNow.current || callsAfterPreviewNow.current);
      const previewShowedBefore = regionGroup.getSnapshot().previewing;
      const setAsideWaitingCalls = (
        note = CANCELLED_FOR_NEW_REQUEST_MESSAGE,
        reasonForPlanner = CANCELLED_FOR_NEW_REQUEST_REASON,
      ) => {
        addOutcomesToTurn(waitingCallsTurnIndex.current, [
          { text: note, isError: false, noteForPlanner: describeNotRunForPlanner(allWaitingCalls(), reasonForPlanner) },
        ]);
        dropPendingActionCalls.current();
      };
      // What was said before this request goes above what comes of it.
      moveMessageIntoConversation();
      if (callsWereWaiting && !previewShowedBefore) setAsideWaitingCalls();
      // A request is for the screen as it is, so that is what it shows again.
      showOriginal(false);
      latestRequestViaVoice.current = submitOptions?.viaVoice ?? false;
      // Sent, the request leaves the box, so what is typed next is a request of its own.
      setPrompt("");
      const filesForThisRequest = attachedFiles;
      setLatestTurnIsCurrent(false);
      const declarationsSent = storeRegistry.actions.getActions().map((registeredAction) => registeredAction.declaration);
      setRequestInProgress(trimmedPrompt);
      void runAction("planning", async () => {
        const actionId = latestActionId.current;
        const planResponse = await planFromPrompt(trimmedPrompt, submitOptions?.viaVoice ?? false, {
          actions: declarationsSent,
          // As the turns are now, with what this request set aside already in them.
          conversation: conversationToSend(promptTurnsNow.current),
          attachedFiles: filesForThisRequest.map((attachedFile) => ({
            // A long name only helps the planner tell files apart, so it is cut, not refused.
            name: cutToCharacters(attachedFile.name, MAX_ATTACHED_FILE_DESCRIPTION_LENGTH),
            type: cutToCharacters(attachedFile.type, MAX_ATTACHED_FILE_DESCRIPTION_LENGTH),
          })),
          screenId: regionIds[0]!,
        }).catch((error: unknown) => {
          // A failed request can still take the preview off, as when the screen
          // changed elsewhere; what waited on it then can never be decided on.
          if (callsWereWaiting && previewShowedBefore && !regionGroup.getSnapshot().previewing) {
            setAsideWaitingCalls(SCREEN_CHANGED_BEFORE_CONFIRM_MESSAGE, SCREEN_CHANGED_BEFORE_CONFIRM_REASON);
          }
          // Not carried out, it is put back to send again, unless something else was typed meanwhile.
          if (actionId === latestActionId.current && !storeRegistry.draftFor(regionIdsKey).trim()) {
            setPrompt(trimmedPrompt);
            messageIsForRequestInBox.current = true;
          }
          setRequestInProgress(null);
          throw error;
        });
        setRequestInProgress(null);
        // A reply that will be dropped must not leave its preview behind, unexplained.
        if (actionId !== latestActionId.current) {
          cancelPreview();
          return null;
        }
        if (callsWereWaiting && previewShowedBefore) {
          const sameRequestStillShows =
            regionGroup.getSnapshot().previewing &&
            planResponse.previewOutcome !== "new" &&
            planResponse.actionCalls.length === 0;
          if (!sameRequestStillShows) setAsideWaitingCalls();
        }
        const turnIndex = promptTurnsNow.current.length;
        setPromptTurns((turnsSoFar) => [
          ...turnsSoFar,
          {
            request: trimmedPrompt,
            reply: planResponse.message,
            outcomes: [],
            savedAsChange: false,
            afterRevision: regionGroup.getSnapshot().revision,
          },
        ]);
        setLatestTurnIsCurrent(true);
        const showsPreview = regionGroup.getSnapshot().previewing;
        const thisTurn = { turnIndex, request: trimmedPrompt };
        if (!showsPreview) previewTurns.current = [];
        else if (planResponse.previewOutcome === "new") previewTurns.current = [thisTurn];
        else if (planResponse.previewOutcome === "addedTo") previewTurns.current = [...previewTurns.current, thisTurn];
        if (planResponse.actionCalls.length === 0) return null;

        // The page may have changed while the planner worked.
        const preparedCalls = prepareActionCalls(
          storeRegistry.actions.getActions(),
          planResponse.actionCalls,
          filesForThisRequest,
          declarationsSent,
        );
        if (!preparedCalls) return { failureReason: ACTION_NO_LONGER_AVAILABLE_MESSAGE };
        // What only changes what is shown runs at once, in the planner's order, up
        // to the first change to data. That one and everything after it wait to
        // be confirmed, so nothing that was to come after a change comes before it.
        const firstWritePosition = preparedCalls.findIndex((preparedCall) => preparedCall.mode === "write");
        const readsBeforeAnyWrite = firstWritePosition === -1 ? preparedCalls : preparedCalls.slice(0, firstWritePosition);
        const callsToConfirm = firstWritePosition === -1 ? [] : preparedCalls.slice(firstWritePosition);
        // With a preview showing, they wait until it is kept or discarded.
        const callsToRunNow = showsPreview ? [] : readsBeforeAnyWrite;
        if (showsPreview && readsBeforeAnyWrite.length > 0) setCallsAfterPreview(readsBeforeAnyWrite);
        if (callsToConfirm.length > 0 || (showsPreview && readsBeforeAnyWrite.length > 0)) {
          waitingCallsTurnIndex.current = turnIndex;
        }
        // Set before anything runs: a read that opens another page ends this bar's
        // conversation, and what was waiting is then reported as turned down.
        if (callsToConfirm.length > 0) setPendingActionCalls(callsToConfirm);
        const readOutcomes: PromptTurn["outcomes"] = [];
        for (const readCall of callsToRunNow) {
          const runOutcome = await runActionCall(readCall);
          reportActionRun(readCall, runOutcome.done ? "done" : "failed");
          // A read says nothing of its own when it worked, unless the user needs its answer.
          if (!runOutcome.done || (readCall.showResult && runOutcome.returnedText)) {
            readOutcomes.push({ text: runOutcome.text, isError: !runOutcome.done, noteForPlanner: runOutcome.noteForPlanner });
          }
        }
        if (actionId !== latestActionId.current) return null;
        if (readOutcomes.length > 0) addOutcomesToLatestTurn(readOutcomes);
        if (callsToConfirm.length === 0) setAttachedFiles([]);
        return null;
      });
    },
    [
      prompt,
      status,
      runAction,
      planFromPrompt,
      showOriginal,
      cancelPreview,
      attachedFiles,
      regionIds,
      regionIdsKey,
      storeRegistry,
      addOutcomesToLatestTurn,
      addOutcomesToTurn,
      regionGroup,
      reportActionRun,
      setPendingActionCalls,
      setCallsAfterPreview,
      setPrompt,
      allWaitingCalls,
      moveMessageIntoConversation,
      setPromptTurns,
    ],
  );

  dropPendingActionCalls.current = () => {
    for (const pendingCall of pendingActionCallsNow.current ?? []) {
      reportActionRun(pendingCall, "cancelled", pendingActionCallsScreenId.current);
    }
    setPendingActionCalls(null);
    dropCallsAfterPreview.current();
  };
  dropCallsAfterPreview.current = () => {
    for (const waitingCall of callsAfterPreviewNow.current ?? []) reportActionRun(waitingCall, "cancelled");
    setCallsAfterPreview(null);
  };

  /** Runs what was waiting for the preview to be decided on, now that it has been. */
  const runCallsAfterPreview = useCallback(async () => {
    const waitingCalls = callsAfterPreviewNow.current;
    if (!waitingCalls) return;
    const askingTurnIndex = waitingCallsTurnIndex.current;
    setCallsAfterPreview(null);
    const actionId = latestActionId.current;
    const outcomesToShow: PromptTurn["outcomes"] = [];
    for (const [callPosition, waitingCall] of waitingCalls.entries()) {
      // One that opened another page ends what this screen asked for.
      if (actionId !== latestActionId.current) {
        for (const leftOverCall of waitingCalls.slice(callPosition)) reportActionRun(leftOverCall, "cancelled");
        break;
      }
      const runOutcome = await runActionCall(waitingCall);
      reportActionRun(waitingCall, runOutcome.done ? "done" : "failed");
      if (!runOutcome.done || (waitingCall.showResult && runOutcome.returnedText)) {
        outcomesToShow.push({ text: runOutcome.text, isError: !runOutcome.done, noteForPlanner: runOutcome.noteForPlanner });
      }
    }
    if (outcomesToShow.length > 0) addOutcomesToTurn(askingTurnIndex, outcomesToShow);
  }, [reportActionRun, setCallsAfterPreview, addOutcomesToTurn]);

  // An action that leaves the page while it waits to be confirmed is not run:
  // the screen is no longer the one the user was asked about.
  useEffect(() => {
    const waitingCalls = pendingActionCallsNow.current;
    if (!waitingCalls || confirmedCallsRunning.current) return;
    // Compared by what is declared: an action mounted again is still the same action,
    // and what runs is the `run` the user was shown in any case.
    const offeredDeclarations = new Set(
      offeredActions.map((registeredAction) => JSON.stringify(registeredAction.declaration)),
    );
    const actionLeftThePage = waitingCalls.some(
      (waitingCall) => !offeredDeclarations.has(JSON.stringify(waitingCall.registeredAction.declaration)),
    );
    if (!actionLeftThePage) return;
    const noteForPlanner = describeNotRunForPlanner(allWaitingCalls(), SCREEN_CHANGED_BEFORE_CONFIRM_REASON);
    dropPendingActionCalls.current();
    addOutcomesToTurn(waitingCallsTurnIndex.current, [
      { text: SCREEN_CHANGED_BEFORE_CONFIRM_MESSAGE, isError: true, noteForPlanner },
    ]);
  }, [offeredActions, addOutcomesToTurn, allWaitingCalls]);

  /** Runs what the user was asked to confirm, in order, stopping at the first that fails. */
  const confirmActionCalls = useCallback(() => {
    const callsToRun = pendingActionCallsNow.current;
    if (!callsToRun || confirmedCallsRunning.current || status !== "idle") return;
    // Recorded under the screen they were asked for on, which may not be this one.
    const askedOnScreenId = pendingActionCallsScreenId.current;
    const askingTurnIndex = waitingCallsTurnIndex.current;
    confirmedCallsRunning.current = true;
    // Taken off at once, so the same confirmation can never be pressed twice.
    setPendingActionCalls(null);
    void runAction("saving", async () => {
      const actionId = latestActionId.current;
      const runOutcomes: PromptTurn["outcomes"] = [];
      try {
        for (const confirmedCall of callsToRun) {
          const runOutcome = await runActionCall(confirmedCall);
          reportActionRun(confirmedCall, runOutcome.done ? "done" : "failed", askedOnScreenId);
          runOutcomes.push({ text: runOutcome.text, isError: !runOutcome.done, noteForPlanner: runOutcome.noteForPlanner });
          if (!runOutcome.done) break;
        }
      } finally {
        confirmedCallsRunning.current = false;
      }
      // Shown even if the page changed meanwhile: the conversation carried over with it.
      setAttachedFiles([]);
      addOutcomesToTurn(askingTurnIndex, runOutcomes);
      if (actionId !== latestActionId.current) setStatus("idle");
      return null;
    });
  }, [status, runAction, addOutcomesToTurn, reportActionRun, setPendingActionCalls]);

  /** Drops what the user was asked to confirm. Nothing is run. */
  const cancelActionCalls = useCallback(() => {
    if (!pendingActionCallsNow.current || confirmedCallsRunning.current) return;
    const noteForPlanner = describeNotRunForPlanner(allWaitingCalls(), CANCELLED_REASON);
    dropPendingActionCalls.current();
    addOutcomesToTurn(waitingCallsTurnIndex.current, [{ text: "Cancelled.", isError: false, noteForPlanner }]);
  }, [addOutcomesToTurn, allWaitingCalls]);

  /**
   * One line for an action run read back from the engine: its title. The
   * fields it was given are left out, as their values are never kept and
   * their descriptions are written for the planner rather than for people.
   */
  const describeActionRun = useCallback(
    (actionRun: { actionTitle: string; actionMode: "read" | "write" }): string | null =>
      // Opening a page or a chart changes nothing, so it is no part of a history of changes.
      actionRun.actionMode === "read" ? null : actionRun.actionTitle,
    [],
  );

  const attachFiles = useCallback((newFiles: readonly File[]) => {
    setAttachedFiles((filesSoFar) => [...filesSoFar, ...newFiles].slice(0, MAX_ATTACHED_FILES));
  }, []);
  const removeAttachedFile = useCallback((position: number) => {
    setAttachedFiles((filesSoFar) => filesSoFar.filter((_, candidatePosition) => candidatePosition !== position));
  }, []);

  const keepPreview = useCallback(() => {
    let previewKept = false;
    const turnsPreviewed = previewTurns.current;
    void runAction("saving", async () => {
      const commitResult = await commitPreview().catch((error: unknown) => {
        // The screen was fetched again and the preview taken off, so the requests
        // are put back, ready to send again, unless something else was typed since.
        if (error instanceof EngineError && error.code === "conflict" && !storeRegistry.draftFor(regionIdsKey).trim()) {
          setPrompt(turnsPreviewed.map((previewTurn) => previewTurn.request).join("\n"));
        }
        throw error;
      });
      if (commitResult && !commitResult.applied) return { failureReason: PREVIEW_NO_LONGER_FITS_MESSAGE };
      // With no preview there was nothing to save, so nothing is said.
      previewKept = commitResult !== null;
      if (!previewKept) return null;
      return pendingActionCallsNow.current ? SCREEN_CHANGE_SAVED_REST_WAITS_MESSAGE : SCREEN_CHANGE_SAVED_MESSAGE;
    }).then((actionSucceeded) => {
      if (actionSucceeded && previewKept) {
        // The history of saved changes shows them from now on, as the one change they made.
        const savedTurnIndexes = new Set(turnsPreviewed.map((previewTurn) => previewTurn.turnIndex));
        const savedRevision = regionGroup.getSnapshot().revision;
        setPromptTurns((turnsSoFar) =>
          turnsSoFar.map((promptTurn, position) =>
            savedTurnIndexes.has(position)
              ? { ...promptTurn, savedAsChange: true, afterRevision: savedRevision }
              : promptTurn,
          ),
        );
      }
      // Saved or not, the preview has been decided on, so what waited for it goes ahead.
      void runCallsAfterPreview();
    });
  }, [runAction, commitPreview, runCallsAfterPreview, storeRegistry, regionIdsKey, setPrompt, regionGroup, setPromptTurns]);

  const { discardPreview: discardRegionPreview } = regionGroup;
  const discardPreview = useCallback(() => {
    discardRegionPreview();
    setMessage(null);
    setLatestTurnIsCurrent(false);
    // What waited for the preview was part of the same request, so it is turned
    // down with it, and the reply that said it would happen is told so.
    const waitingCalls = callsAfterPreviewNow.current;
    if (waitingCalls) {
      const waitingSummaries = waitingCalls.map((waitingCall) => waitingCall.summary).join(" ");
      addOutcomesToTurn(waitingCallsTurnIndex.current, [
        {
          text: `Discarded, so this wasn't done: ${waitingSummaries}`,
          isError: false,
          noteForPlanner: describeNotRunForPlanner(waitingCalls, PREVIEW_DISCARDED_REASON),
        },
      ]);
    }
    dropCallsAfterPreview.current();
  }, [discardRegionPreview, addOutcomesToTurn, setMessage]);

  // A sentence moved into the conversation was heard already, so it is not the latest answer.
  const latestTurn = promptTurns.filter(saysSomethingNew).at(-1);
  const latestOutcome = latestTurn?.outcomes.at(-1);

  const { restoreRevision: restoreRegionRevision } = regionGroup;
  const restoreRevision = useCallback(
    async (revision: number, restoredRequest?: string): Promise<number | null> => {
      // A region the restore leaves as it was is told nothing, so it is told here.
      showOriginal(false);
      let restoredToRevision: number | null = null;
      const wasRestored = await runAction("saving", async () => {
        restoredToRevision = await restoreRegionRevision(revision);
        if (revision === 0) return "Back to how this page started.";
        const restoredSentence = "Back to how this page was at that point.";
        return restoredRequest ? { text: restoredSentence, detail: `“${restoredRequest}”` } : restoredSentence;
      });
      return wasRestored ? restoredToRevision : null;
    },
    [runAction, restoreRegionRevision, showOriginal],
  );

  // An undo takes back a change to the screen, never what an action did in
  // the application. Once an action is the latest thing done, an undo would
  // take back an older change instead of it, so none is offered until the
  // screen is changed again.
  const actionRanSinceNewestChange = latestActionRunSequence > groupSnapshot.newestChangeSequence;
  const undoLastChange = useCallback(() => {
    if (actionRanSinceNewestChange) {
      moveMessageIntoConversation();
      setMessage({ text: NOTHING_TO_UNDO_SINCE_ACTION_MESSAGE, isError: false });
      return;
    }
    showOriginal(false);
    void runAction("saving", async () => {
      const undoResult = await undoRegionChange();
      return describeUndo(undoResult, manifestOfScreen(regionGroup.getSnapshot().regions));
    });
  }, [actionRanSinceNewestChange, runAction, undoRegionChange, showOriginal, regionGroup, moveMessageIntoConversation, setMessage]);

  return {
    prompt,
    setPrompt,
    status,
    /**
     * A sentence about the last thing done here, such as that a change to the
     * screen is saved, what an undo took back, or why it failed, with a `detail`
     * line under it where there is more to say, such as the request a restore
     * went back to.
     */
    message,
    /**
     * The request sent and still waiting for its answer, so it can be shown at
     * once rather than when the answer comes. Null otherwise.
     */
    requestInProgress,
    /**
     * What to show beside a one-line bar: `message`, or else the answer to the
     * latest request while it is still the one being looked at, or what came of
     * its actions. Null when the request was only for changes to confirm.
     */
    latestReply:
      message ??
      (latestTurnIsCurrent && latestTurn
        ? (latestOutcome ?? (latestTurn.reply.trim() ? { text: latestTurn.reply, isError: false } : null))
        : null),
    /**
     * Until dismissed: that personalising is not available right now, or how a
     * saved layout was carried over to a changed screen.
     */
    notice: notice !== dismissedNotice ? notice : null,
    dismissNotice,
    /**
     * False while the engine cannot be reached, so prompts cannot be carried out.
     * The page's own controls still work, and their changes are saved later.
     */
    available: engineReachable,
    previewing: groupSnapshot.previewing,
    /** True while the screen shows how it first looked, in place of the user's changes. */
    showingOriginal: groupSnapshot.showingOriginal,
    /** True when the screen differs from how it first looked, so there is an original to see or go back to. */
    differsFromOriginal: groupSnapshot.differsFromOriginal,
    /**
     * Shows the screen as it first looked, before any change, without saving
     * anything, or goes back to the user's changes. A preview, or any change,
     * ends it. To keep the original, `restoreRevision(0)`.
     */
    showOriginal,
    /**
     * True when there is a change to the screen to undo, and no action has run
     * since it was made during this visit to the page.
     */
    canUndo: groupSnapshot.canUndo && !actionRanSinceNewestChange,
    /**
     * The requests made since the bar was opened, and sentences about what was
     * done between them, oldest first, leaving out the requests the history of
     * saved changes shows. One whose preview was kept but
     * whose actions also ran stays, with `savedAsChange` set: the history shows
     * the request and the reply, and only what came of the actions is left to show.
     */
    promptTurns: useMemo(
      () => promptTurns.filter((promptTurn) => !promptTurn.savedAsChange || promptTurn.outcomes.length > 0),
      [promptTurns],
    ),
    /** Changes to the application's data that wait for the user to confirm them, or null. */
    pendingActionCalls: useMemo(
      () => pendingActionCalls?.map((preparedCall) => ({ summary: preparedCall.summary })) ?? null,
      [pendingActionCalls],
    ),
    confirmActionCalls,
    cancelActionCalls,
    /**
     * What will happen once the preview is kept or discarded, such as opening
     * another page, or null.
     */
    callsAfterPreview: useMemo(
      () => callsAfterPreview?.map((preparedCall) => ({ summary: preparedCall.summary })) ?? null,
      [callsAfterPreview],
    ),
    /**
     * What a past action run did, in a line, without the values it was given.
     * Null for one that only changed what was shown, which a history of changes leaves out.
     */
    describeActionRun,
    /**
     * The engine's numbers for the action runs recorded since the bar was
     * opened. The conversation shows those, so a list of past runs can leave
     * them out, and it changes each time one is recorded.
     */
    recordedActionRunIds,
    /** The screen's name for its records, such as its past action runs. */
    screenId: regionIds[0]!,
    /** True when the page offers actions, so a request may do more than change how it looks. */
    offersActions: offeredActions.length > 0,
    /** True when an action on the page takes a file, so the user can attach one. */
    acceptsFiles: offeredActions.some((registeredAction) =>
      Object.values(registeredAction.declaration.parameters).some((parameter) => parameter.type === "file"),
    ),
    attachedFiles,
    attachFiles,
    removeAttachedFile,
    submitPrompt,
    keepPreview,
    discardPreview,
    undoLastChange,
    /**
     * Returns the screen to how it was after the given saved change. Give the
     * request that made that change as `restoredRequest`, and the sentence saying
     * so names it in its `detail`. Resolves to the number of the saved change the
     * restore made, or null if it did not happen.
     */
    restoreRevision,
  };
}
