import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Heartbeat } from "../src/core/heartbeat.ts";

/**
 * The progress bar froze for five and a half seconds on a real card, showing a
 * message from a phase that had already finished, then jumped to done.
 *
 * The cause was not missing progress reports — they were all being made. It was
 * that the passes making them never awaited anything, so Node never got to
 * flush the socket carrying them. What has to hold is that the event loop
 * actually turns, which is what these check.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("beating", () => {
  test("says nothing until the interval has passed", async () => {
    const heartbeat = new Heartbeat(50);
    let reports = 0;

    for (let i = 0; i < 100; i++) await heartbeat.beat(() => reports++);
    assert.equal(reports, 0, "a tight loop should not report a hundred times");
  });

  test("reports once it has", async () => {
    const heartbeat = new Heartbeat(20);
    let reports = 0;

    await heartbeat.beat(() => reports++);
    await sleep(30);
    assert.equal(await heartbeat.beat(() => reports++), true);
    assert.equal(reports, 1);
  });

  test("and then waits again before the next one", async () => {
    const heartbeat = new Heartbeat(20);
    await sleep(30);
    await heartbeat.beat(() => {});

    let reports = 0;
    for (let i = 0; i < 50; i++) await heartbeat.beat(() => reports++);
    assert.equal(reports, 0);
  });
});

describe("letting the event loop turn", () => {
  test("work waiting on the loop actually runs", async () => {
    // The whole point. Anything scheduled before the loop — flushing a socket,
    // in the case this exists for — has to get its turn during it, not after.
    const heartbeat = new Heartbeat(10);
    let ranDuringTheLoop = false;
    setImmediate(() => {
      ranDuringTheLoop = true;
    });

    let beats = 0;
    const started = performance.now();
    while (performance.now() - started < 60) {
      if (await heartbeat.beat(() => {})) beats++;
    }

    assert.ok(beats > 0, "expected the loop to beat at least once");
    assert.ok(ranDuringTheLoop, "a pending callback should have run before the loop ended");
  });

  test("a loop that never beats starves it, which is the bug", async () => {
    // The same shape without the yield, to show the difference is real and not
    // something Node does on its own.
    let ranDuringTheLoop = false;
    setImmediate(() => {
      ranDuringTheLoop = true;
    });

    const started = performance.now();
    while (performance.now() - started < 60) {
      // Busy work with no await in it, exactly as the indexed passes were.
    }

    assert.equal(ranDuringTheLoop, false, "nothing else gets a turn, however much progress is reported");
  });
});
