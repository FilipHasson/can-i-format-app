import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PhaseTracker } from "../src/core/phases.ts";
import { JobManager, type Job, type JobEvent } from "../src/server/jobs.ts";
import { Db } from "../src/core/db.ts";
import { defaultLibrary } from "../src/core/config.ts";
import { indexLibrary } from "../src/index/library.ts";
import type { IndexProgress } from "../src/index/types.ts";
import { writeCatalog, type CatalogFile } from "../tools/make-catalog.ts";

/**
 * One bar for one action. A scan's steps each count from zero, and drawing
 * those counts directly showed four bars in a row for one click.
 */

const PHASES = [
  { key: "a", label: "First" },
  { key: "b", label: "Second" },
  { key: "c", label: "Third" },
];

describe("a phased bar", () => {
  test("fills each phase's own segment", () => {
    const bar = new PhaseTracker(PHASES);
    const state = bar.update({ phase: "a", done: 5, total: 10 });
    assert.equal(state.current, 0);
    assert.equal(state.fraction, 0.5);
    assert.equal(state.overall, 0.5 / 3);
  });

  test("moving on starts the next segment, and the last stays full", () => {
    const bar = new PhaseTracker(PHASES);
    bar.update({ phase: "a", done: 10, total: 10 });
    const state = bar.update({ phase: "b", done: 1, total: 4 });
    assert.equal(state.current, 1);
    assert.equal(state.fraction, 0.25);
    assert.equal(state.overall, (1 + 0.25) / 3);
  });

  test("never goes backwards when a step counts afresh", () => {
    // The matcher's capture pass and lookup both count the card from zero.
    const bar = new PhaseTracker(PHASES);
    bar.update({ phase: "a", done: 9, total: 10 });
    assert.equal(bar.update({ phase: "a", done: 1, total: 10 }).fraction, 0.9);
  });

  test("never goes back to a phase it has left", () => {
    const bar = new PhaseTracker(PHASES);
    bar.update({ phase: "b", done: 3, total: 4 });
    const state = bar.update({ phase: "a", done: 1, total: 100 });
    assert.equal(state.current, 1);
    assert.equal(state.fraction, 0.75);
  });

  test("a phase passed over is skipped, not done", () => {
    const bar = new PhaseTracker(PHASES);
    bar.update({ phase: "a", done: 1, total: 1 });
    assert.deepEqual(bar.update({ phase: "c", done: 0, total: 5 }).skipped, ["b"]);
  });

  test("finishing early skips what was still ahead", () => {
    const bar = new PhaseTracker(PHASES);
    bar.update({ phase: "a", done: 1, total: 1 });
    const state = bar.finish();
    assert.deepEqual(state.skipped, ["b", "c"]);
    assert.equal(state.overall, 1);
  });

  test("a step with no total leaves the segment indeterminate", () => {
    assert.equal(new PhaseTracker(PHASES).update({ phase: "a", done: 312, total: 0 }).fraction, null);
  });

  test("a phase made of phases states its own fraction", () => {
    const bar = new PhaseTracker(PHASES);
    assert.equal(bar.update({ phase: "c", within: 0.4, done: 1, total: 1 }).fraction, 0.4);
  });
});

describe("a job that declares its phases", () => {
  function run(steps: (report: (p: object) => void) => void): Promise<Job[]> {
    const jobs = new JobManager();
    const seen: Job[] = [];
    jobs.on("job", (event: JobEvent) => seen.push(event.job));
    return new Promise((resolve) => {
      jobs.on("job", (event: JobEvent) => {
        if (event.job.status !== "running") resolve(seen);
      });
      jobs.start(
        "scan",
        "Scanning",
        async (report) => {
          steps(report);
        },
        PHASES,
      );
    });
  }

  test("reports where the action as a whole has got to", async () => {
    const seen = await run((report) => {
      report({ phase: "a", done: 10, total: 10 });
      report({ phase: "b", done: 0, total: 50 });
      report({ phase: "b", done: 25, total: 50 });
    });
    const mid = seen.at(-2)!.progress.phases!;
    assert.equal(mid.current, 1);
    assert.equal(mid.fraction, 0.5);
  });

  test("never moves the bar back, however the counts restart", async () => {
    const seen = await run((report) => {
      report({ phase: "a", done: 1, total: 4 });
      report({ phase: "b", done: 40, total: 50 });
      report({ phase: "b", done: 1, total: 900 });
      report({ phase: "a", done: 0, total: 3 });
    });
    const overall = seen.filter((j) => j.status === "running").map((j) => j.progress.phases!.overall);
    for (let i = 1; i < overall.length; i++) assert.ok(overall[i]! >= overall[i - 1]!, `${overall}`);
  });

  test("a step whose counts are not the phase's own does not fill it", async () => {
    const seen = await run((report) => {
      report({ phase: "c", counts: false, done: 9, total: 10 });
    });
    assert.equal(seen.at(-2)!.progress.phases!.fraction, null);
  });

  test("finishing marks the phases it never needed", async () => {
    const seen = await run((report) => report({ phase: "a", done: 1, total: 1 }));
    const last = seen.at(-1)!;
    assert.equal(last.status, "done");
    assert.deepEqual(last.progress.phases!.skipped, ["b", "c"]);
  });
});

describe("re-indexing a catalog", () => {
  let tmp: string;
  let reports: IndexProgress[];

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-progress-"));
    const catalog = path.join(tmp, "Big.lrcat");
    // More than one batch, so the loop has somewhere to report from.
    const files: CatalogFile[] = Array.from({ length: 4500 }, (_, i) => ({
      pathFromRoot: `2024/${String(i % 30).padStart(2, "0")}/`,
      baseName: `IMG_${String(i).padStart(5, "0")}`,
      extension: "CR3",
      captureTime: "2024-05-01T09:10:00",
    }));
    writeCatalog(catalog, { rootPath: path.join(tmp, "Pictures").split(path.sep).join("/"), files });

    const db = new Db(":memory:");
    reports = [];
    await indexLibrary(db, defaultLibrary({ path: catalog, key: "big", label: "Big", kind: "lightroom" }), {
      onProgress: (p) => reports.push({ ...p }),
    });
    db.close();
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("says it is copying the catalog, rather than sitting on Starting", () => {
    assert.equal(reports[0]?.phase, "copying-catalog");
  });

  test("reads toward a known total, so the bar can fill", () => {
    const reading = reports.filter((p) => p.phase === "reading-catalog");
    assert.ok(reading.length >= 2);
    for (const p of reading) assert.equal(p.total, 4500);
    assert.equal(reading.at(-1)?.done, 4500);
  });
});
