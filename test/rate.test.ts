import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RateMeter, describeRate, formatBytes, formatEta } from "../src/core/rate.ts";

/**
 * The estimate is the part a user acts on — it decides whether they wait or go
 * and do something else — so what matters is that it tracks the current speed
 * and says nothing at all when it does not know.
 */

describe("time remaining", () => {
  test("says nothing until it has seen enough to say something", () => {
    const meter = new RateMeter();
    meter.record(0, 0, 1000);
    meter.record(10, 1000, 1500);
    const rate = meter.rate(100, 10_000);
    assert.equal(rate.etaMs, null);
    assert.equal(rate.itemsPerSecond, null);
  });

  test("estimates from bytes when both sides are known", () => {
    const meter = new RateMeter();
    // 1 MB/s, steady, with a quarter of the work done.
    for (let i = 0; i <= 4; i++) meter.record(i * 25, i * 1_000_000, 1000 + i * 1000);
    const rate = meter.rate(400, 8_000_000);
    assert.ok(rate.bytesPerSecond);
    assert.equal(Math.round(rate.bytesPerSecond), 1_000_000);
    // 4 MB left at 1 MB/s.
    assert.equal(Math.round((rate.etaMs ?? 0) / 1000), 4);
  });

  test("falls back to counting files when nothing reports bytes", () => {
    const meter = new RateMeter();
    for (let i = 0; i <= 4; i++) meter.record(i * 50, 0, 1000 + i * 1000);
    const rate = meter.rate(1000, 0);
    assert.equal(rate.bytesPerSecond, null);
    assert.equal(rate.itemsPerSecond, 50);
    // 800 files left at 50/s.
    assert.equal(Math.round((rate.etaMs ?? 0) / 1000), 16);
  });

  test("tracks the current speed rather than the average since the start", () => {
    const meter = new RateMeter();
    // Twenty seconds of crawling, then it speeds up tenfold.
    for (let i = 0; i <= 20; i++) meter.record(i * 10, i * 100_000, 1000 + i * 1000);
    let at = 21_000;
    let done = 200;
    let bytes = 2_000_000;
    for (let i = 0; i < 10; i++) {
      done += 100;
      bytes += 1_000_000;
      meter.record(done, bytes, (at += 1000));
    }
    const rate = meter.rate(10_000, 100_000_000);
    assert.ok(rate.bytesPerSecond);
    // The window has aged the slow stretch out entirely. Averaging over the
    // whole run instead would report about 390 KB/s and predict a wait more
    // than twice as long as the real one.
    assert.equal(Math.round(rate.bytesPerSecond), 1_000_000);
  });

  test("a counter that goes backwards starts a new measurement", () => {
    const meter = new RateMeter();
    for (let i = 0; i <= 4; i++) meter.record(i * 50, i * 1_000_000, 1000 + i * 1000);
    // A new phase reusing the meter, restarting its counts.
    meter.record(0, 0, 6000);
    assert.equal(meter.rate(1000, 0).itemsPerSecond, null, "stale samples should be gone");
  });
});

describe("how it reads", () => {
  test("rounds the estimate to something that stays true for a while", () => {
    assert.equal(formatEta(4000), "a few seconds left");
    assert.equal(formatEta(42_000), "about 50 seconds left");
    assert.equal(formatEta(90_000), "about 2 minutes left");
    assert.equal(formatEta(60_000), "about 1 minute left");
    assert.equal(formatEta(3_600_000), "about 1 hour left");
    assert.equal(formatEta(9_000_000), "about 2h 30m left");
  });

  test("sizes are readable at every scale", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(4 * 1024 ** 3), "4.0 GB");
  });

  test("the whole line says how fast, how far, and how much longer", () => {
    const meter = new RateMeter();
    for (let i = 0; i <= 4; i++) meter.record(i * 25, i * 10 * 1024 ** 2, 1000 + i * 1000);
    const rate = meter.rate(400, 400 * 1024 ** 2);
    const line = describeRate(rate, 40 * 1024 ** 2, 400 * 1024 ** 2, "bytes");
    assert.equal(line, "10.0 MB/s · 40.0 MB of 400 MB · about 40 seconds left");
  });

  test("a data rate is only quoted where every counted byte is really read", () => {
    const meter = new RateMeter();
    for (let i = 0; i <= 4; i++) meter.record(i * 25, i * 10 * 1024 ** 2, 1000 + i * 1000);
    const rate = meter.rate(400, 400 * 1024 ** 2);

    // Reading capture times opens a raw and reads its header, so quoting the
    // file sizes as MB/s would claim throughput the disk never did. The volume
    // covered is still shown, because that part is true.
    const covered = describeRate(rate, 40 * 1024 ** 2, 400 * 1024 ** 2, "files");
    assert.equal(covered, "25 files/s · 40.0 MB of 400 MB · about 40 seconds left");
    assert.ok(!covered.includes("MB/s"));
  });

  test("and shrinks to whatever it actually knows", () => {
    assert.equal(
      describeRate({ itemsPerSecond: null, bytesPerSecond: null, etaMs: null }, 0, 0),
      "",
    );
    assert.equal(
      describeRate({ itemsPerSecond: 1200, bytesPerSecond: null, etaMs: null }, 0, 0),
      "1,200 files/s",
    );
  });
});
