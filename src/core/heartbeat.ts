/**
 * Keeps a long run of synchronous work from freezing the progress bar.
 *
 * The matcher's indexed passes never open a file, so nothing in them awaits —
 * and a loop that never awaits never lets Node flush a socket. Progress was
 * being reported faithfully into a buffer the browser would not see until the
 * loop ended, so the banner sat on the last message from the previous phase for
 * several seconds and then jumped straight to finished.
 *
 * Yielding on a timer fixes that for about a microsecond per beat. The timer is
 * the point: yielding on every iteration would cost more than the work, and
 * yielding on a fixed count adapts badly when each iteration's cost varies with
 * how crowded a library is.
 */
export class Heartbeat {
  #last: number;
  #interval: number;

  constructor(intervalMs = 100) {
    this.#interval = intervalMs;
    this.#last = performance.now();
  }

  /**
   * Reports and lets the event loop turn, but only once enough time has passed
   * for it to be worth doing. Returns whether it did.
   */
  async beat(report: () => void): Promise<boolean> {
    if (performance.now() - this.#last < this.#interval) return false;
    this.#last = performance.now();
    report();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return true;
  }
}

/**
 * Lets a message just reported reach the browser before a stretch of
 * synchronous work that would otherwise hold it back until the work is over.
 */
export function letProgressOut(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
