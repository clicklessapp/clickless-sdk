import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { applyOperations, defaultLayout, reconcileLayout, type Layout, type Manifest, type Operation } from "@clickless/core";
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptBar, useAdaptiveRegion } from "../src/index";
import type { TranscriptionResponse } from "../src/engine/engineResponses";

export type RegionApi = ReturnType<typeof useAdaptiveRegion>;
interface EngineCall {
  method: string;
  endpointPath: string;
  token: string | null;
  requestBody: any;
}

type SavedRegionState = { revision: number; layout: Layout | null };

/** What the stand-in engine holds for one region. */
function createFakeRegion(startingState: SavedRegionState) {
  const regionState = {
    ...startingState,
    layoutHistory: [] as (Layout | null)[],
    // The number of the change that made the latest revision, and of the one
    // whose result is showing: an undo goes back to the one before.
    changeId: 0,
    shownChangeId: 0,
    shownChangeHistory: [] as number[],
  };
  const revisionLog: {
    revision: number;
    changeId: number;
    kind: string;
    prompt: string | null;
    message: string | null;
    operations: Operation[];
    layout: Layout | null;
    createdAt: string;
  }[] = [];
  const recordRevision = (kind: string, requestBody: any = {}) =>
    revisionLog.push({
      revision: regionState.revision,
      changeId: regionState.changeId,
      kind,
      prompt: requestBody.prompt ?? null,
      message: requestBody.message ?? null,
      operations: requestBody.operations ?? [],
      layout: regionState.layout,
      createdAt: new Date(Date.UTC(2026, 9, 1, 9, regionState.revision)).toISOString(),
    });
  /** Stores a change, an undo or a restore under the change number it was made by. */
  const storeRevision = (kind: "apply" | "undo" | "restore", changeId: number, layout: Layout | null, requestBody?: any) => {
    if (kind === "undo") {
      regionState.shownChangeId = regionState.shownChangeHistory.pop() ?? 0;
      regionState.layoutHistory.pop();
    } else {
      regionState.layoutHistory.push(regionState.layout);
      regionState.shownChangeHistory.push(regionState.shownChangeId);
      regionState.shownChangeId = changeId;
    }
    regionState.layout = layout;
    regionState.revision += 1;
    regionState.changeId = changeId;
    recordRevision(kind, requestBody);
  };
  const layoutResponse = () => ({
    revision: regionState.revision,
    layout: regionState.layout,
    changeId: regionState.changeId,
  });
  return { regionState, revisionLog, storeRevision, layoutResponse };
}

/**
 * A stand-in engine that keeps one user's layouts in memory, like the real
 * one, each region's apart. `startingState` and `regionState` are the "dashboard" region's.
 */
