import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, type AppConfig } from "../src/core/config.ts";
import { indexLibrary } from "../src/index/library.ts";
import { scanCard, type ScanResult } from "../src/scan/card.ts";
import { getScanFiles } from "../src/scan/query.ts";
import { atLeast } from "../src/core/tiers.ts";
import { makeFixtures, EXPECTED, type FixturePaths } from "../tools/make-fixtures.ts";

/**
 * End-to-end: build a card and two libraries on disk, index them, scan, and
 * check the verdict. This is the test that matters — the individual pieces can
 * all be correct while the pipeline still reaches the wrong conclusion.
 */

let tmp: string;
let paths: FixturePaths;
let db: Db;
let config: AppConfig;
let result: ScanResult;
/** Snapshot taken after indexing but before any scan, so the scan's own
 *  metadata reads don't mask what indexing did or didn't do. */
let filesReadDuringIndex: number;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-test-"));
  paths = await makeFixtures(path.join(tmp, "fixtures"));

  db = new Db(":memory:");
  config = {
    ...defaultConfig(),
    setupComplete: true,
    rule: "main and backup",
    libraries: [
      defaultLibrary({ path: paths.main, key: "main", label: "Main" }),
      defaultLibrary({ path: paths.backup, key: "backup", label: "Backup" }),
    ],
  };

  for (const lib of config.libraries) await indexLibrary(db, lib);
  filesReadDuringIndex =
    db.getAs<{ n: number }>("SELECT COUNT(*) AS n FROM entry WHERE meta_state != 'pending'")?.n ?? -1;

  result = await scanCard(db, config, paths.card);
});

after(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("indexing", () => {
  test("indexes only media, skipping sidecars and junk", () => {
    const main = db.getLibrary("main");
    assert.ok(main);
    // Six shoot-A frames plus two DNGs converted from shoot B.
    assert.equal(db.countEntries(main.id), 8);
  });

  test("opens no files during a folder index", () => {
    // Indexing is readdir plus lstat and nothing else. This is what keeps the
    // first index of a million-file library bounded by syscalls rather than by
    // reading image headers.
    assert.equal(filesReadDuringIndex, 0);
  });

  test("a second index run is incremental", async () => {
    const stats = await indexLibrary(db, config.libraries[0]!);
    assert.ok(stats.skippedDirectories > 0, "expected unchanged directories to be skipped");
    assert.equal(stats.added, 0);
    assert.equal(stats.removed, 0);
  });
});

describe("card verdict", () => {
  test("the card is not safe to format", () => {
    assert.equal(result.verdict.status, "unsafe");
  });

  test("counts required files, excluding the sidecar", () => {
    assert.equal(result.verdict.requiredFiles, 10);
    assert.equal(result.verdict.totalFiles, 11); // 10 frames + one .THM
  });

  test("six frames are in both libraries, four are not", () => {
    assert.equal(result.verdict.satisfied, 6);
    assert.equal(result.verdict.blocked, 4);
  });

  test("says precisely what is missing, per requirement", () => {
    assert.deepEqual(result.verdict.gaps, [
      { requirement: "backup", count: 2 },
      { requirement: "main and backup", count: 2 },
    ]);
  });
});

describe("which files are blocked", () => {
  const blockedPaths = () => {
    const { files } = getScanFiles(db, result.scanId, { onlyBlocked: true });
    return files.map((f) => `${f.relDir}/${f.name}`).sort();
  };

  test("blocks exactly the frames that are genuinely missing", () => {
    assert.deepEqual(
      blockedPaths(),
      [...EXPECTED.missingFromBackup, ...EXPECTED.missingEverywhere].sort(),
    );
  });

  test("frames present in both libraries are cleared", () => {
    const blocked = new Set(blockedPaths());
    for (const p of EXPECTED.satisfied) {
      assert.equal(blocked.has(p), false, `${p} should have been cleared`);
    }
  });
});

describe("the cases that defeat naive matching", () => {
  const fileAt = (relDir: string, name: string) => {
    const { files } = getScanFiles(db, result.scanId, { dir: relDir });
    const found = files.find((f) => f.name === name);
    assert.ok(found, `${relDir}/${name} missing from scan results`);
    return found;
  };

  test("a repeated camera filename does not borrow another shoot's backup", () => {
    // IMG_0003 exists in both shoots. Shoot A's copy is in `main`; shoot B's is
    // not. Trusting the filename would wrongly clear this file — and the card
    // holding the only copy would get formatted.
    const shootB = fileAt("DCIM/101EOSR5", "IMG_0003.JPG");
    assert.equal(shootB.satisfied, false);
    assert.equal(shootB.gap, "main and backup");

    const shootA = fileAt("DCIM/100EOSR5", "IMG_0003.JPG");
    assert.equal(shootA.satisfied, true);
  });

  test("a file renamed and converted to DNG on import is still found", () => {
    // On the card: IMG_0001.JPG. In the library: 20240615_0001.dng. Different
    // name, different extension, different size — only capture time and camera
    // connect them.
    const frame = fileAt("DCIM/101EOSR5", "IMG_0001.JPG");
    assert.equal(frame.satisfied, true);
    assert.equal(frame.matches.main?.tier, "strong");
    assert.match(frame.matches.main?.path ?? "", /20240615_0001\.dng$/);
  });

  test("a byte-identical import matches on name and size alone", () => {
    // Settled in pass one, from indexed columns only — no file was opened to
    // reach this conclusion.
    const frame = fileAt("DCIM/100EOSR5", "IMG_0001.JPG");
    assert.equal(frame.matches.main?.tier, "probable");
    assert.equal(frame.matches.backup?.tier, "probable");
  });

  test("a file in one library only reports that library as the gap", () => {
    const frame = fileAt("DCIM/100EOSR5", "IMG_0005.JPG");
    assert.equal(frame.satisfied, false);
    assert.equal(frame.gap, "backup");
    assert.ok(atLeast(frame.matches.main?.tier ?? "none", "probable"));
    assert.equal(frame.matches.backup?.tier, "none");
  });
});

describe("work actually avoided", () => {
  test("no candidate lists were truncated", () => {
    assert.equal(result.stats.truncated, 0);
  });

  test("escalates only the library that targeted enrichment could not resolve", () => {
    // `backup` never needs a full read: every card filename has a same-named
    // candidate there, so pass two already covered it. Only `main`, where the
    // counterparts were renamed beyond recognition, forces the wider sweep.
    assert.deepEqual(result.stats.escalatedLibraries, ["main"]);
  });

  test("the metadata cost is paid once — a rescan reads nothing", async () => {
    const second = await scanCard(db, config, paths.card);

    assert.equal(second.stats.metadataReads, 0, "cached metadata should make a rescan free");
    assert.deepEqual(second.stats.escalatedLibraries, []);
    // And the conclusion is unchanged, which is the point of caching it.
    assert.equal(second.verdict.blocked, result.verdict.blocked);
    assert.equal(second.verdict.satisfied, result.verdict.satisfied);
  });
});
