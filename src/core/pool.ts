/**
 * Bounded-concurrency map. Everything expensive here is I/O bound (opening
 * files to read headers, reading 128 KiB for a hash), so async concurrency
 * beats worker threads and keeps the code far simpler.
 */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Sensible default for spinning disks vs SSDs vs a card reader on USB. */
export const IO_CONCURRENCY = 12;

/** Fires `fn` at most once per `ms`, plus a guaranteed final call. */
export function throttle<A extends unknown[]>(
  ms: number,
  fn: (...args: A) => void,
): { call: (...args: A) => void; flush: () => void } {
  let last = 0;
  let pending: A | null = null;

  return {
    call(...args: A) {
      const now = performance.now();
      if (now - last >= ms) {
        last = now;
        pending = null;
        fn(...args);
      } else {
        pending = args;
      }
    },
    flush() {
      if (pending) {
        fn(...pending);
        pending = null;
      }
    },
  };
}
