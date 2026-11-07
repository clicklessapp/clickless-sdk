import type { Action, Manifest, Operation, OperationError } from "@clickless/core";

/**
 * How a previewed change from a prompt ended without being kept: the user
 * chose not to keep it, or it left the screen before they chose.
 */
export type PreviewNotKeptOutcome = "discarded" | "abandoned";

/** Which way a page's text, and so its rows, run. */
export type TextDirection = "ltr" | "rtl";

/** An earlier request on the screen and the reply it got, with what came of it. */
export interface ConversationTurn {
  request: string;
  reply: string;
}
import {
  isActionRunRecorded,
  isActionRunsPage,
  type ActionRunRecorded,
  type ActionRunsPage,
  isLayoutResponse,
  isPlanResponse,
  isDiscardResponse,
  isFeaturesResponse,
  isTranscriptionResponse,
  historyPageFromChanges,
  historyPageFromEngine,
  isEngineHistoryPage,
  isChangesPage,
  isPlanAcrossRegionsResponse,
  isRegionLayoutsResponse,
  isUndoAcrossRegionsResponse,
  isUndoLayoutResponse,
  readErrorDetail,
  type LayoutResponse,
  type PlanAcrossRegionsResponse,
  type PlanResponse,
  type RegionLayoutsResponse,
  type UndoAcrossRegionsResponse,
  type UndoLayoutResponse,
  type DiscardResponse,
  type FeaturesResponse,
  type TranscriptionResponse,
  type HistoryPage,
} from "./engineResponses";
import { NOTHING_UNDERSTOOD_MESSAGE } from "./plainReplies";

/**
 * The planner's reply, or the engine's own sentence when a plan changes nothing,
 * calls nothing and says nothing, so a prompt never ends with nothing on screen.
 * The engine records such a prompt itself.
 */
function readableReply(message: string, doesSomething: boolean): string {
  return message.trim() || doesSomething ? message : NOTHING_UNDERSTOOD_MESSAGE;
}

declare const __CLICKLESS_VERSION__: string | undefined;
// Set when the package is built. Running from source, as the tests do, there is none.
const SDK_VERSION = typeof __CLICKLESS_VERSION__ === "string" ? __CLICKLESS_VERSION__ : "source";

export interface EngineOptions {
  /**
   * Base URL of the ClickLess engine, without a trailing slash. It must start
   * with `https://`, or `http://` for this machine only (`localhost`,
   * `127.0.0.1`, `[::1]` or a `.localhost` name): at any other address nothing
   * is sent.
   */
  url: string;
  /**
   * Returns the token your backend signed for the current user. Called before
   * every request, so it can refresh an expired token.
   */
  getToken: () => string | Promise<string>;
  fetch?: typeof fetch;
}

/**
 * A change the user is looking at and has not kept, sent with a prompt typed
 * meanwhile, which is then planned from it.
 */
export interface PreviewToPlanFrom {
  /** Applied, in order, to the saved layout the preview was made on. */
  operations: readonly Operation[];
  /** The revision the preview was made on. If the saved layout has changed since, nothing is planned. */
  baseRevision: number;
}

/** A region as the screen last saw it, so the engine can tell when it has changed since. */
export interface RegionAsLastSeen {
  regionId: string;
  baseRevision: number;
}

export class EngineError extends Error {
  /** For a change across several regions: the ones that had changed elsewhere. */
  readonly regionIds?: readonly string[];

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly errors?: OperationError[],
    errorOptions?: ErrorOptions & { regionIds?: readonly string[] },
  ) {
    super(message, errorOptions);
    this.name = "EngineError";
    if (errorOptions?.regionIds) this.regionIds = errorOptions.regionIds;
  }
}

const INSECURE_ENGINE_URL_CODE = "insecure_url";
// Names that only ever reach this machine, where no one else can read what is
// sent. Browsers send every `.localhost` name there too.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the engine may be called at this address: over HTTPS, or over plain
 * HTTP to this machine only, as in local development. Anything else would send
 * the user's token and requests where anyone on the way could read them.
 */
