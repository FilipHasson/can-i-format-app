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
import { readThumbnail } from "../src/core/thumbnail.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";

/**
 * A card of footage.
 *
 * Sony fills M4ROOT with more than the clips: proxies in SUB, a JPEG per clip
 * in THMBNL. Counting those as media to import means a card reports thousands
 * of files missing that nobody would ever import — and the clips themselves
 * usually live in a different library from the photographs, or in none.
 */

const CAMERA = { make: "Sony", model: "ILCE-7SM3", dateTimeOriginal: "2024:05:01 09:10:00" };
const still = (filler: number, size = 20_000) => buildJpegWithExif(CAMERA, size, filler);
const clip = (filler: number) => Buffer.alloc(120_000, filler);

let tmp: string;
let card: string;
let photos: string;
let footage: string;
let db: Db;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-video-"));
  card = path.join(tmp, "card");
  photos = path.join(tmp, "photos");
  footage = path.join(tmp, "footage");

  // The card, as a Sony writes it.
  const m4 = path.join(card, "PRIVATE", "M4ROOT");
  await fs.mkdir(path.join(m4, "CLIP"), { recursive: true });
  await fs.mkdir(path.join(m4, "SUB"), { recursive: true });
  await fs.mkdir(path.join(m4, "THMBNL"), { recursive: true });
  await fs.mkdir(path.join(card, "DCIM", "100MSDCF"), { recursive: true });

  for (const n of ["C0001", "C0002"]) {
    await fs.writeFile(path.join(m4, "CLIP", `${n}.MP4`), clip(n === "C0001" ? 1 : 2));
    await fs.writeFile(path.join(m4, "SUB", `${n}S01.MP4`), clip(9));
    await fs.writeFile(path.join(m4, "THMBNL", `${n}T01.JPG`), still(n === "C0001" ? 11 : 12, 8_000));
  }
  await fs.writeFile(path.join(card, "DCIM", "100MSDCF", "A7203841.ARW"), still(3, 40_000));

  // The photo library holds the stills; the footage library holds the clips.
  await fs.mkdir(photos, { recursive: true });
  await fs.mkdir(footage, { recursive: true });
  await fs.writeFile(path.join(photos, "A7203841.ARW"), still(3, 40_000));
  await fs.writeFile(path.join(footage, "C0001.MP4"), clip(1));

  db = new Db(":memory:");
});

after(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

function configWith(kinds: AppConfig["kinds"]): AppConfig {
  return {
    ...defaultConfig(),
    setupComplete: true,
    rule: "photos",
    libraries: [
      defaultLibrary({ path: photos, key: "photos", label: "Photos" }),
      defaultLibrary({ path: footage, key: "footage", label: "Footage" }),
    ],
    kinds,
  };
}

async function scan(kinds: AppConfig["kinds"]): Promise<ScanResult> {
  const config = configWith(kinds);
  for (const lib of config.libraries) await indexLibrary(db, lib);
  return scanCard(db, config, card);
}

const names = (result: ScanResult) =>
  getScanFiles(db, result.scanId, { dir: "", recursive: true, limit: 500 }).files.map((f) => f.name);

describe("what a card of footage even contains", () => {
  let result: ScanResult;

  before(async () => {
    result = await scan({});
  });

  test("the camera's own working files are not treated as media", () => {
    const listed = names(result);
    assert.ok(!listed.some((n) => n.endsWith("S01.MP4")), "proxies in SUB are not footage");
    assert.ok(!listed.some((n) => n.endsWith("T01.JPG")), "THMBNL stills are not photographs");
  });

  test("the clips and the frame are", () => {
    const listed = names(result);
    assert.ok(listed.includes("C0001.MP4"));
    assert.ok(listed.includes("C0002.MP4"));
    assert.ok(listed.includes("A7203841.ARW"));
  });
});

describe("video judged by the photo rule", () => {
  test("clips block the format, because they are not in the photo library", async () => {
    const result = await scan({});
    assert.equal(result.verdict.blocked, 2, "both clips are missing from `photos`");
  });
});

describe("video ignored", () => {
  let result: ScanResult;

  before(async () => {
    result = await scan({ video: { mode: "ignore" } });
  });

  test("no clip blocks a format", () => {
    assert.equal(result.verdict.blocked, 0);
  });

  test("but the stills are still checked", () => {
    // Ignoring footage must not quietly stop checking anything else — the
    // frame is in the photo library, which is why this is safe.
    const frame = getScanFiles(db, result.scanId, { dir: "", recursive: true }).files.find(
      (f) => f.name === "A7203841.ARW",
    );
    assert.ok(frame);
    assert.equal(frame.satisfied, true);
  });
});

describe("video given its own library", () => {
  let result: ScanResult;

  before(async () => {
    result = await scan({ video: { mode: "rule", rule: "footage" } });
  });

  test("a clip that is in it is cleared", () => {
    const found = getScanFiles(db, result.scanId, { dir: "", recursive: true }).files.find(
      (f) => f.name === "C0001.MP4",
    );
    assert.ok(found);
    assert.equal(found.satisfied, true);
  });

  test("a clip that is not still blocks, and names the right library", () => {
    const missing = getScanFiles(db, result.scanId, { dir: "", recursive: true }).files.find(
      (f) => f.name === "C0002.MP4",
    );
    assert.ok(missing);
    assert.equal(missing.satisfied, false);
    assert.equal(missing.gap, "footage", "the gap should name the footage library, not the photo one");
  });

  test("and the stills are judged by the photo rule as before", () => {
    const frame = getScanFiles(db, result.scanId, { dir: "", recursive: true }).files.find(
      (f) => f.name === "A7203841.ARW",
    );
    assert.ok(frame?.satisfied);
  });
});

describe("previews for clips", () => {
  test("come from the still the camera wrote beside them", async () => {
    // Decoding a frame would mean the dependency the preview code exists to
    // avoid. The camera already made one, in the folder the scan skips.
    const clipPath = path.join(card, "PRIVATE", "M4ROOT", "CLIP", "C0001.MP4").split(path.sep).join("/");
    const st = await fs.stat(clipPath);

    const thumb = await readThumbnail(clipPath, "mp4", st.size, Math.round(st.mtimeMs));
    assert.ok(thumb, "expected the THMBNL still to be found");
    assert.equal(thumb.contentType, "image/jpeg");
    assert.ok(thumb.bytes.equals(still(11, 8_000)));
  });

  test("and a clip with no still beside it says so", async () => {
    const lonely = path.join(tmp, "lonely.mp4");
    await fs.writeFile(lonely, clip(4));
    const st = await fs.stat(lonely);
    assert.equal(await readThumbnail(lonely.split(path.sep).join("/"), "mp4", st.size, Math.round(st.mtimeMs)), null);
  });
});
