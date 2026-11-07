import { ActionCall, Operation, type Layout, type OperationError } from "@clickless/core";

export interface LayoutResponse {
  revision: number;
  /** null means the default layout. */
  layout: Layout | null;
  /** Whether the latest saved change can be undone. Absent from engines that do not say. */
  canUndo?: boolean;
  /**
   * The number of the change that made this revision, counted across all of the
   * user's regions. 0 when the region was never changed. Absent from engines
   * that cannot change several regions at once.
   */
  changeId?: number;
}

/** A region's layout in an answer that carries several. */
export interface RegionLayoutResponse extends LayoutResponse {
  regionId: string;
}

export interface RegionLayoutsResponse {
  regions: RegionLayoutResponse[];
}

/** The change an undo took back. */
export interface UndoneChange {
  /** `restore` went back to an earlier version of the screen. */
  kind: "apply" | "restore";
  /** What the user asked for. Null for a change made with the application's own controls. */
  prompt: string | null;
  /** From several regions, every region's, one region after another. */
  operations: Operation[];
}

/**
 * What an undo answers. `notUndoneIn` names the regions the undone change also
 * reached that keep their part of it, because they changed again since.
 * `undone` is the change taken back, null when the engine cannot tell which.
 * Both are absent from engines that do not say. The undo has happened whatever
 * `undone` holds, so it is read with care rather than checked with the rest.
 */
export interface UndoLayoutResponse extends LayoutResponse {
  notUndoneIn?: string[];
  undone?: UndoneChange | null;
}

/** `UndoLayoutResponse` for an undo across several regions. */
export interface UndoAcrossRegionsResponse extends RegionLayoutsResponse {
  notUndoneIn?: string[];
  undone?: UndoneChange | null;
}

/** What the planner proposes for a prompt sent for several regions. */
export interface PlanAcrossRegionsResponse {
  /** Only the regions that change. */
  changes: { regionId: string; operations: Operation[] }[];
  /** The actions to run, in order. Absent from engines that offer none. */
  actionCalls?: ActionCall[];
  message: string;
}

export interface PlanResponse {
  operations: Operation[];
  message: string;
}

export interface DiscardResponse {
  /** False when the engine is set to keep no such records. */
  recorded: boolean;
}

export interface FeaturesResponse {
  /** Whether the engine can turn a spoken prompt into text. */
  dictation: boolean;
}

export interface TranscriptionResponse {
  /** What was said. Empty when nothing could be made out, or when it seemed to hold a secret. */
  text: string;
  /**
   * Given only when what was said is not given back, such as when it seems to
   * hold a password or card number: what to tell the user instead.
   */
  message?: string;
}

export interface HistoryEntry {
  /**
   * Which point in the history this is: pass it to `restoreRevision`. From one
   * region's history it is that region's revision. From a history of several
   * regions it is the change's own number, the same as `changeId`.
   */
  revision: number;
  /**
   * Only in a history of several regions: the number of the change, counted
   * across all of the user's regions. Its presence says that `revision` holds
   * this number and not a region's revision.
   */
  changeId?: number;
  /** `apply` is a change; `undo` and `restore` returned to an earlier layout. */
  kind: "apply" | "undo" | "restore";
  /** What the user asked for. Null for changes made with the application's own controls. */
  prompt: string | null;
  /** What the planner replied. */
  message: string | null;
  operations: Operation[];
  createdAt: string;
  /**
   * From a history of several regions: what the change did in each region it
   * reached. `revision` is then the number of the change as a whole, and
   * `operations` holds every region's, one region after another.
   */
  regions?: { regionId: string; revision: number; operations: Operation[] }[];
}

