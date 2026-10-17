import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, type AppConfig } from "../src/core/config.ts";
import { indexLibrary } from "../src/index/library.ts";
import { scanCard, type ScanResult } from "../src/scan/card.ts";
import { getScanFiles } from "../src/scan/query.ts";
import { buildJpegWithExif, type ExifSpec } from "../tools/exif-writer.ts";

/**
 * Whether a file is in a library has to be answerable, not estimated.
 *
 * Camera filenames and byte sizes both collide in bulk once a library is large,
 * and an earlier design capped how many colliding rows it would look at — which
 * meant a real import could be sitting past the cap and get reported missing.
 * These tests bury the answer under collisions on purpose and require it to be
 * found anyway, by each of the three routes in turn.
 */

const CAMERA = { make: "Canon", model: "Canon EOS R5", serial: "042000123456" };
const DECOYS = 40;
const SIZE = 30_000;

function shot(captureTime: string, filler: number): Buffer {
  const spec: ExifSpec = { ...CAMERA, dateTimeOriginal: captureTime };
  return buildJpegWithExif(spec, SIZE, filler);
}

/** A clip whose atoms will not parse, so nothing can date it. */
function undatableClip(seed: string): Buffer {
  const bytes = Buffer.alloc(SIZE);
  crypto.createHash("sha256").update(seed).digest().copy(bytes);
  return bytes;
}