export function createFakeEngine(startingState: SavedRegionState = { revision: 0, layout: null }) {
  const receivedCalls: EngineCall[] = [];
  const fakeRegions = new Map([["dashboard", createFakeRegion(startingState)]]);
  const { regionState } = fakeRegions.get("dashboard")!;
  let planReply: { operations: Operation[]; message: string } | { error: [number, object] } = {
    operations: [],
    message: "Nothing to change.",
  };
  let planAcrossRegionsReply: {
    changes: { regionId: string; operations: Operation[] }[];
    actionCalls?: { name: string; arguments: Record<string, string | number | boolean> }[];
    message: string;
  } = {
    changes: [],
    message: "Nothing to change.",
  };
  let nextErrorResponse: [number, object] | null = null;
  let planHeldUntil: Promise<void> | null = null;
  // The regions the next undo across regions says keep their part of the change.
  let nextNotUndoneIn: string[] = [];
  let latestChangeId = 0;
  const fakeRegionFor = (regionId: string) => {
    if (!fakeRegions.has(regionId)) fakeRegions.set(regionId, createFakeRegion({ revision: 0, layout: null }));
    return fakeRegions.get(regionId)!;
  };
  /** What an undo answers about the change it takes back, from every region the change reached. */
  const undoneChangeOf = (changeId: number) => {
    const changeEntries = [...fakeRegions.keys()]
      .sort()
      .flatMap((regionId) => fakeRegions.get(regionId)!.revisionLog.filter((entry) => entry.changeId === changeId));
    if (changeId === 0 || changeEntries.length === 0) return null;
    const { kind, prompt, message } = changeEntries[0]!;
    return { kind, prompt, message, operations: changeEntries.flatMap((entry) => entry.operations) };
  };
  // What the engine keeps of the actions run: names and outcomes, as the real one does.
  const recordedActionRuns: {
    id: number;
    screenId: string;
    actionName: string;
    actionTitle: string;
    mode?: string;
    parameterNames: string[];
    outcome: string;
    viaVoice?: boolean;
  }[] = [];
  let dictationOffered = false;
  let transcriptionReply: TranscriptionResponse | { error: [number, object] } = { text: "" };
  const receivedRecordings: { recording: Blob; contentType: string | null; hints: string[]; token: string | null }[] = [];

  const jsonResponse = (status: number, responseBody: unknown) =>
    new Response(JSON.stringify(responseBody), { status, headers: { "Content-Type": "application/json" } });

  const fakeFetch: typeof globalThis.fetch = async (requestInput, requestInit) => {
    const requestUrl = new URL(String(requestInput));
    if (requestUrl.pathname === "/v1/features") return jsonResponse(200, { dictation: dictationOffered });
    if (requestUrl.pathname === "/v1/action-runs") {
      if ((requestInit?.method ?? "GET") === "POST") {
        const reportedRun = JSON.parse(String(requestInit!.body));
        recordedActionRuns.push({ ...reportedRun, id: recordedActionRuns.length + 1 });
        return jsonResponse(201, { recorded: true, id: recordedActionRuns.length });
      }
      const screenRuns = recordedActionRuns
        .filter((recordedRun) => recordedRun.screenId === requestUrl.searchParams.get("screen"))
        .map(({ id, actionName, actionTitle, mode, parameterNames, outcome }) => ({
          id,
          actionName,
          actionTitle,
          actionMode: mode ?? "write",
          parameterNames,
          outcome,
          createdAt: new Date(Date.UTC(2026, 9, 1, 12, id)).toISOString(),
        }))
        .reverse();
      return jsonResponse(200, { runs: screenRuns, hasMore: false });
    }
    if (requestUrl.pathname === "/v1/transcriptions") {
      const recordingHeaders = new Headers(requestInit?.headers);
      receivedRecordings.push({
        recording: requestInit?.body as Blob,
        contentType: recordingHeaders.get("Content-Type"),
        hints: requestUrl.searchParams.getAll("hint"),
        token: recordingHeaders.get("Authorization"),
      });
      return "error" in transcriptionReply
        ? jsonResponse(transcriptionReply.error[0], { detail: transcriptionReply.error[1] })
        : jsonResponse(200, transcriptionReply);
    }
    const requestBody = requestInit?.body ? JSON.parse(String(requestInit.body)) : undefined;
    const requestHeaders = new Headers(requestInit?.headers);
    const regionRequest = /\/v1\/regions\/([^/]+)\/(.*)$/.exec(String(requestInput));
    // A request about several regions is recorded under its address, such as "v1/changes/undo".
    const endpointPath = regionRequest ? regionRequest[2]! : requestUrl.pathname.slice(1);
    receivedCalls.push({ method: requestInit?.method ?? "GET", endpointPath, token: requestHeaders.get("Authorization"), requestBody });
    if (planHeldUntil && (endpointPath === "plan" || endpointPath === "v1/plan")) {
      const heldUntil = planHeldUntil;
      planHeldUntil = null;
      await heldUntil;
    }

    if (nextErrorResponse) {
      const [status, detail] = nextErrorResponse;
      nextErrorResponse = null;
      return jsonResponse(status, { detail });
    }
    if (!regionRequest) return answerAcrossRegions(endpointPath, requestUrl, requestBody);
    const regionId = decodeURIComponent(regionRequest[1]!);
    const { regionState, revisionLog, storeRevision, layoutResponse } = fakeRegionFor(regionId);
    if (endpointPath === "layout") return jsonResponse(200, layoutResponse());
    if (endpointPath === "plan") {
      // A preview sent with the prompt is checked as saving it would be.
      if (requestBody.preview) {
        if (requestBody.preview.baseRevision !== regionState.revision) return jsonResponse(409, { detail: { code: "conflict" } });
        const previewOutcome = applyToSavedLayout(regionId, requestBody.manifest, requestBody.preview.operations);
        if (!previewOutcome.applied) {
          return jsonResponse(422, { detail: { code: "invalid_operations", errors: previewOutcome.errors } });
        }
      }
      return "error" in planReply ? jsonResponse(planReply.error[0], { detail: planReply.error[1] }) : jsonResponse(200, planReply);
    }
    if (endpointPath === "discards") return jsonResponse(201, { recorded: true });
    if (endpointPath === "undo") {
      const undone = undoneChangeOf(regionState.shownChangeId);
      storeRevision("undo", ++latestChangeId, regionState.layoutHistory.at(-1) ?? null);
      return jsonResponse(201, { ...layoutResponse(), notUndoneIn: [], undone });
    }
    if (endpointPath === "restore") {
      const restoredLayout = revisionLog.find((entry) => entry.revision === requestBody.revision)?.layout ?? null;
      storeRevision("restore", ++latestChangeId, restoredLayout);
      return jsonResponse(201, layoutResponse());
    }
    if (endpointPath.startsWith("revisions?")) {
      const queryParams = new URLSearchParams(endpointPath.slice("revisions?".length));
      const beforeRevision = Number(queryParams.get("before") ?? Infinity);
      const olderEntries = revisionLog
        .filter((entry) => entry.revision < beforeRevision)
        .filter((entry) => queryParams.get("prompted") !== "true" || entry.prompt !== null)
        .reverse();
      const pageEntries = olderEntries.slice(0, Number(queryParams.get("limit")));
      return jsonResponse(200, {
        revisions: pageEntries.map(({ layout: _layout, ...entry }) => entry),
        hasMore: olderEntries.length > pageEntries.length,
      });
    }
    const applyOutcome = applyToSavedLayout(regionId, requestBody.manifest, requestBody.operations);
    if (!applyOutcome.applied) return jsonResponse(422, { detail: { code: "invalid_operations", errors: applyOutcome.errors } });
    storeRevision("apply", ++latestChangeId, applyOutcome.layout, requestBody);
    return jsonResponse(201, layoutResponse());
  };

  const applyToSavedLayout = (regionId: string, manifest: Manifest, operations: Operation[]) => {
    const savedLayout = fakeRegionFor(regionId).regionState.layout;
    return applyOperations(
      manifest,
      savedLayout ? reconcileLayout(manifest, savedLayout).layout : defaultLayout(manifest),
      operations,
    );
  };

  /** One change to several regions: stored in every one of them, or in none. */
  const answerAcrossRegions = (endpointPath: string, requestUrl: URL, requestBody: any) => {
    if (endpointPath === "v1/plan") {
      const regionsChangedSincePreview: string[] = requestBody.regions
        .filter((regionPart: any) => regionPart.preview && regionPart.preview.baseRevision !== fakeRegionFor(regionPart.manifest.regionId).regionState.revision)
        .map((regionPart: any) => regionPart.manifest.regionId);
      if (regionsChangedSincePreview.length > 0) {
        return jsonResponse(409, { detail: { code: "conflict", regionIds: regionsChangedSincePreview } });
      }
      return jsonResponse(200, planAcrossRegionsReply);
    }
    if (endpointPath === "v1/discards") return jsonResponse(201, { recorded: true });
    if (endpointPath === "v1/changes" && requestBody === undefined) {
      const regionIds = requestUrl.searchParams.getAll("region");
      const beforeChangeId = Number(requestUrl.searchParams.get("before") ?? Infinity);
      const changesById = new Map<number, any>();
      for (const regionId of regionIds) {
        for (const { layout: _layout, changeId, revision, operations, ...entry } of fakeRegionFor(regionId).revisionLog) {
          if (changeId >= beforeChangeId) continue;
          if (requestUrl.searchParams.get("prompted") === "true" && entry.prompt === null) continue;
          if (!changesById.has(changeId)) changesById.set(changeId, { changeId, ...entry, regions: [] });
          changesById.get(changeId).regions.push({ regionId, revision, operations });
        }
      }
      const olderChanges = [...changesById.values()].sort((firstChange, secondChange) => secondChange.changeId - firstChange.changeId);
      const pageChanges = olderChanges.slice(0, Number(requestUrl.searchParams.get("limit")));
      return jsonResponse(200, { changes: pageChanges, hasMore: olderChanges.length > pageChanges.length });
    }

    const namedRegionIds: string[] = requestBody.regions.map(
      (regionPart: any) => regionPart.regionId ?? regionPart.manifest.regionId,
    );
    const changedRegionIds = namedRegionIds.filter(
      (regionId, position) => requestBody.regions[position].baseRevision !== fakeRegionFor(regionId).regionState.revision,
    );
    if (changedRegionIds.length > 0) {
      return jsonResponse(409, { detail: { code: "conflict", regionIds: changedRegionIds } });
    }
    const layoutsResponse = (extraFields: object = {}) =>
      jsonResponse(201, {
        regions: namedRegionIds.map((regionId) => ({ regionId, ...fakeRegionFor(regionId).layoutResponse() })),
        ...extraFields,
      });

    if (endpointPath === "v1/changes") {
      const applyOutcomes = requestBody.regions.map((regionPart: any) =>
        applyToSavedLayout(regionPart.manifest.regionId, regionPart.manifest, regionPart.operations),
      );
      if (applyOutcomes.some((applyOutcome: any) => !applyOutcome.applied)) {
        return jsonResponse(422, { detail: { code: "invalid_operations", regions: [] } });
      }
      const changeId = ++latestChangeId;
      requestBody.regions.forEach((regionPart: any, position: number) =>
        fakeRegionFor(regionPart.manifest.regionId).storeRevision("apply", changeId, applyOutcomes[position].layout, {
          ...requestBody,
          operations: regionPart.operations,
        }),
      );
      return layoutsResponse();
    }
    if (endpointPath === "v1/changes/undo") {
      const undoableRegions = namedRegionIds
        .map(fakeRegionFor)
        .filter((undoableRegion) => undoableRegion.regionState.layoutHistory.length > 0);
      if (undoableRegions.length === 0) return jsonResponse(409, { detail: { code: "nothing_to_undo" } });
      const mostRecentChangeId = Math.max(...undoableRegions.map((undoableRegion) => undoableRegion.regionState.shownChangeId));
      const changeId = ++latestChangeId;
      for (const undoableRegion of undoableRegions) {
        if (undoableRegion.regionState.shownChangeId === mostRecentChangeId) {
          undoableRegion.storeRevision("undo", changeId, undoableRegion.regionState.layoutHistory.at(-1) ?? null);
        }
      }
      const notUndoneIn = nextNotUndoneIn;
      nextNotUndoneIn = [];
      return layoutsResponse({ notUndoneIn, undone: undoneChangeOf(mostRecentChangeId) });
    }
    // "v1/changes/restore"
    const changeId = ++latestChangeId;
    for (const namedRegion of namedRegionIds.map(fakeRegionFor)) {
      const targetEntry = [...namedRegion.revisionLog].reverse().find((entry) => entry.changeId <= requestBody.changeId);
      if (targetEntry !== namedRegion.revisionLog.at(-1)) {
        namedRegion.storeRevision("restore", changeId, targetEntry?.layout ?? null);
      }
    }
    return layoutsResponse();
  };

  return {
    receivedCalls,
    receivedRecordings,
    recordedActionRuns,
    regionState,
    engineOptions: { url: "https://engine.test", getToken: async () => "signed-token", fetch: fakeFetch },
    setPlanReply: (cannedReply: typeof planReply) => (planReply = cannedReply),
    /** What the planner answers to a prompt sent for several regions at once. */
    setPlanAcrossRegionsReply: (cannedReply: typeof planAcrossRegionsReply) => (planAcrossRegionsReply = cannedReply),
    /** The regions the next undo across several regions says keep their part of the change. */
    keepPartOfTheNextUndoIn: (regionIds: string[]) => (nextNotUndoneIn = regionIds),
    /** What the engine holds for a region other than "dashboard". */
    savedStateOf: (regionId: string) => fakeRegionFor(regionId).regionState,
    /** Makes the engine one that turns speech into text, answering each recording with `cannedReply`. */
    offerDictation: (cannedReply: typeof transcriptionReply) => {
      dictationOffered = true;
      transcriptionReply = cannedReply;
    },
    failNextRequest: (status: number, detail: object) => (nextErrorResponse = [status, detail]),
    /** Holds the next answer to a prompt until the returned function is called. */
    holdNextPlan: () => {
      let release!: () => void;
      planHeldUntil = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

export function renderDashboardWithEngine(
  engine: ReturnType<typeof createFakeEngine>,
  promptControl: ReactNode = <PromptBar regionId="dashboard" />,
) {
  let regionApiValue!: RegionApi;
  function RegionApiProbe() {
    regionApiValue = useAdaptiveRegion("dashboard");
    return null;
  }
  const renderResult = render(
    <AdaptiveProvider userId="user-1" engine={engine.engineOptions}>
      <RegionApiProbe />
      {promptControl}
      <AdaptiveRegion id="dashboard" version="1">
        <Adaptive id="balance" title="Account balance" locked defaults={{ w: 12, h: 1 }}>
          balance
        </Adaptive>
        <Adaptive
          id="revenue"
          title="Revenue"
          capabilities={{ resize: { minW: 4, maxW: 12, minH: 2, maxH: 6 } }}
          defaults={{ w: 6, h: 3 }}
        >
          revenue
        </Adaptive>
        <Adaptive id="txns" title="Transactions" defaults={{ w: 6, h: 3 }}>
          txns
        </Adaptive>
      </AdaptiveRegion>
    </AdaptiveProvider>,
  );
  const drawOrderOf = (componentId: string) =>
    renderResult.container.querySelector<HTMLElement>(`[data-clickless-item="${componentId}"]`)!.style.order;
  return { renderResult, drawOrderOf, regionApi: () => regionApiValue };
}

export const MOVE_TRANSACTIONS_FIRST: Operation[] = [{ type: "move", id: "txns", position: "before", targetId: "revenue" }];