export interface HistoryPage {
  /** Newest first. */
  revisions: HistoryEntry[];
  hasMore: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A reply with status 200 is not always the engine's: a proxy or a sign-in page
// can answer in its place. Each is checked before it reaches anything that renders.
export function isLayoutResponse(responseBody: unknown): responseBody is LayoutResponse {
  return (
    isRecord(responseBody) &&
    typeof responseBody.revision === "number" &&
    (responseBody.layout === null || isRecord(responseBody.layout)) &&
    (responseBody.canUndo === undefined || typeof responseBody.canUndo === "boolean")
  );
}

const isOperationList = (candidateOperations: unknown): candidateOperations is Operation[] =>
  Array.isArray(candidateOperations) &&
  candidateOperations.every((operation) => Operation.safeParse(operation).success);

export function isPlanResponse(responseBody: unknown): responseBody is PlanResponse {
  return isRecord(responseBody) && typeof responseBody.message === "string" && isOperationList(responseBody.operations);
}

export function isPlanAcrossRegionsResponse(responseBody: unknown): responseBody is PlanAcrossRegionsResponse {
  return (
    isRecord(responseBody) &&
    typeof responseBody.message === "string" &&
    Array.isArray(responseBody.changes) &&
    responseBody.changes.every(
      (change) => isRecord(change) && typeof change.regionId === "string" && isOperationList(change.operations),
    ) &&
    (responseBody.actionCalls === undefined ||
      (Array.isArray(responseBody.actionCalls) &&
        responseBody.actionCalls.every((actionCall) => ActionCall.safeParse(actionCall).success)))
  );
}

export function isRegionLayoutsResponse(responseBody: unknown): responseBody is RegionLayoutsResponse {
  return (
    isRecord(responseBody) &&
    Array.isArray(responseBody.regions) &&
    responseBody.regions.every(
      (region) => isLayoutResponse(region) && typeof (region as { regionId?: unknown }).regionId === "string",
    )
  );
}

const isOptionalStringList = (candidateList: unknown): boolean =>
  candidateList === undefined ||
  (Array.isArray(candidateList) && candidateList.every((listEntry) => typeof listEntry === "string"));

export function isUndoLayoutResponse(responseBody: unknown): responseBody is UndoLayoutResponse {
  return isLayoutResponse(responseBody) && isOptionalStringList((responseBody as UndoLayoutResponse).notUndoneIn);
}

export function isUndoAcrossRegionsResponse(responseBody: unknown): responseBody is UndoAcrossRegionsResponse {
  return (
    isRegionLayoutsResponse(responseBody) &&
    isOptionalStringList((responseBody as UndoAcrossRegionsResponse).notUndoneIn)
  );
}

export function isDiscardResponse(responseBody: unknown): responseBody is DiscardResponse {
  return isRecord(responseBody) && typeof responseBody.recorded === "boolean";
}

export function isFeaturesResponse(responseBody: unknown): responseBody is FeaturesResponse {
  return isRecord(responseBody) && typeof responseBody.dictation === "boolean";
}

export function isTranscriptionResponse(responseBody: unknown): responseBody is TranscriptionResponse {
  return (
    isRecord(responseBody) &&
    typeof responseBody.text === "string" &&
    (responseBody.message === undefined || typeof responseBody.message === "string")
  );
}

/** A history entry as the engine sends it, before what it says is made safe to show. */
interface EngineHistoryEntry {
  revision: number;
  createdAt: string;
  kind?: unknown;
  prompt?: unknown;
  message?: unknown;
  operations: unknown[];
}

/** One region's history as the engine sends it. */
export interface EngineHistoryPage {
  /** Newest first. */
  revisions: EngineHistoryEntry[];
  hasMore: boolean;
}

const isDateText = (candidateDate: unknown): candidateDate is string =>
  typeof candidateDate === "string" && !Number.isNaN(Date.parse(candidateDate));

// What places an entry in the history is checked, and a reply without it is
// refused. What is only shown is made safe instead: anything else in it is
// drawn as text, so an object there would take the page down with it.
export function isEngineHistoryPage(responseBody: unknown): responseBody is EngineHistoryPage {
  return (
    isRecord(responseBody) &&
    typeof responseBody.hasMore === "boolean" &&
    Array.isArray(responseBody.revisions) &&
    responseBody.revisions.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.revision === "number" &&
        isDateText(entry.createdAt) &&
        Array.isArray(entry.operations),
    )
  );
}

const HISTORY_ENTRY_KINDS: readonly HistoryEntry["kind"][] = ["apply", "undo", "restore"];

/** The entry's kind, or "apply" for one this SDK does not know, which is described as a change. */
const historyEntryKindOf = (kind: unknown): HistoryEntry["kind"] =>
  HISTORY_ENTRY_KINDS.find((knownKind) => knownKind === kind) ?? "apply";

const textOrNull = (fieldValue: unknown): string | null => (typeof fieldValue === "string" ? fieldValue : null);

/** The operations that can be read: those that say what type they are. */
const readableOperationsOf = (operations: unknown[]): Operation[] =>
  operations.filter((operation): operation is Operation => isRecord(operation) && typeof operation.type === "string");

/** One region's history with what is shown made safe to show. */
export function historyPageFromEngine(enginePage: EngineHistoryPage): HistoryPage {
  return {
    revisions: enginePage.revisions.map((entry) => ({
      revision: entry.revision,
      kind: historyEntryKindOf(entry.kind),
      prompt: textOrNull(entry.prompt),
      message: textOrNull(entry.message),
      operations: readableOperationsOf(entry.operations),
      createdAt: entry.createdAt,
    })),
    hasMore: enginePage.hasMore,
  };
}

