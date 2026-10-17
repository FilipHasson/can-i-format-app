/**
 * Throughput and time-remaining for a long job.
 *
 * Rates are taken over a sliding window rather than the whole run, because the
 * work is not uniform: a folder of 40MB raw frames and a folder of phone JPEGs
 * move at completely different speeds, and an average over everything so far
 * would keep predicting the past. A window of a few seconds tracks what the job
 * is doing *now*, which is what an estimate has to be built on.
 */

const WINDOW_MS = 8000;
/** Below this, the window has not seen enough to say anything useful. */
const MIN_SAMPLES = 3;

interface Sample {
  at: number;
  done: number;
  bytes: number;
}

export interface Rate {
  /** Units of work per second, or null while the window is still filling. */
  itemsPerSecond: number | null;
  /** Bytes per second, or null when the caller does not track bytes. */
  bytesPerSecond: number | null;
  /** Milliseconds remaining, or null when it cannot honestly be estimated. */
  etaMs: number | null;
}

export class RateMeter {
  #samples: Sample[] = [];

  /** Starts over — call when the job moves to work of a different shape. */
  reset(): void {
    this.#samples = [];
  }

  /** Records cumulative progress. `bytes` may stay 0 if nothing tracks it. */
  record(done: number, bytes: number, now: number): void {
    const last = this.#samples[this.#samples.length - 1];
    // A counter that went backwards means a new phase reusing the meter.
    if (last && (done < last.done || bytes < last.bytes)) this.#samples = [];

    this.#samples.push({ at: now, done, bytes });

    const cutoff = now - WINDOW_MS;
    // Keep one sample from before the cutoff so the window still has a span.
    let drop = 0;
    while (drop + 1 < this.#samples.length && (this.#samples[drop + 1] as Sample).at < cutoff) {
      drop++;
    }
    if (drop > 0) this.#samples = this.#samples.slice(drop);
  }

  rate(total: number, totalBytes: number): Rate {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    const none: Rate = { itemsPerSecond: null, bytesPerSecond: null, etaMs: null };
    if (!first || !last || this.#samples.length < MIN_SAMPLES) return none;

    const seconds = (last.at - first.at) / 1000;
    if (seconds <= 0) return none;

    const itemsPerSecond = (last.done - first.done) / seconds;
    const bytesMoved = last.bytes - first.bytes;
    const bytesPerSecond = bytesMoved > 0 ? bytesMoved / seconds : null;

    // Prefer bytes for the estimate where both are known: file sizes vary far
    // more than file counts do, so remaining bytes is the better predictor.
    let etaMs: number | null = null;
    if (bytesPerSecond !== null && totalBytes > last.bytes) {
      etaMs = ((totalBytes - last.bytes) / bytesPerSecond) * 1000;
    } else if (itemsPerSecond > 0 && total > last.done) {
      etaMs = ((total - last.done) / itemsPerSecond) * 1000;
    }

    return { itemsPerSecond: itemsPerSecond > 0 ? itemsPerSecond : null, bytesPerSecond, etaMs };
  }
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(n);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * Deliberately coarse. A countdown to the second on a job whose speed swings
 * with file size reads as precision the number does not have, so it is rounded
 * to something that stays true for a while.
 */
export function formatEta(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `about ${Math.ceil(seconds / 10) * 10} seconds left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `about ${hours} hour${hours === 1 ? "" : "s"} left`;
  return `about ${hours}h ${rest}m left`;
}

/**
 * Which figure the headline rate is quoted in.
 *
 * `bytes` is only correct where the job reads every byte it counts — hashing
 * does. Reading capture times does not: it opens a 40MB raw and reads the
 * header, so quoting its file sizes as a data rate would claim throughput
 * several times what the disk is actually doing. Those jobs quote files per
 * second instead, and the byte figures stay where they are honest — as a
 * measure of how much of the library has been got through.
 */
export type RateUnit = "bytes" | "files";

/** The line under the progress bar: how fast, how far, how much longer. */
export function describeRate(
  rate: Rate,
  bytes: number,
  totalBytes: number,
  unit: RateUnit = "files",
): string {
  const parts: string[] = [];

  if (unit === "bytes" && rate.bytesPerSecond !== null) {
    parts.push(`${formatBytes(rate.bytesPerSecond)}/s`);
  } else if (rate.itemsPerSecond !== null) {
    parts.push(`${Math.round(rate.itemsPerSecond).toLocaleString()} files/s`);
  }

  if (totalBytes > 0) parts.push(`${formatBytes(bytes)} of ${formatBytes(totalBytes)}`);
  if (rate.etaMs !== null) parts.push(formatEta(rate.etaMs));

  return parts.join(" · ");
}
