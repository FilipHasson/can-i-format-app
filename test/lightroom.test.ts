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
import { sameCamera } from "../src/core/metadata.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";
import { writeCatalog, type CatalogFile } from "../tools/make-catalog.ts";

/**
 * Matching a card against a Lightroom catalog.
 *
 * A catalog is not a folder: it records that a file was imported, but not how
 * big it is. That leaves capture time and camera as the only way in, and both
 * are things a catalog may spell differently from the card's own EXIF — or not
 * have at all. Get either wrong and a catalog matches nothing whatsoever,
 * while the same library scanned as a folder matches everything.
 */

const CARD_DIR = "DCIM/100MSDCF";
let tmp: string;
let library: string;
let card: string;
let db: Db;

const FRAMES = [
  { name: "A7203841", exif: "2024:05:01 09:10:00", iso: "2024-05-01T09:10:00" },
  { name: "A7203842", exif: "2024:05:01 09:11:00", iso: "2024-05-01T09:11:00" },
  { name: "A7203843", exif: "2024:05:01 09:12:00", iso: "2024-05-01T09:12:00" },
];

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-lrcat-"));
  library = path.join(tmp, "Pictures");
  card = path.join(tmp, "card");
  await fs.mkdir(path.join(library, "2024", "05-01"), { recursive: true });
  await fs.mkdir(path.join(card, ...CARD_DIR.split("/")), { recursive: true });

  for (const [i, frame] of FRAMES.entries()) {
    const bytes = buildJpegWithExif(
      { make: "Canon", model: "Canon EOS R5", serial: "042000123456", dateTimeOriginal: frame.exif },
      30_000 + i,
      i + 1,
    );
    await fs.writeFile(path.join(card, ...CARD_DIR.split("/"), `${frame.name}.CR2`), bytes);
    await fs.writeFile(path.join(library, "2024", "05-01", `${frame.name}.CR2`), bytes);
  }
  db = new Db(":memory:");
});