/** The engine's history of several regions, as it sends it. */
export interface ChangesPage {
  /** Newest first. */
  changes: {
    changeId: number;
    kind?: unknown;
    prompt?: unknown;
    message?: unknown;
    createdAt: string;
    regions: { regionId: string; revision: number; operations: unknown[] }[];
  }[];
  hasMore: boolean;
}

export function isChangesPage(responseBody: unknown): responseBody is ChangesPage {
  return (
    isRecord(responseBody) &&
    typeof responseBody.hasMore === "boolean" &&
    Array.isArray(responseBody.changes) &&
    responseBody.changes.every(
      (change) =>
        isRecord(change) &&
        typeof change.changeId === "number" &&
        isDateText(change.createdAt) &&
        Array.isArray(change.regions) &&
        change.regions.every(
          (region) =>
            isRecord(region) &&
            typeof region.regionId === "string" &&
            typeof region.revision === "number" &&
            Array.isArray(region.operations),
        ),
    )
  );
}

/** A history of several regions in the same shape as one region's, one entry per change, made safe to show. */
export function historyPageFromChanges(changesPage: ChangesPage): HistoryPage {
  return {
    revisions: changesPage.changes.map((change) => {
      const regions = change.regions.map(({ regionId, revision, operations }) => ({
        regionId,
        revision,
        operations: readableOperationsOf(operations),
      }));
      return {
        revision: change.changeId,
        changeId: change.changeId,
        kind: historyEntryKindOf(change.kind),
        prompt: textOrNull(change.prompt),
        message: textOrNull(change.message),
        operations: regions.flatMap((region) => region.operations),
        createdAt: change.createdAt,
        regions,
      };
    }),
    hasMore: changesPage.hasMore,
  };
}

/** What the engine said went wrong: the `detail` of an error reply. */
export interface ErrorDetail {
  code?: string;
  message?: string;
  errors?: OperationError[];
  /** For a request that named several regions: the ones that had changed elsewhere. */
  regionIds?: string[];
}

/**
 * The `detail` of an error reply, keeping only the fields of the kind the engine
 * sends: a reply that is not the engine's can hold anything. Empty when `detail`
 * is not an object, as for the plain sentence the engine sends for a missing or
 * rejected token.
 */
export function readErrorDetail(responseBody: unknown): ErrorDetail {
  const errorDetail = isRecord(responseBody) ? responseBody.detail : undefined;
  if (!isRecord(errorDetail)) return {};
  const { code, message, errors, regionIds } = errorDetail;
  return {
    ...(typeof code === "string" && { code }),
    ...(typeof message === "string" && { message }),
    ...(Array.isArray(errors) && errors.every(isOperationError) && { errors }),
    ...(Array.isArray(regionIds) &&
      regionIds.every((regionId): regionId is string => typeof regionId === "string") && { regionIds }),
  };
}

// A code the SDK does not know yet passes too: describeError has a sentence for any code.
function isOperationError(value: unknown): value is OperationError {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

/** An action the user ran or turned down, as the engine keeps it: never the values it was given. */
export interface ActionRunEntry {
  id: number;
  actionName: string;
  actionTitle: string;
  /** `read` only changed what was shown, such as opening a page. */
  actionMode: "read" | "write";
  /** The names of the fields it was given. */
  parameterNames: string[];
  outcome: "done" | "failed" | "cancelled";
  createdAt: string;
}

export interface ActionRunsPage {
  /** Newest first. */
  runs: ActionRunEntry[];
  hasMore: boolean;
}

export interface ActionRunRecorded {
  recorded: boolean;
  id?: number;
}

export function isActionRunsPage(responseBody: unknown): responseBody is ActionRunsPage {
  return (
    isRecord(responseBody) &&
    typeof responseBody.hasMore === "boolean" &&
    Array.isArray(responseBody.runs) &&
    responseBody.runs.every(
      (run) =>
        isRecord(run) &&
        typeof run.id === "number" &&
        typeof run.actionName === "string" &&
        typeof run.actionTitle === "string" &&
        (run.actionMode === "read" || run.actionMode === "write") &&
        Array.isArray(run.parameterNames) &&
        run.parameterNames.every((parameterName: unknown) => typeof parameterName === "string") &&
        (run.outcome === "done" || run.outcome === "failed" || run.outcome === "cancelled") &&
        typeof run.createdAt === "string" &&
        !Number.isNaN(Date.parse(run.createdAt)),
    )
  );
}

export function isActionRunRecorded(responseBody: unknown): responseBody is ActionRunRecorded {
  return (
    isRecord(responseBody) &&
    typeof responseBody.recorded === "boolean" &&
    (responseBody.id === undefined || typeof responseBody.id === "number")
  );
}
