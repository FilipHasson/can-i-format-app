#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Db } from "../src/core/db.ts";
import { defaultLibrary } from "../src/core/config.ts";
import { indexLibrary } from "../src/index/library.ts";
import { readCaptureMeta } from "../src/core/metadata.ts";
import { formatStamp, sameCamera } from "../src/core/metadata.ts";
import { extOf, normPath, stemOf } from "../src/core/paths.ts";

/**
 * What a Lightroom catalog contains, what this tool makes of it, and — given a
 * file from a card — why the two do or do not meet.
 *
 * A catalog gives no file sizes, so matching leans on capture time and camera.
 * When a card comes back entirely unmatched the cause is invisible from the
 * outside: it could be the catalog, the reader, or the comparison. This walks
 * all three in order.
 *
 *   node tools/catalog-probe.ts "D:/Lightroom/Photos.lrcat"
 *   node tools/catalog-probe.ts "D:/Photos.lrcat" --card "G:/DCIM/100MSDCF/A7203841.ARW"
 */

const args = process.argv.slice(2);
const cardIndex = args.indexOf("--card");
const cardFile = cardIndex === -1 ? null : args[cardIndex + 1];
const file = args.filter((a, i) => a !== "--card" && i !== cardIndex + 1)[0];

if (!file) {
  console.error('usage: node tools/catalog-probe.ts "<path to .lrcat>" [--card "<file on the card>"]');
  process.exit(2);
}

// ---- 1. what the catalog itself holds -----------------------------------
let cat: DatabaseSync;
try {
  cat = new DatabaseSync(file, { readOnly: true });
} catch (err) {
  console.error(`Cannot open: ${err instanceof Error ? err.message : String(err)}`);
  console.error("If Lightroom is running it holds a lock — close it and try again.");
  process.exit(1);
}