after(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A catalog over the same files, with whatever metadata is under test. */
async function scanAgainstCatalog(name: string, files: CatalogFile[]): Promise<ScanResult> {
  const catalog = path.join(tmp, `${name}.lrcat`);
  writeCatalog(catalog, { rootPath: library.split(path.sep).join("/"), files });

  const key = `cat${name}`;
  const library_ = defaultLibrary({ path: catalog, key, label: name, kind: "lightroom" });
  const config: AppConfig = {
    ...defaultConfig(),
    setupComplete: true,
    rule: key,
    libraries: [library_],
  };
  await indexLibrary(db, library_);
  return scanCard(db, config, card, { label: name });
}

const entry = (frame: (typeof FRAMES)[number]): CatalogFile => ({
  pathFromRoot: "2024/05-01/",
  baseName: frame.name,
  extension: "CR2",
});

describe("a catalog with capture times and a camera", () => {
  test("matches every frame on capture identity", async () => {
    const result = await scanAgainstCatalog("full", [
      ...FRAMES.map((f) => ({ ...entry(f), captureTime: f.iso, cameraModel: "Canon EOS R5", cameraSerial: "042000123456" })),
    ]);
    assert.equal(result.verdict.blocked, 0);
  });
});

describe("a camera model spelled the way a catalog spells it", () => {
  test("EXIF's make is dropped from the model, a catalog's is not", () => {
    // The card says make "Canon", model "Canon EOS R5", and the redundant make
    // is stripped. The catalog has one interned string and keeps it whole.
    // Comparing strictly meant no Canon body ever matched its own catalog.
    assert.ok(sameCamera("eos r5|042000123456", "canon eos r5|042000123456"));
    assert.ok(sameCamera("canon eos r5|042000123456", "eos r5|042000123456"));
  });

  test("but two genuinely different bodies still do not match", () => {
    assert.equal(sameCamera("eos r5|1", "eos r6|1"), false);
    assert.equal(sameCamera("ilce-7rm5|1", "eos r5|1"), false);
  });

  test("and a serial only one side knows is not a disagreement", () => {
    assert.ok(sameCamera("eos r5|", "canon eos r5|042000123456"));
    assert.equal(sameCamera("eos r5|111", "eos r5|222"), false);
  });

  test("a whole card matches a catalog that spells the model in full", async () => {
    const result = await scanAgainstCatalog("model", [
      ...FRAMES.map((f) => ({ ...entry(f), captureTime: f.iso, cameraModel: "Canon EOS R5" })),
    ]);
    assert.equal(result.verdict.blocked, 0, "the model is the same camera, written differently");
  });
});

describe("a catalog with no capture times at all", () => {
  let result: ScanResult;

  before(async () => {
    // Some catalogs never harvested EXIF. With no capture time there is no
    // capture identity, and a catalog records no file size either — so before
    // sizes were filled in, this matched nothing whatsoever.
    result = await scanAgainstCatalog("bare", FRAMES.map(entry));
  });

  test("still matches, on name and size", () => {
    assert.equal(result.verdict.blocked, 0);
  });

  test("and says that is what it did", () => {
    const files = getScanFiles(db, result.scanId, { dir: CARD_DIR, recursive: true }).files;
    const frame = files.find((f) => f.name === "A7203841.CR2");
    assert.ok(frame);
    assert.equal(frame.matches.catbare?.tier, "probable");
    assert.equal(frame.matches.catbare?.reason, "same filename and byte size");
  });
});

describe("a catalog whose files are not on this machine", () => {
  test("still counts, because that is what a catalog is for", async () => {
    // The drive is unplugged: nothing can be stat'ed. A catalog knowing what
    // was imported is exactly the case it earns its keep in, so a file it
    // cannot reach must not be treated as absent.
    const result = await scanAgainstCatalog(
      "offline",
      FRAMES.map((f) => ({
        ...entry(f),
        pathFromRoot: "somewhere/that/does/not/exist/",
        captureTime: f.iso,
        cameraModel: "Canon EOS R5",
      })),
    );
    assert.equal(result.verdict.blocked, 0, "capture identity does not need the file");
  });
});

describe("a catalog holding a different shoot with the same filenames", () => {
  test("does not clear the card", async () => {
    // Camera counters repeat. A catalog entry with the same name but another
    // capture time is a different frame, and the sizes differ too.
    const result = await scanAgainstCatalog(
      "collision",
      FRAMES.map((f) => ({
        ...entry(f),
        pathFromRoot: "2019/03-14/",
        captureTime: "2019-03-14T11:00:00",
        cameraModel: "Canon EOS R5",
      })),
    );
    assert.equal(result.verdict.blocked, 3, "a repeated filename is not evidence of anything");
  });
});

describe("a catalog shaped like a real one", () => {
  let result: ScanResult;

  before(async () => {
    // Taken from a probe of a 161,000-file catalog: capture times carry
    // milliseconds, the camera model is interned but no serial was ever
    // harvested, and imports were converted to DNG and renamed — so name and
    // size cannot help and capture identity has to carry it alone.
    result = await scanAgainstCatalog(
      "real",
      FRAMES.map((f) => ({
        pathFromRoot: "2024/2024-05-01-shoot/",
        baseName: `LRM_2024050${FRAMES.indexOf(f) + 1}_091000`,
        extension: "dng",
        originalFilename: `${f.name}.CR2`,
        captureTime: `${f.iso}.632`,
        cameraModel: "Canon EOS R5",
      })),
    );
  });

  test("milliseconds on the capture time change nothing", () => {
    assert.equal(result.verdict.blocked, 0);
  });

  test("a model with no serial beside it still counts as the same camera", () => {
    // AgInternedExifCameraSN is empty in that catalog, so every row has a
    // model and no serial while the card's EXIF may carry both.
    assert.ok(sameCamera("ilce-7m2|", "ilce-7m2|3204567"));
    assert.ok(sameCamera("ilce-7m2|3204567", "ilce-7m2|"));
    assert.ok(sameCamera("canon eos r5|", "eos r5|042000123456"));
  });

  test("and the match is by capture identity, since nothing else could", () => {
    const files = getScanFiles(db, result.scanId, { dir: CARD_DIR, recursive: true }).files;
    const frame = files.find((f) => f.name === "A7203841.CR2");
    assert.ok(frame);
    assert.equal(frame.matches.catreal?.tier, "strong");
    assert.match(frame.matches.catreal?.path ?? "", /LRM_20240501_091000\.dng$/);
  });
});

describe("a library the rule does not name", () => {
  test("still reports where a file is", async () => {
    // Adding a catalog does not add it to a rule the user has edited, so the
    // rule can name one library while another holds the files too. Reporting
    // nothing for that second library reads as the tool being broken — which
    // is exactly how it was reported.
    const catalog = path.join(tmp, "unnamed.lrcat");
    writeCatalog(catalog, {
      rootPath: library.split(path.sep).join("/"),
      files: FRAMES.map((f) => ({
        pathFromRoot: "2024/05-01/",
        baseName: f.name,
        extension: "CR2",
        captureTime: f.iso,
        cameraModel: "Canon EOS R5",
      })),
    });

    const folder = defaultLibrary({ path: library, key: "folder", label: "Folder" });
    const cat = defaultLibrary({ path: catalog, key: "cat", label: "Catalog", kind: "lightroom" });
    const config: AppConfig = {
      ...defaultConfig(),
      setupComplete: true,
      // The catalog is enabled and indexed, but the rule names only the folder.
      rule: "folder",
      libraries: [folder, cat],
    };
    await indexLibrary(db, folder);
    await indexLibrary(db, cat);

    const result = await scanCard(db, config, card, { label: "unnamed" });
    const frame = getScanFiles(db, result.scanId, { dir: CARD_DIR, recursive: true }).files.find(
      (f) => f.name === "A7203841.CR2",
    );

    assert.ok(frame);
    assert.ok(frame.matches.folder, "the rule's own library reports, obviously");
    assert.ok(frame.matches.cat, "and so does the one it leaves out");
    assert.notEqual(frame.matches.cat?.tier, "none");
  });
});

describe("a file imported and then deleted", () => {
  /** A catalog over files that no longer exist under the given folder. */
  async function scanWithMissing(name: string, folder: string): Promise<ScanResult> {
    const catalog = path.join(tmp, `${name}.lrcat`);
    writeCatalog(catalog, {
      rootPath: library.split(path.sep).join("/"),
      files: FRAMES.map((f) => ({
        pathFromRoot: folder,
        baseName: f.name,
        extension: "CR2",
        captureTime: f.iso,
        cameraModel: "Canon EOS R5",
      })),
    });
    const lib = defaultLibrary({ path: catalog, key: name, label: name, kind: "lightroom" });
    const config: AppConfig = {
      ...defaultConfig(),
      setupComplete: true,
      rule: name,
      libraries: [lib],
    };
    await indexLibrary(db, lib);
    return scanCard(db, config, card, { label: name });
  }

  test("does not count as a copy", async () => {
    // The catalog says imported; the folder is there but the file is gone —
    // culled in Lightroom, or deleted from outside it. A record of an import
    // is not a copy, and clearing a card on the strength of one loses work.
    await fs.mkdir(path.join(library, "culled"), { recursive: true });
    await fs.writeFile(path.join(library, "culled", "something-else.CR2"), "x");

    const result = await scanWithMissing("culled", "culled/");
    assert.equal(result.verdict.blocked, 3);
    assert.equal(result.stats.deletedSinceImport, 3);
  });

  test("and says so, rather than just calling it missing", async () => {
    const result = await scanWithMissing("culled2", "culled/");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /imported into a catalog, but the copies/);

    const frame = getScanFiles(db, result.scanId, { dir: CARD_DIR, recursive: true }).files.find(
      (f) => f.name === "A7203841.CR2",
    );
    assert.equal(frame?.matches.culled2?.deleted, true);
    assert.equal(frame?.matches.culled2?.reason, "imported, but the copy is no longer there");
    // The reader lowercases the extension, the way Lightroom stores it.
    assert.match(frame?.matches.culled2?.path ?? "", /culled\/A7203841\.cr2$/i);
  });

  test("a folder that is not there at all is not called a deletion", async () => {
    // An unplugged drive, or a library moved wholesale. Nothing was deleted,
    // and saying so for every file would bury the cases where something was.
    const result = await scanWithMissing("moved", "not/here/any/more/");
    assert.equal(result.stats.deletedSinceImport, 0);
    assert.deepEqual(result.warnings, []);
  });

  test("and a catalog where nothing at all can be found is left alone", async () => {
    // If not one file resolves, the paths do not describe this machine — a
    // drive letter that changed. That is a different problem from deletion.
    const catalog = path.join(tmp, "wrongdrive.lrcat");
    writeCatalog(catalog, {
      rootPath: "Z:/nowhere/",
      files: FRAMES.map((f) => ({
        pathFromRoot: "2024/05-01/",
        baseName: f.name,
        extension: "CR2",
        captureTime: f.iso,
        cameraModel: "Canon EOS R5",
      })),
    });
    const lib = defaultLibrary({ path: catalog, key: "wrongdrive", label: "Wrong", kind: "lightroom" });
    await indexLibrary(db, lib);
    const result = await scanCard(
      db,
      { ...defaultConfig(), setupComplete: true, rule: "wrongdrive", libraries: [lib] },
      card,
      { label: "wrongdrive" },
    );

    assert.equal(result.stats.deletedSinceImport, 0, "a bad path mapping is not a mass deletion");
    assert.equal(result.verdict.blocked, 0, "the catalog is still believed, as when a drive is out");
  });
});