async function write(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

interface Scenario {
  card: { name: string; bytes: Buffer };
  /** The library's copy, and the name it is filed under. */
  counterpart?: { name?: string; bytes: Buffer };
  /** Decoys share the card file's byte size but are otherwise unrelated. */
  decoyExt?: string;
  /** Read every library file's capture metadata at index time. */
  full?: boolean;
}

const CARD_DIR = "DCIM/100EOSR5";
let tmp: string;
let db: Db;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-caps-"));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * One file on the card; a library where `DECOYS` unrelated files share its
 * exact byte size. The decoys sort first and are indexed first, so any lookup
 * that stops early spends its whole budget on them and never reaches the copy.
 */
async function scanAgainst(name: string, scenario: Scenario): Promise<ScanResult> {
  const root = path.join(tmp, name);
  const lib = path.join(root, "library");
  const ext = scenario.decoyExt ?? "JPG";

  await write(
    path.join(root, "card", ...CARD_DIR.split("/"), scenario.card.name),
    scenario.card.bytes,
  );
  for (let i = 0; i < DECOYS; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    const bytes =
      ext === "JPG" ? shot(`2019:03:${day} 08:00:00`, i + 1) : undatableClip(`decoy-${i}`);
    await write(path.join(lib, `AAA_${String(i).padStart(3, "0")}.${ext}`), bytes);
  }
  if (scenario.counterpart) {
    await write(
      path.join(lib, scenario.counterpart.name ?? scenario.card.name),
      scenario.counterpart.bytes,
    );
  }

  db = new Db(":memory:");
  const config: AppConfig = {
    ...defaultConfig(),
    setupComplete: true,
    rule: "main",
    libraries: [
      defaultLibrary({
        path: lib,
        key: "main",
        label: "Main",
        ...(scenario.full ? { metadata: "full" as const } : {}),
      }),
    ],
  };
  for (const library of config.libraries) await indexLibrary(db, library);
  return scanCard(db, config, path.join(root, "card"));
}

function frameIn(result: ScanResult, name: string) {
  const { files } = getScanFiles(db, result.scanId, { dir: CARD_DIR });
  const found = files.find((f) => f.name === name);
  assert.ok(found, `${name} missing from scan results`);
  return found;
}

describe("found by capture identity", () => {
  let lazy: ScanResult;
  let lazyDb: Db;
  let eager: ScanResult;

  before(async () => {
    const card = { name: "IMG_0001.JPG", bytes: shot("2024:05:01 09:10:00", 200) };
    lazy = await scanAgainst("lazy", { card, counterpart: { bytes: card.bytes } });
    lazyDb = db;
    eager = await scanAgainst("eager", { card, counterpart: { bytes: card.bytes }, full: true });
  });
  after(() => {
    lazyDb.close();
    db.close();
  });

  test("a lazily indexed library falls back to name and size", () => {
    // Nothing has opened those files yet, so there is no capture time to query.
    assert.equal(lazy.verdict.blocked, 0);
  });

  test("knowing the capture time settles it before anything else is asked", () => {
    assert.equal(eager.verdict.blocked, 0);
    assert.equal(eager.stats.truncated, 0, "the capped lookup should not have been reached");
  });

  test("at a higher tier than name and size could reach", () => {
    const frame = frameIn(eager, "IMG_0001.JPG");
    assert.equal(frame.matches.main?.tier, "strong");
    assert.equal(frame.matches.main?.reason, "same capture time and camera");
  });
});

describe("found by name and size, under a pile of same-size files", () => {
  let result: ScanResult;

  before(async () => {
    // The library's copy carries no readable capture time — a stripped export,
    // an old scan — so there is nothing to confirm or refute it with, and name
    // and size are the whole case.
    result = await scanAgainst("named", {
      card: { name: "IMG_0001.JPG", bytes: shot("2024:05:01 09:10:00", 200) },
      counterpart: { bytes: undatableClip("stripped-export") },
    });
  });
  after(() => db.close());

  test("the copy is found", () => {
    assert.equal(result.verdict.blocked, 0);
    const frame = frameIn(result, "IMG_0001.JPG");
    assert.equal(frame.matches.main?.tier, "probable");
    assert.equal(frame.matches.main?.reason, "same filename and byte size");
  });

  test("and nothing is hedged about it", () => {
    assert.deepEqual(result.warnings, []);
  });
});

describe("a repeated filename that a capture time refutes", () => {
  let result: ScanResult;

  before(async () => {
    // Cameras restart their counters, so the library's IMG_0001 is a different
    // frame from three years earlier that happens to share a byte size. Name
    // and size alone would clear the card file for deletion.
    result = await scanAgainst("refuted", {
      card: { name: "IMG_0001.JPG", bytes: shot("2024:05:01 09:10:00", 200) },
      counterpart: { bytes: shot("2011:01:01 00:00:00", 7) },
    });
  });
  after(() => db.close());

  test("the coincidence does not clear the file", () => {
    assert.equal(result.verdict.blocked, 1);
  });

  test("and the reason says which evidence was withdrawn", () => {
    const frame = frameIn(result, "IMG_0001.JPG");
    assert.equal(frame.matches.main?.tier, "weak");
    assert.equal(
      frame.matches.main?.reason,
      "same filename and byte size, but a different capture time",
    );
  });

  test("even though the library was indexed lazily, so the check cost one file read", () => {
    // The library row's capture time was unread at lookup time. Believing the
    // name-and-size match without reading it would have said "safe to format"
    // about a card holding the only copy.
    assert.ok(result.stats.metadataReads > 0);
  });
});

describe("a repeated filename the card file cannot be dated against", () => {
  let result: ScanResult;

  before(async () => {
    // What a whole card checked from its drive root looked like: every header
    // read failed, so the card side had no capture time at all, and name and
    // size went unchallenged. The library's IMG_0001 is a dated frame from
    // years earlier that shares a byte size, and nothing else.
    result = await scanAgainst("undatable-card", {
      card: { name: "IMG_0001.JPG", bytes: undatableClip("shot-today") },
      counterpart: { bytes: shot("2011:01:01 00:00:00", 7) },
    });
  });
  after(() => db.close());

  test("the coincidence does not clear the file", () => {
    assert.equal(result.verdict.blocked, 1);
  });

  test("and the reason says why the name was not enough", () => {
    const frame = frameIn(result, "IMG_0001.JPG");
    assert.equal(frame.matches.main?.tier, "weak");
    assert.equal(
      frame.matches.main?.reason,
      "same filename and byte size, but the card file's capture time could not be read",
    );
  });
});

describe("an undated file whose copy really is in the library", () => {
  let result: ScanResult;

  before(async () => {
    // Neither side has a time, so there is nothing to compare — and content
    // hashing is what answers it rather than the name.
    const bytes = undatableClip("undated-but-imported");
    result = await scanAgainst("undatable-both", {
      card: { name: "IMG_0001.JPG", bytes },
      counterpart: { bytes },
    });
  });
  after(() => db.close());

  test("is still found", () => {
    assert.equal(result.verdict.blocked, 0);
  });
});

describe("found by content, renamed and beyond any cap", () => {
  let result: ScanResult;

  before(async () => {
    // The hardest case the tool has to answer: no capture time to match on, a
    // filename that no longer resembles the card's, and forty same-size files
    // ahead of the copy in the index. Only hashing the complete same-size set
    // can find it, which is exactly what a capped candidate list could not do.
    const bytes = undatableClip("card");
    result = await scanAgainst("renamed", {
      card: { name: "CLIP_0001.MP4", bytes },
      counterpart: { name: "wedding-ceremony-take-3.MP4", bytes },
      decoyExt: "MP4",
    });
  });
  after(() => db.close());

  test("the copy is found", () => {
    assert.equal(result.verdict.blocked, 0);
    const frame = frameIn(result, "CLIP_0001.MP4");
    assert.equal(frame.matches.main?.tier, "strong");
    assert.equal(frame.matches.main?.reason, "identical size and content sample");
    assert.match(frame.matches.main?.path ?? "", /wedding-ceremony-take-3\.MP4$/);
  });

  test("and nothing is hedged about it", () => {
    assert.deepEqual(result.warnings, []);
  });
});

describe("genuinely absent from a crowded library", () => {
  let photo: ScanResult;
  let photoDb: Db;
  let clip: ScanResult;

  before(async () => {
    photo = await scanAgainst("absent-photo", {
      card: { name: "IMG_0001.JPG", bytes: shot("2024:05:01 09:10:00", 200) },
    });
    photoDb = db;
    clip = await scanAgainst("absent-clip", {
      card: { name: "CLIP_0001.MP4", bytes: undatableClip("card") },
      decoyExt: "MP4",
    });
  });
  after(() => {
    photoDb.close();
    db.close();
  });

  test("both are reported as needing import", () => {
    assert.equal(photo.verdict.blocked, 1);
    assert.equal(clip.verdict.blocked, 1);
  });

  test("stated plainly, with no caveat about the comparison", () => {
    // Every route was exhausted: capture identity against a fully read library,
    // name and size as one indexed question, and content against every file of
    // the same size. "Not there" is an answer, and hedging it would teach the
    // user to distrust a correct verdict.
    assert.deepEqual(photo.warnings, []);
    assert.deepEqual(clip.warnings, []);
  });
});