function isSecureEngineUrl(engineUrl: string): boolean {
  let parsedUrl: URL;
  try {
    // An address on the page's own site, such as "/clickless", goes the way the page came.
    parsedUrl = new URL(engineUrl, typeof location === "undefined" ? undefined : location.href);
  } catch {
    return false;
  }
  if (parsedUrl.protocol === "https:") return true;
  const { hostname } = parsedUrl;
  return (
    parsedUrl.protocol === "http:" &&
    (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost"))
  );
}

/**
 * True when the error says the engine could not be reached or could not answer
 * properly: no connection, an address it may not be called at, no answer in
 * time, no token from the host, a reply that is not the engine's, or a fault on
 * the engine's side.
 */
export function isEngineUnavailable(error: unknown): boolean {
  if (!(error instanceof EngineError)) return false;
  // A busy engine answered: it is there, and only asks for a moment's pause.
  if (error.code === "service_busy") return false;
  return (
    error.status >= 500 ||
    error.code === "network" ||
    error.code === INSECURE_ENGINE_URL_CODE ||
    error.code === "timeout" ||
    error.code === "token" ||
    error.code === "bad_response"
  );
}

/**
 * True when the same request may well succeed later: the engine was
 * unavailable or busy, the user's sign-in was refused (a fresh token may be
 * accepted), or it asked for a pause. A 403 is not among them: the sign-in was
 * accepted but the user has no permission, which asking again will not change.
 * Anything that is not an `EngineError` is counted too,
 * so nothing unexpected throws away a change for good.
 */
export function isWorthRetrying(error: unknown): boolean {
  if (!(error instanceof EngineError)) return true;
  // An address it may not call stays one for the whole visit.
  if (error.code === INSECURE_ENGINE_URL_CODE) return false;
  return isEngineUnavailable(error) || error.code === "service_busy" || [401, 408, 429].includes(error.status);
}

/** The error for an engine that could not be reached at all. */
export function engineUnreachableError(cause?: unknown): EngineError {
  return new EngineError("The personalisation service could not be reached.", 0, "network", undefined, { cause });
}

/**
 * The account a token was signed for: its `sub` and `tenant` claims, read
 * without checking the signature, which is the engine's to check. A claim the
 * token lacks, or every claim of one that is not a JWT, is undefined: the
 * engine refuses such a token in any case.
 */
function tokenAccount(token: string): { userId?: string; tenantId?: string } {
  const encodedClaims = token.split(".")[1];
  if (!encodedClaims) return {};
  try {
    const base64Claims = encodedClaims.replace(/-/g, "+").replace(/_/g, "/");
    const claimBytes = Uint8Array.from(atob(base64Claims), (character) => character.charCodeAt(0));
    const tokenClaims = JSON.parse(new TextDecoder().decode(claimBytes)) as { sub?: unknown; tenant?: unknown } | null;
    return {
      ...(typeof tokenClaims?.sub === "string" && { userId: tokenClaims.sub }),
      ...(typeof tokenClaims?.tenant === "string" && { tenantId: tokenClaims.tenant }),
    };
  } catch {
    return {};
  }
}

/** The engine, for something that cannot be done without one. */
export function requireEngine(engine: EngineClient | null, actionDescription: string): EngineClient {
  if (!engine) throw new Error(`${actionDescription} needs an engine: pass \`engine\` to AdaptiveProvider`);
  return engine;
}

// How long to wait for the engine before giving up. Planning asks a model, which takes longer.
const REQUEST_TIMEOUT_MS = 30_000;
const PLAN_TIMEOUT_MS = 150_000;
const TRANSCRIPTION_TIMEOUT_MS = 45_000;
// The most a request may send and still be carried on after the page is left.
// Browsers allow 64 KiB across every such request still under way.
const MAX_BODY_BYTES_OUTLIVING_PAGE = 60 * 1024;

interface RequestOptions {
  timeoutMs?: number;
  /**
   * For a change the user made: the browser still sends it, and the engine
   * still saves it, when the page is closed or reloaded before the answer comes.
   */
  outlivesPage?: boolean;
}

const SAVING_A_CHANGE: RequestOptions = { outlivesPage: true };

/** True when the body is small enough for the browser to carry on sending it after the page is left. */
function fitsRequestOutlivingPage(body: BodyInit | undefined): boolean {
  if (body === undefined) return true;
  return typeof body === "string" && new TextEncoder().encode(body).length <= MAX_BODY_BYTES_OUTLIVING_PAGE;
}

// What the engine takes with a recording: names likely to be spoken. They go in
// the request's address, so they are few and short.
const MAX_VOCABULARY_HINTS = 40;
const MAX_VOCABULARY_HINT_LENGTH = 80;
// Writing outside the Latin alphabet takes several times its length in an
// address, and servers refuse an address of more than a few thousand characters.
const MAX_VOCABULARY_QUERY_LENGTH = 2000;

export class EngineClient {
  private engineReachable = true;
  private reachabilityListeners = new Set<() => void>();
  private tokenForAnotherUserReported = false;
  private insecureUrlReported = false;
  // The tenant of the first token sent, as the engine keeps an account under its tenant and user together.
  private tenantId: string | undefined;

  /**
   * `userId` is the user every request is made for. A token the host gives for
   * anyone else, or for them in a tenant other than the first token's, is
   * never sent: `getToken` gives the token of whoever is signed in when it
   * answers, which, for a request made just before another user signed in,
   * is not the user it was made for.
   */
  constructor(
    private readonly engineOptions: EngineOptions,
    private readonly userId?: string,
  ) {}

  /**
   * False from the moment a request finds the engine unavailable until one
   * gets an answer from it again. True until anything has been asked.
   */
  get isReachable(): boolean {
    return this.engineReachable;
  }

  subscribeToReachability = (reachabilityListener: () => void): (() => void) => {
    this.reachabilityListeners.add(reachabilityListener);
    return () => this.reachabilityListeners.delete(reachabilityListener);
  };

  private setReachable(nowReachable: boolean): void {
    if (this.engineReachable === nowReachable) return;
    this.engineReachable = nowReachable;
    for (const reachabilityListener of [...this.reachabilityListeners]) reachabilityListener();
  }

  readLayout(regionId: string): Promise<LayoutResponse> {
    return this.sendRegionRequest(isLayoutResponse, "GET", regionId, "layout");
  }

  applyOperations(
    regionId: string,
    revisionRequest: {
      manifest: Manifest;
      operations: readonly Operation[];
      prompt?: string;
      message?: string;
      baseRevision: number;
      viaVoice?: boolean;
    },
  ): Promise<LayoutResponse> {
    return this.sendRegionRequest(isLayoutResponse, "POST", regionId, "revisions", revisionRequest, SAVING_A_CHANGE);
  }

  restoreRevision(regionId: string, revision: number, baseRevision: number): Promise<LayoutResponse> {
    return this.sendRegionRequest(
      isLayoutResponse,
      "POST",
      regionId,
      "restore",
      { revision, baseRevision },
      SAVING_A_CHANGE,
    );
  }

  async readHistory(
    regionId: string,
    pageOptions: { limit: number; before?: number; promptedOnly?: boolean },
  ): Promise<HistoryPage> {
    const queryString = new URLSearchParams({ limit: String(pageOptions.limit) });
    if (pageOptions.before !== undefined) queryString.set("before", String(pageOptions.before));
    if (pageOptions.promptedOnly) queryString.set("prompted", "true");
    return historyPageFromEngine(
      await this.sendRegionRequest(isEngineHistoryPage, "GET", regionId, `revisions?${queryString}`),
    );
  }

  undoLastChange(regionId: string, baseRevision: number): Promise<UndoLayoutResponse> {
    return this.sendRegionRequest(isUndoLayoutResponse, "POST", regionId, "undo", { baseRevision }, SAVING_A_CHANGE);
  }

  /** Tells the engine a change it planned for a prompt was previewed and not kept. */
  reportDiscardedPreview(
    regionId: string,
    discardReport: {
      manifestVersion: string;
      prompt: string;
      message: string;
      operations: readonly Operation[];
      viaVoice?: boolean;
      /** "abandoned" when the preview left the screen before the user chose. Defaults to "discarded". */
      outcome?: PreviewNotKeptOutcome;
    },
  ): Promise<DiscardResponse> {
    return this.sendRegionRequest(isDiscardResponse, "POST", regionId, "discards", discardReport);
  }

  async planFromPrompt(
    regionId: string,
    planRequest: {
      manifest: Manifest;
      prompt: string;
      viaVoice?: boolean;
      /** Which way the page reads, so "left" and "right" mean what the user sees. Defaults to "ltr". */
      textDirection?: TextDirection;
      /** The columns this screen draws the layout in, when fewer than the manifest's. */
      drawnColumns?: number;
      /** The preview on the screen, if any: the answer is what the prompt changes from it. */
      preview?: PreviewToPlanFrom;
    },
  ): Promise<PlanResponse> {
    const planResponse = await this.sendRegionRequest(
      isPlanResponse,
      "POST",
      regionId,
      "plan",
      planRequest,
      { timeoutMs: PLAN_TIMEOUT_MS },
    );
    return { ...planResponse, message: readableReply(planResponse.message, planResponse.operations.length > 0) };
  }

  /** `planFromPrompt` for several regions of one screen, planned together in one request. */
  async planAcrossRegions(planRequest: {
    regions: {
      manifest: Manifest;
      /** The columns this screen draws the region in, when fewer than its manifest's. */
      drawnColumns?: number;
      /** This region's part of the preview on the screen, if any. */
      preview?: PreviewToPlanFrom;
    }[];
    prompt: string;
    viaVoice?: boolean;
    /** What the screen offers to do for the user. There may then be no regions. */
    actions?: readonly Action[];
    /** Earlier requests on the screen and their replies, oldest first. */
    conversation?: readonly ConversationTurn[];
    /** Files the user attached: their names and types only. */
    attachedFiles?: readonly { name: string; type: string }[];
    /** What a missed request is recorded under when no region is on the screen. */
    screenId?: string;
    /** Which way the page reads, so "left" and "right" mean what the user sees. Defaults to "ltr". */
    textDirection?: TextDirection;
  }): Promise<PlanAcrossRegionsResponse> {
    const planResponse = await this.sendJsonRequest(
      isPlanAcrossRegionsResponse,
      "POST",
      "plan",
      planRequest,
      { timeoutMs: PLAN_TIMEOUT_MS },
    );
    const doesSomething =
      planResponse.changes.some((change) => change.operations.length > 0) || (planResponse.actionCalls ?? []).length > 0;
    return { ...planResponse, message: readableReply(planResponse.message, doesSomething) };
  }

  /** Saves one change to several regions: every region's part is stored, or none is. */
  saveChangeAcrossRegions(changeRequest: {
    regions: { manifest: Manifest; operations: readonly Operation[]; baseRevision: number }[];
    prompt?: string;
    message?: string;
    viaVoice?: boolean;
  }): Promise<RegionLayoutsResponse> {
    return this.sendJsonRequest(isRegionLayoutsResponse, "POST", "changes", changeRequest, SAVING_A_CHANGE);
  }

  /** Undoes the latest change among these regions, in each of them it reached. */
  undoAcrossRegions(regions: RegionAsLastSeen[]): Promise<UndoAcrossRegionsResponse> {
    return this.sendJsonRequest(isUndoAcrossRegionsResponse, "POST", "changes/undo", { regions }, SAVING_A_CHANGE);
  }

  /** Returns these regions to how they were after the change `changeId`; 0 is before any. */
  restoreAcrossRegions(changeId: number, regions: RegionAsLastSeen[]): Promise<RegionLayoutsResponse> {
    return this.sendJsonRequest(
      isRegionLayoutsResponse,
      "POST",
      "changes/restore",
      { changeId, regions },
      SAVING_A_CHANGE,
    );
  }

  /** The history of several regions as one list. Each entry's `revision` is its change's number. */
  async readChanges(
    regionIds: readonly string[],
    pageOptions: { limit: number; before?: number; promptedOnly?: boolean },
  ): Promise<HistoryPage> {
    const queryString = new URLSearchParams({ limit: String(pageOptions.limit) });
    for (const regionId of regionIds) queryString.append("region", regionId);
    if (pageOptions.before !== undefined) queryString.set("before", String(pageOptions.before));
    if (pageOptions.promptedOnly) queryString.set("prompted", "true");
    return historyPageFromChanges(await this.sendRequest(isChangesPage, "GET", `changes?${queryString}`));
  }

  /** `reportDiscardedPreview` for a preview that changed several regions. */
  reportDiscardedAcrossRegions(discardReport: {
    prompt: string;
    message: string;
    regions: { regionId: string; manifestVersion: string; operations: readonly Operation[] }[];
    viaVoice?: boolean;
    outcome?: PreviewNotKeptOutcome;
  }): Promise<DiscardResponse> {
    return this.sendJsonRequest(isDiscardResponse, "POST", "discards", discardReport);
  }

  /**
   * Notes that the user ran an action, or turned it down, and how it ended.
   * Only the names of the fields it was given are sent, never their values.
   */
  recordActionRun(actionRunReport: {
    screenId: string;
    actionName: string;
    actionTitle: string;
    /** Whether it changed something, or only what was shown. */
    mode: "read" | "write";
    parameterNames: readonly string[];
    outcome: "done" | "failed" | "cancelled";
    viaVoice?: boolean;
  }): Promise<ActionRunRecorded> {
    return this.sendJsonRequest(isActionRunRecorded, "POST", "action-runs", actionRunReport);
  }

  /** The signed-in user's own action runs on one screen, newest first. */
  readActionRuns(screenId: string, pageOptions: { limit: number }): Promise<ActionRunsPage> {
    const queryString = new URLSearchParams({ screen: screenId, limit: String(pageOptions.limit) });
    return this.sendRequest(isActionRunsPage, "GET", `action-runs?${queryString}`);
  }

  /** What the engine is set up to do, so only what will work is offered. */
  readFeatures(): Promise<FeaturesResponse> {
    return this.sendRequest(isFeaturesResponse, "GET", "features");
  }

  /**
   * Turns a recording of a spoken prompt into text. `vocabularyHints` are names
   * likely to be spoken, such as the titles on the screen.
   */
  transcribeRecording(
    recording: Blob,
    vocabularyHints: readonly string[] = [],
  ): Promise<TranscriptionResponse> {
    const queryString = new URLSearchParams();
    const sentHints = new Set<string>();
    for (const vocabularyHint of vocabularyHints) {
      const sentHint = vocabularyHint.trim().slice(0, MAX_VOCABULARY_HINT_LENGTH);
      // The engine refuses a request holding the NUL character, and a hint is not worth that.
      if (!sentHint || sentHint.includes("\0") || sentHints.has(sentHint)) continue;
      if (sentHints.size === MAX_VOCABULARY_HINTS) break;
      const queryStringWithHint = new URLSearchParams(queryString);
      queryStringWithHint.append("hint", sentHint);
      // A shorter one further on may still fit.
      if (queryStringWithHint.toString().length > MAX_VOCABULARY_QUERY_LENGTH) continue;
      sentHints.add(sentHint);
      queryString.append("hint", sentHint);
    }
    return this.sendRequest(
      isTranscriptionResponse,
      "POST",
      sentHints.size > 0 ? `transcriptions?${queryString}` : "transcriptions",
      { body: recording, contentType: recording.type },
      { timeoutMs: TRANSCRIPTION_TIMEOUT_MS },
    );
  }

  private sendRegionRequest<T>(
    isExpectedBody: (responseBody: unknown) => responseBody is T,
    method: string,
    regionId: string,
    endpointPath: string,
    jsonBody?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    return this.sendJsonRequest(
      isExpectedBody,
      method,
      `regions/${encodeURIComponent(regionId)}/${endpointPath}`,
      jsonBody,
      requestOptions,
    );
  }

  private sendJsonRequest<T>(
    isExpectedBody: (responseBody: unknown) => responseBody is T,
    method: string,
    pathUnderV1: string,
    jsonBody?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    return this.sendRequest(
      isExpectedBody,
      method,
      pathUnderV1,
      jsonBody === undefined ? undefined : { body: JSON.stringify(jsonBody), contentType: "application/json" },
      requestOptions,
    );
  }

  private async sendRequest<T>(
    isExpectedBody: (responseBody: unknown) => responseBody is T,
    method: string,
    pathUnderV1: string,
    requestPayload?: { body: BodyInit; contentType: string },
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    try {
      const responseBody = await this.sendRequestOnce(isExpectedBody, method, pathUnderV1, requestPayload, requestOptions);
      this.setReachable(true);
      return responseBody;
    } catch (error) {
      // An answer that is a refusal still shows the engine is there.
      this.setReachable(!isEngineUnavailable(error));
      throw error;
    }
  }

  /**
   * One request, given up on once `timeoutMs` has passed since it began,
   * whatever it is waiting on then: the host's token, the answer, or the
   * reading of its body. Nothing waits on the engine for longer.
   */
  private async sendRequestOnce<T>(
    isExpectedBody: (responseBody: unknown) => responseBody is T,
    method: string,
    pathUnderV1: string,
    requestPayload: { body: BodyInit; contentType: string } | undefined,
    { timeoutMs = REQUEST_TIMEOUT_MS, outlivesPage = false }: RequestOptions,
  ): Promise<T> {
    // A timer of the SDK's own, since `AbortSignal.timeout` is missing from
    // browsers the rest of the SDK still runs on.
    const timeoutController = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeLimitReached = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new EngineError("The personalisation service took too long to answer.", 0, "timeout"));
        // Stops the request, for a `fetch` that listens. One that does not is left behind.
        timeoutController.abort();
      }, timeoutMs);
    });
    const requestResult = this.sendRequestWithin(
      isExpectedBody,
      method,
      pathUnderV1,
      requestPayload,
      timeoutController.signal,
      outlivesPage,
    );
    // Once the time is up, how a request left behind ends no longer matters.
    requestResult.catch(() => {});
    try {
      return await Promise.race([requestResult, timeLimitReached]);
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /** The request itself, from asking for the token to reading the answer, stopped by `timeoutSignal`. */
  private async sendRequestWithin<T>(
    isExpectedBody: (responseBody: unknown) => responseBody is T,
    method: string,
    pathUnderV1: string,
    requestPayload: { body: BodyInit; contentType: string } | undefined,
    timeoutSignal: AbortSignal,
    outlivesPage: boolean,
  ): Promise<T> {
    // Before the token is asked for, so it is never even fetched for such an address.
    if (!isSecureEngineUrl(this.engineOptions.url)) {
      if (!this.insecureUrlReported) {
        this.insecureUrlReported = true;
        console.warn(
          "ClickLess: the engine url must start with https:// (http:// only for localhost, 127.0.0.1, [::1] " +
            "or a .localhost name), so no request was sent.",
        );
      }
      throw new EngineError("The personalisation service's address is not secure.", 0, INSECURE_ENGINE_URL_CODE);
    }
    let userToken: string;
    try {
      userToken = await this.engineOptions.getToken();
    } catch (cause) {
      throw new EngineError("No token could be got for the current user.", 0, "token", undefined, {
        cause,
      });
    }
    if (this.userId !== undefined) this.refuseTokenForAnotherAccount(userToken);
    // The time ran out while the host was getting the token.
    if (timeoutSignal.aborted) throw engineUnreachableError();

    const fetchImplementation = this.engineOptions.fetch ?? fetch;
    const sendOnce = (keepalive: boolean) =>
      fetchImplementation(`${this.engineOptions.url}/v1/${pathUnderV1}`, {
        method,
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Clickless-Client": `react/${SDK_VERSION}`,
          ...(requestPayload && { "Content-Type": requestPayload.contentType }),
        },
        ...(requestPayload && { body: requestPayload.body }),
        signal: timeoutSignal,
        ...(keepalive && { keepalive: true }),
      });
    const sentToOutlivePage = outlivesPage && fitsRequestOutlivingPage(requestPayload?.body);
    let response: Response;
    try {
      response = await sendOnce(sentToOutlivePage).catch((error: unknown) => {
        // The browser refuses one when others still under way already send as
        // much as it allows; sent as an ordinary request, it is saved all the same
        // unless the page is left meanwhile.
        if (sentToOutlivePage && error instanceof TypeError && !timeoutSignal.aborted) return sendOnce(false);
        throw error;
      });
    } catch (cause) {
      throw engineUnreachableError(cause);
    }
    // The body is read inside the same time limit as the request.
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      if (isExpectedBody(responseBody)) return responseBody;
      throw new EngineError(
        "The personalisation service sent a reply that could not be read.",
        response.status,
        "bad_response",
      );
    }
    return this.throwEngineError(response.status, responseBody);
  }

  private refuseTokenForAnotherAccount(userToken: string): void {
    const { userId: tokenUserId, tenantId: tokenTenantId } = tokenAccount(userToken);
    const forAnotherUser = tokenUserId !== undefined && tokenUserId !== this.userId;
    const forAnotherTenant =
      tokenTenantId !== undefined && this.tenantId !== undefined && tokenTenantId !== this.tenantId;
    if (!forAnotherUser && !forAnotherTenant) {
      this.tenantId ??= tokenTenantId;
      return;
    }
    if (!this.tokenForAnotherUserReported) {
      this.tokenForAnotherUserReported = true;
      console.warn(
        "ClickLess: a token was for another user than AdaptiveProvider's userId, or another tenant than the first " +
          "token's, so the request was not sent. userId must be the token's `sub`, and a provider is for one tenant.",
      );
    }
    throw new EngineError("The token is for another user than the one this page is for.", 0, "token");
  }

  private throwEngineError(httpStatus: number, responseBody: unknown): never {
    const errorDetail = readErrorDetail(responseBody);
    throw new EngineError(
      errorDetail.message ?? `The personalisation service returned an error (${httpStatus}).`,
      httpStatus,
      errorDetail.code ?? "error",
      errorDetail.errors,
      errorDetail.regionIds ? { regionIds: errorDetail.regionIds } : undefined,
    );
  }
}
