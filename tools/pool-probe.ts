/**
 * Measures how many things libuv will actually do at once.
 *
 * The walker and the metadata reader are bounded by libuv's thread pool, and
 * its default of four leaves most of a fast disk unused. UV_THREADPOOL_SIZE
 * raises it — but only from the environment the process was started with.
 * Setting it from inside is too late, and measurably so:
 *
 *   UV_THREADPOOL_SIZE unset          ~3 concurrent
 *   set at the top of the ESM entry   ~3 concurrent
 *   set from a --require preload      ~4 concurrent
 *   set in the environment            ~7 concurrent   (24-core machine)
 *
 * The pool is built during Node's own bootstrap, before the first line of
 * anyone's code, so an assignment in an entry point is a tuning that reads as
 * though it is happening and is not.
 *
 *   npm run probe:pool                        # what a plain run gets
 *   UV_THREADPOOL_SIZE=16 npm run probe:pool  # what it could get
 *
 * `electron/smoke.ts` reports the same number from inside the desktop app, so
 * the two can be compared.
 *
 * The estimate is CPU-bound work, so what it really measures is
 * min(pool, cores). That is enough for the question being asked: a machine
 * with more than four cores reporting four has a pool that never saw the
 * variable.
 */
import crypto from "node:crypto";
import os from "node:os";

const SALT = Buffer.alloc(16, 7);
const TARGET_MS = 120;
const JOBS = 24;

function hash(iterations: number): Promise<void> {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(SALT, SALT, iterations, 32, "sha512", (err) => (err ? reject(err) : resolve())),
  );
}

async function time(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

export interface PoolReading {
  /** How many jobs ran at once, to the nearest whole one. */
  concurrency: number;
  /** What one job took alone, as the yardstick the rest is measured against. */
  soloMs: number;
  batchMs: number;
  cores: number;
  configured: string | undefined;
}

export async function measurePool(): Promise<PoolReading> {
  // Calibrate on this machine rather than assuming an iteration count: the
  // reading is a ratio, so the yardstick has to come from the same CPU.
  const trial = await time(() => hash(100_000));
  const iterations = Math.max(20_000, Math.round((100_000 * TARGET_MS) / trial));

  // Warm: the first call through pbkdf2 pays for lazy initialisation that
  // would otherwise be counted as if it were the work.
  await hash(iterations);

  const soloMs = await time(() => hash(iterations));
  const batchMs = await time(() =>
    Promise.all(Array.from({ length: JOBS }, () => hash(iterations))),
  );

  return {
    concurrency: Math.round((JOBS * soloMs) / batchMs),
    soloMs,
    batchMs,
    cores: os.availableParallelism(),
    configured: process.env.UV_THREADPOOL_SIZE,
  };
}

export function describePool(reading: PoolReading): string {
  const { concurrency, cores, configured } = reading;

  // Below this and the pool is the default of four, allowing for a reading
  // that lands a little under. Above it, something raised it.
  const atDefault = concurrency <= 5;

  const verdict =
    cores <= 5
      ? "too few cores here for a CPU-bound probe to tell one pool size from another"
      : !configured
        ? "libuv's default — export UV_THREADPOOL_SIZE before launching to raise it"
        : atDefault
          ? `still the default — ${configured} was asked for from inside the process, which is too late`
          : "raised; the probe is CPU-bound, so treat the number as a floor";

  return (
    `pool: ~${concurrency} concurrent  (asked for ${configured ?? "nothing"}, ` +
    `${cores} cores) — ${verdict}`
  );
}

// Only when run as a script; `smoke.ts` imports the measurement instead.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  // Deliberately not setting the variable here. What a plain run gets is the
  // question, and assigning it would answer a different one — badly, since
  // assigning it does nothing at all.
  const reading = await measurePool();
  console.log(describePool(reading));
  console.log(
    `  one job ${reading.soloMs.toFixed(0)}ms, ${JOBS} together ${reading.batchMs.toFixed(0)}ms`,
  );
}
