import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { Layout } from "@clickless/core";
import { ActionRegistry } from "../actions/actionRegistry";
import { EngineClient, type EngineOptions } from "../engine/engineClient";
import type { FirstPaintOrder } from "./firstPaintOrder";
import { RegionGroup } from "./regionGroup";
import { RegionStore } from "./regionStore";

export class RegionStoreRegistry {
  private storesByRegionId = new Map<string, RegionStore>();
  private groupsByRegionIds = new Map<string, RegionGroup>();
  /** Null when the provider was given no engine. */
  readonly engine: EngineClient | null;
  /** The actions offered on the page right now. */
  readonly actions = new ActionRegistry();
  private dictationOffered: Promise<boolean> | null = null;
  // What was typed in each prompt bar and not sent, by the regions it speaks for.
  private promptDrafts = new Map<string, string>();
  private draftListeners = new Set<() => void>();

  constructor(engineOptions: EngineOptions | undefined, userId?: string) {
    this.engine = engineOptions ? new EngineClient(engineOptions, userId) : null;
  }

  /**
   * Whether the engine can turn speech into text. Asked once for all the
   * regions on a page. A failed request is not remembered, so it is asked again.
   */
  isDictationOffered(): Promise<boolean> {
    if (!this.engine) return Promise.resolve(false);
    this.dictationOffered ??= this.engine.readFeatures().then(
      (engineFeatures) => engineFeatures.dictation,
      () => {
        this.dictationOffered = null;
        return false;
      },
    );
    return this.dictationOffered;
  }

  /**
   * The prompt typed for a set of regions and not sent yet, so it is still
   * there when the user comes back to them, as on returning to a page.
   */
  draftFor = (regionIdsKey: string): string => this.promptDrafts.get(regionIdsKey) ?? "";

  keepDraft = (regionIdsKey: string, draftText: string): void => {
    if (draftText) this.promptDrafts.set(regionIdsKey, draftText);
    else this.promptDrafts.delete(regionIdsKey);
    for (const draftListener of [...this.draftListeners]) draftListener();
  };

  /** Two bars for the same regions show the same draft, so each hears when it changes. */
  subscribeToDrafts = (draftListener: () => void): (() => void) => {
    this.draftListeners.add(draftListener);
    return () => this.draftListeners.delete(draftListener);
  };

  private latestChangeSequence = 0;
  /** Numbers the changes made in any of these regions, so the newest among several can be told. */
  private nextChangeSequence = (): number => ++this.latestChangeSequence;

  /**
   * Where the latest action run falls among the changes, in the same
   * numbering, or 0 when none has run since the page was loaded.
   */
  private actionRunSequence = 0;
  private actionRunListeners = new Set<() => void>();

  latestActionRunSequence = (): number => this.actionRunSequence;

  /** Notes that an action has just run, after every change made so far. */
  noteActionRun = (): void => {
    this.actionRunSequence = this.nextChangeSequence();
    for (const actionRunListener of [...this.actionRunListeners]) actionRunListener();
  };

  subscribeToActionRuns = (actionRunListener: () => void): (() => void) => {
    this.actionRunListeners.add(actionRunListener);
    return () => this.actionRunListeners.delete(actionRunListener);
  };

  /**
   * Stops every store trying the engine again in the background, to save
   * changes or read saved layouts, for when the provider unmounts.
   */
  dispose = (): void => {
    for (const regionStore of this.storesByRegionId.values()) regionStore.dispose();
  };

  /** Lets the stores try the engine again in the background, as when React mounts the provider once more. */
  resume = (): void => {
    for (const regionStore of this.storesByRegionId.values()) regionStore.resume();
  };

  storeFor(regionId: string): RegionStore {
    let regionStore = this.storesByRegionId.get(regionId);
    if (!regionStore) {
      regionStore = new RegionStore(regionId, this.engine, this.nextChangeSequence);
      this.storesByRegionId.set(regionId, regionStore);
    }
    return regionStore;
  }

