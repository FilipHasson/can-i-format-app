import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, type AppConfig } from "../src/core/config.ts";
import { indexLibrary } from "../src/index/library.ts";
import { scanCard } from "../src/scan/card.ts";
import { deleteAllScans, deleteScan, getScanFiles, listScans } from "../src/scan/query.ts";
import { makeFixtures, type FixturePaths } from "../tools/make-fixtures.ts";

/**
 * Deleting a scan deletes a report.
 *
 * The one thing this must never do is take anything else with it — not the
 * card, not the library index that took minutes to build, and not the other
 * scans. The card and library files are checked afterwards for the same
 * reason the tool exists at all.
 */

let tmp: string;
let paths: FixturePaths;
let db: Db;
let config: AppConfig;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-delete-"));
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
});

after(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const countRows = (table: string, where = "") =>
  db.getAs<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`)?.n ?? -1;

async function countFiles(root: string): Promise<number> {
  return (await fs.readdir(root, { recursive: true })).length;
}

describe("deleting one scan", () => {
  test("removes it and its files, and leaves the others alone", async () => {
    const first = await scanCard(db, config, paths.card, { label: "first" });
    const second = await scanCard(db, config, paths.card, { label: "second" });

    const firstFiles = getScanFiles(db, first.scanId, {}).total;
    assert.ok(firstFiles > 0);

    deleteScan(db, first.scanId);

    assert.equal(countRows("scan_file", `WHERE scan_id = ${first.scanId}`), 0, "rows should cascade");
    assert.equal(getScanFiles(db, second.scanId, {}).total, firstFiles, "the other scan is intact");
    assert.deepEqual(
      listScans(db, 25).map((s) => s.id),
      [second.scanId],
    );
  });

  test("and leaves the library index alone", async () => {
    const main = db.getLibrary("main");
    assert.ok(main);
    const before = db.countEntries(main.id);

    const scan = await scanCard(db, config, paths.card, { label: "third" });
    deleteScan(db, scan.scanId);

    assert.equal(db.countEntries(main.id), before, "indexing must not have to be redone");
  });

  test("deleting one that is already gone is not an error", () => {
    deleteScan(db, 999_999);
    assert.ok(true);
  });
});

describe("clearing the history", () => {
  test("removes every scan and reports how many", async () => {
    await scanCard(db, config, paths.card, { label: "a" });
    await scanCard(db, config, paths.card, { label: "b" });
    const before = listScans(db, 100).length;
    assert.ok(before >= 2);

    assert.equal(deleteAllScans(db), before);
    assert.deepEqual(listScans(db, 100), []);
    assert.equal(countRows("scan_file"), 0);
  });

  test("clearing an empty history is a no-op", () => {
    assert.equal(deleteAllScans(db), 0);
  });

  test("the libraries are still indexed afterwards", () => {
    for (const key of ["main", "backup"]) {
      const row = db.getLibrary(key);
      assert.ok(row);
      assert.ok(db.countEntries(row.id) > 0, `${key} should still be indexed`);
    }
  });
});

describe("nothing on disk is touched", () => {
  test("the card and both libraries still hold every file", async () => {
    // The promise the whole tool rests on. A delete that reached the media
    // would be the worst possible bug in it.
    const counts = await Promise.all([paths.card, paths.main, paths.backup].map(countFiles));
    await scanCard(db, config, paths.card, { label: "final" });
    deleteAllScans(db);

    assert.deepEqual(
      await Promise.all([paths.card, paths.main, paths.backup].map(countFiles)),
      counts,
    );
  });
});
