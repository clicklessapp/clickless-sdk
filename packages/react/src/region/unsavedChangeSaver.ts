import { EngineError, isWorthRetrying } from "../engine/engineClient";
import type { LayoutResponse } from "../engine/engineResponses";
import { Retrier } from "./retrier";
import type { UnsavedChange } from "./unsavedChanges";

/** What the saver needs from the region whose changes it saves. */
export interface UnsavedChangeSaverHost {
  /** The oldest change the engine may still take. */
  nextChangeToSave(): UnsavedChange | undefined;
  /** Runs before the first change is sent, so each is sent against the layout the engine has. */
  prepareToSave(): Promise<void>;
  sendChange(change: UnsavedChange): Promise<LayoutResponse>;
  /** Fetches the engine's copy, after it said the layout changed elsewhere. */
  reloadSavedLayout(): Promise<void>;
  changeSaved(change: UnsavedChange, layoutResponse: LayoutResponse): void;
  /** Asks for a turn to write, in which `save` runs. */
  queueSaving(): void;
}

/**
 * Saves a region's unsaved changes behind the scenes. What the engine could
 * not take is tried again later, sooner if the device comes back online.
 */
export class UnsavedChangeSaver {
  private savingChange: UnsavedChange | null = null;
  private lastSaveFailure: unknown = null;
  private readonly retrier: Retrier;

  constructor(private readonly host: UnsavedChangeSaverHost) {
    this.retrier = new Retrier(() => host.queueSaving());
  }

  /** The change on its way to the engine right now, if any. */
  get changeBeingSaved(): UnsavedChange | null {
    return this.savingChange;
  }

  get isWaitingToRetry(): boolean {
    return this.retrier.isWaiting;
  }

  /** Why the last attempt to save stopped short, or null when everything it tried was saved. */
  get lastFailure(): unknown {
    return this.lastSaveFailure;
  }

  /**
   * Sends the changes the engine may still take, oldest first. Never rejects:
   * what could not be saved is tried again later.
   */
  async save(): Promise<void> {
    this.retrier.cancel();
    this.lastSaveFailure = null;
    try {
      await this.host.prepareToSave();
      let conflictSeen = false;
      for (let change = this.host.nextChangeToSave(); change; change = this.host.nextChangeToSave()) {
        let layoutResponse: LayoutResponse;
        this.savingChange = change;
        try {
          layoutResponse = await this.host.sendChange(change);
        } catch (error) {
          if (error instanceof EngineError && error.code === "conflict" && !conflictSeen) {
            // Changed elsewhere: carried over to that layout and tried once more.
            conflictSeen = true;
            await this.host.reloadSavedLayout();
            continue;
          }
          if (isWorthRetrying(error)) throw error;
          // The engine will never take it. It stays on the screen for this visit.
          change.saveable = false;
          continue;
        } finally {
          this.savingChange = null;
        }
        this.host.changeSaved(change, layoutResponse);
        // Each change may be carried over to a layout changed elsewhere once.
        conflictSeen = false;
      }
      this.retrier.succeeded();
    } catch (error) {
      this.lastSaveFailure = error;
      this.scheduleRetry();
    }
  }

  /** Tries again later, unless already waiting to, stopped, or there is nothing to save. */
  scheduleRetry(): void {
    if (this.host.nextChangeToSave()) this.retrier.schedule();
  }

  /** Tries again at once, if it was waiting to. */
  retryNow(): void {
    this.retrier.retryNow();
  }

  /** Nothing is left to save, so nothing needs trying again. */
  cancelRetry(): void {
    this.retrier.cancel();
  }

  /** Tries nothing more until `start`, even after a save already under way fails. */
  stop(): void {
    this.retrier.stop();
  }

  start(): void {
    this.retrier.start();
    this.scheduleRetry();
  }
}