const one = <T>(sql: string): T | undefined => {
  try {
    return cat.prepare(sql).get() as T | undefined;
  } catch {
    return undefined;
  }
};
const has = (table: string) =>
  one<{ ok: number }>(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='${table}'`) !==
  undefined;

console.log(`\n=== the catalog: ${file}`);
for (const table of [
  "AgLibraryFile",
  "AgLibraryFolder",
  "AgLibraryRootFolder",
  "Adobe_images",
  "AgHarvestedExifMetadata",
  "AgInternedExifCameraModel",
  "AgInternedExifCameraSN",
]) {
  const present = has(table);
  const count = present ? (one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0) : 0;
  console.log(`  ${present ? "yes" : "NO "}  ${table.padEnd(28)} ${present ? count.toLocaleString() : ""}`);
}

const sample = one<{ captureTime: string }>(
  "SELECT captureTime FROM Adobe_images WHERE captureTime IS NOT NULL AND captureTime != '' LIMIT 1",
);
if (sample) console.log(`  capture time looks like: ${JSON.stringify(sample.captureTime)}`);
const root = one<{ absolutePath: string }>("SELECT absolutePath FROM AgLibraryRootFolder LIMIT 1");
console.log(`  library root: ${root ? JSON.stringify(root.absolutePath) : "none"}`);
if (root) {
  const reachable = await fs.stat(root.absolutePath).then(() => true).catch(() => false);
  console.log(`  that root is ${reachable ? "reachable from here" : "NOT MOUNTED on this machine"}`);
}
cat.close();

// ---- 2. what the reader makes of it -------------------------------------
const home = await fs.mkdtemp(path.join(os.tmpdir(), "cif-probe-"));
process.env.CAN_I_FORMAT_HOME = home;
const db = new Db(":memory:");
const library = defaultLibrary({ path: file, key: "cat", label: "Catalog", kind: "lightroom" });

console.log(`\n=== what gets indexed`);
const stats = await indexLibrary(db, library);
const row = db.getLibrary("cat");
const entries = row ? db.countEntries(row.id) : 0;
const dated = db.getAs<{ n: number }>("SELECT COUNT(*) AS n FROM entry WHERE captured_at IS NOT NULL")?.n ?? 0;
const withCamera = db.getAs<{ n: number }>("SELECT COUNT(*) AS n FROM entry WHERE camera_key IS NOT NULL")?.n ?? 0;

console.log(`  entries stored: ${entries.toLocaleString()} (reader reported ${stats.files.toLocaleString()})`);
console.log(`  with a capture time: ${dated.toLocaleString()}`);
console.log(`  with a camera: ${withCamera.toLocaleString()}`);
if (entries > 0 && dated === 0) console.log("  ** nothing has a capture time — capture matching cannot fire");

const stored = db.getAs<{
  name: string;
  captured_at: number | null;
  camera_key: string | null;
  orig_stem: string | null;
  dir: string;
}>(
  "SELECT e.name, e.captured_at, e.camera_key, e.orig_stem, d.path AS dir FROM entry e JOIN directory d ON d.id = e.dir_id LIMIT 1",
);
if (stored) {
  console.log(`  a stored row: ${stored.dir}/${stored.name}`);
  console.log(`     captured ${formatStamp(stored.captured_at) || "(none)"}  camera ${JSON.stringify(stored.camera_key)}  orig ${JSON.stringify(stored.orig_stem)}`);
}

// ---- 3. why one card file does or does not meet it ----------------------
if (cardFile) {
  const absolute = normPath(cardFile);
  console.log(`\n=== the card file: ${absolute}`);
  const st = await fs.stat(absolute).catch(() => null);
  if (!st) {
    console.log("  cannot read it");
  } else {
    const ext = extOf(absolute);
    const stem = stemOf(path.basename(absolute));
    const { meta } = await readCaptureMeta(absolute, ext);
    console.log(`  size ${st.size.toLocaleString()}  captured ${formatStamp(meta.capturedAt) || "(none)"}  camera ${JSON.stringify(meta.cameraKey)}`);

    const libId = row?.id ?? -1;
    const byCapture =
      meta.capturedAt === null
        ? []
        : db.allAs<{ name: string; camera_key: string | null; dir: string }>(
            "SELECT e.name, e.camera_key, d.path AS dir FROM entry e JOIN directory d ON d.id = e.dir_id WHERE e.library_id = ? AND e.captured_at = ? LIMIT 5",
            libId,
            meta.capturedAt,
          );
    console.log(`\n  by capture time: ${byCapture.length} row(s)`);
    for (const c of byCapture) {
      const agrees = sameCamera(c.camera_key, meta.cameraKey);
      console.log(`     ${c.dir}/${c.name}  camera ${JSON.stringify(c.camera_key)}  ${agrees ? "camera agrees" : "** CAMERA DISAGREES"}`);
    }
    if (byCapture.length === 0 && meta.capturedAt !== null) {
      const near = db.allAs<{ captured_at: number; name: string }>(
        "SELECT captured_at, name FROM entry WHERE library_id = ? AND captured_at BETWEEN ? AND ? LIMIT 5",
        libId,
        meta.capturedAt - 100,
        meta.capturedAt + 100,
      );
      console.log(`     nothing at that exact second; nearby: ${near.map((n) => formatStamp(n.captured_at)).join(", ") || "nothing within a minute"}`);
    }

    const byStem = db.allAs<{ name: string; size: number; dir: string }>(
      "SELECT e.name, e.size, d.path AS dir FROM entry e JOIN directory d ON d.id = e.dir_id WHERE e.library_id = ? AND (e.stem = ? OR e.orig_stem = ?) LIMIT 5",
      libId,
      stem,
      stem,
    );
    console.log(`\n  by filename "${stem}": ${byStem.length} row(s)`);
    for (const c of byStem) {
      console.log(`     ${c.dir}/${c.name}  size ${c.size < 0 ? "(not recorded in the catalog)" : c.size.toLocaleString()}`);
    }

    if (byCapture.length === 0 && byStem.length === 0) {
      console.log("\n  ** this file is not in the catalog by either route.");
      console.log("     Either it was never imported, or the catalog needs saving in Lightroom.");
    }
  }
}

db.close();
await fs.rm(home, { recursive: true, force: true });
console.log();