  /** The regions one prompt bar speaks for. The same ids in the same order give the same group. */
  groupFor(regionIds: readonly string[]): RegionGroup {
    const groupKey = JSON.stringify(regionIds);
    let regionGroup = this.groupsByRegionIds.get(groupKey);
    if (!regionGroup) {
      regionGroup = new RegionGroup(
        regionIds.map((regionId) => this.storeFor(regionId)),
        this.engine,
      );
      this.groupsByRegionIds.set(groupKey, regionGroup);
    }
    return regionGroup;
  }
}

export const RegionStoreRegistryContext = createContext<RegionStoreRegistry | null>(null);

/**
 * The id an item's element carries in the page, so the region can name its
 * items to assistive technology in the order they are shown. `regionTag` is
 * the region's own `useId`, which keeps the id from matching one the host
 * application uses, or one in another region. Ids in a list of references are
 * separated by spaces, so anything but letters, digits and `-` is written as
 * its character code between two `_`.
 */
export function itemElementId(regionTag: string, itemId: string): string {
  const escapeForElementId = (idText: string) =>
    idText.replace(/[^A-Za-z0-9-]/g, (character) => `_${character.charCodeAt(0).toString(16)}_`);
  return `clickless-${escapeForElementId(regionTag)}-${escapeForElementId(itemId)}`;
}

export interface RegionContextValue {
  /** Unique to this region on the page, and the same on the server and in the browser. */
  regionTag: string;
  regionStore: RegionStore;
  /** False when the region draws nothing of its own and the page's containers place its items. */
  regionDrawsGrid: boolean;
  /** The columns the layout is kept in. */
  layoutColumns: number;
  /** The columns drawn on this screen, which may be fewer. */
  drawnColumns: number;
  /** Each item's span on this screen when it has fewer columns than the layout, else null. */
  drawnSpans: ReadonlyMap<string, number> | null;
  /** Lets items render the saved layout on the server and on first paint. */
  initialLayout: Layout | undefined;
  /** The order the saved layout gives every component it knows, on screen or off. */
  initialOrder: readonly string[];
  firstPaintOrder: FirstPaintOrder;
}

export const RegionContext = createContext<RegionContextValue | null>(null);

export function useRegionStore(regionId: string): RegionStore {
  const storeRegistry = useRegionStoreRegistryOrStandIn();
  const enclosingRegion = useContext(RegionContext);
  // Inside a provider this is the same store. Outside one, it is the store of
  // the region on screen rather than an empty one of the caller's own.
  if (enclosingRegion?.regionStore.regionId === regionId) return enclosingRegion.regionStore;
  return storeRegistry.storeFor(regionId);
}

/** For ClickLess's own prompt UI, which has nothing to show without the provider. */
export function useRegionStoreRegistry(): RegionStoreRegistry {
  const storeRegistry = useContext(RegionStoreRegistryContext);
  if (!storeRegistry) throw new Error("ClickLess components must be rendered inside <AdaptiveProvider>");
  return storeRegistry;
}

/**
 * For what wraps or runs in the application's own components. Outside a
 * provider, as in the application's tests or stories, each caller gets a
 * registry of its own with no engine: a region shows its defaults and keeps
 * changes in memory, `useAdaptiveRegion` reads the region it sits in (or an
 * empty one of its own outside any region), and an action is offered to no one.
 */
export function useRegionStoreRegistryOrStandIn(): RegionStoreRegistry {
  const storeRegistry = useContext(RegionStoreRegistryContext);
  const standInRegistry = useRef<RegionStoreRegistry | null>(null);
  useEffect(() => {
    if (!storeRegistry) warnRenderedOutsideProvider();
  }, [storeRegistry]);
  if (storeRegistry) return storeRegistry;
  standInRegistry.current ??= new RegionStoreRegistry(undefined);
  return standInRegistry.current;
}

// Once for the page, so a test file or a page full of regions says it once.
let warnedRenderedOutsideProvider = false;

function warnRenderedOutsideProvider(): void {
  if (warnedRenderedOutsideProvider) return;
  warnedRenderedOutsideProvider = true;
  console.warn(
    "ClickLess: rendered outside <AdaptiveProvider>, so regions show their defaults, nothing is saved, " +
      "and no action is offered.",
  );
}

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
