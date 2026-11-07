// How long to wait before trying the engine again: doubling each time, up to the longest.
const FIRST_RETRY_DELAY_MS = 5_000;
const LONGEST_RETRY_DELAY_MS = 120_000;

/**
 * Tries something again later, less often each time it fails, and at once
 * when the device comes back online. Stopped, as when the provider holding it
 * has gone, it schedules nothing until started again.
 */
export class Retrier {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryDelayMs = FIRST_RETRY_DELAY_MS;
  private stopped = false;

  constructor(private readonly attemptAgain: () => void) {}

  get isWaiting(): boolean {
    return this.retryTimer !== null;
  }

  /** Tries again later, unless already waiting to or stopped. */
  schedule(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(this.retryNow, this.nextRetryDelayMs);
    this.nextRetryDelayMs = Math.min(this.nextRetryDelayMs * 2, LONGEST_RETRY_DELAY_MS);
    if (typeof window !== "undefined") window.addEventListener("online", this.retryNow);
  }

  /** Tries again at once, if it was waiting to. */
  retryNow = (): void => {
    if (!this.isWaiting) return;
    this.cancel();
    this.attemptAgain();
  };

  /** What it was waiting to try worked, so the next failure waits the shortest time again. */
  succeeded(): void {
    this.cancel();
    this.nextRetryDelayMs = FIRST_RETRY_DELAY_MS;
  }

  cancel(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (typeof window !== "undefined") window.removeEventListener("online", this.retryNow);
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  start(): void {
    this.stopped = false;
  }
}
