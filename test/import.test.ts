import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, type AppConfig } from "../src/core/config.ts";
import { indexLibrary } from "../src/index/library.ts";
import { scanCard } from "../src/scan/card.ts";
import { importFromScan, planImport, runImport } from "../src/scan/import.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";
import { writeCatalog } from "../tools/make-catalog.ts";

/**
 * Copying the missing files into a library.
 *
 * This is the only code in the project that writes anything, so most of what
 * follows is about what it must never do: overwrite a photograph, duplicate one
 * that is already filed, leave a half-copied raw looking like a finished
 * import, or touch the card in any way at all.
 */

const SONY = { make: "Sony", model: "ILCE-7RM5" };
const shot = (when: string, filler: number, size = 30_000) =>
  buildJpegWithExif({ ...SONY, dateTimeOriginal: when }, size, filler);

/** A clip's mtime, fixed so the folder it is filed under is predictable. */
const CLIP_MTIME = new Date(2024, 4, 3, 14, 30, 0);
const clipFolder = `${CLIP_MTIME.getFullYear()}/${String(CLIP_MTIME.getFullYear())}-${String(
  CLIP_MTIME.getMonth() + 1,
).padStart(2, "0")}-${String(CLIP_MTIME.getDate()).padStart(2, "0")}`;

interface World {
  tmp: string;
  card: string;
  photos: string;
  footage: string;
  backup: string;
  db: Db;
}

async function makeWorld(name: string): Promise<World> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `can-i-format-import-${name}-`));
  const card = path.join(tmp, "card");
  const photos = path.join(tmp, "photos");
  const footage = path.join(tmp, "footage");
  const backup = path.join(tmp, "backup");

  const dcim = path.join(card, "DCIM", "100MSDCF");
  const clips = path.join(card, "PRIVATE", "M4ROOT", "CLIP");
  await fs.mkdir(dcim, { recursive: true });
  await fs.mkdir(clips, { recursive: true });
  for (const dir of [photos, footage, backup]) await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path.join(dcim, "A9303931.ARW"), shot("2024:05:01 09:10:00", 1));
  await fs.writeFile(path.join(dcim, "A9303932.ARW"), shot("2024:05:02 11:00:00", 2));
  await fs.writeFile(path.join(dcim, "A9303933.JPG"), shot("2024:05:01 09:11:00", 3));

  const clip = path.join(clips, "C0001.MP4");
  await fs.writeFile(clip, Buffer.alloc(50_000, 7));
  await fs.utimes(clip, CLIP_MTIME, CLIP_MTIME);

  return { tmp, card, photos, footage, backup, db: new Db(":memory:") };
}

function configFor(world: World, over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig(),
    libraries: [
      defaultLibrary({ path: world.photos, label: "photos", key: "photos" }),
      defaultLibrary({ path: world.footage, label: "footage", key: "footage" }),
      defaultLibrary({ path: world.backup, label: "backup", key: "backup" }),
    ],
    rule: "photos",
    kinds: { video: { mode: "rule", rule: "footage" } },
    import: {
      destinations: {
        photos: { mode: "library", libraryKey: "photos" },
        video: { mode: "library", libraryKey: "footage" },
      },
      folderTemplate: "{YYYY}/{YYYY}-{MM}-{DD}",
      filenameTemplate: "{name}",
    },
    ...over,
  };
}

async function indexAll(world: World, config: AppConfig): Promise<void> {
  for (const library of config.libraries) await indexLibrary(world.db, library, {});
}

/** Every file under a root, relative and sorted — for comparing before/after. */
async function treeOf(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  }
  await walk(root, "");
  return out.sort();
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

// ---------------------------------------------------------------------------

describe("importing what a scan found missing", () => {
  let world: World;
  let outcome: Awaited<ReturnType<typeof importFromScan>>;
  let cardBefore: string[];

  before(async () => {
    world = await makeWorld("basic");
    const config = configFor(world);
    await indexAll(world, config);

    const scan = await scanCard(world.db, config, world.card, { label: "CFexpress 512GB" });
    assert.equal(scan.verdict.status !== "safe", true, "the card should start out blocked");

    cardBefore = await treeOf(world.card);
    outcome = await importFromScan(world.db, config, scan.scanId);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("stills are filed by capture date under the photo library", async () => {
    assert.ok(await exists(path.join(world.photos, "2024", "2024-05-01", "A9303931.ARW")));
    assert.ok(await exists(path.join(world.photos, "2024", "2024-05-02", "A9303932.ARW")));
    assert.ok(await exists(path.join(world.photos, "2024", "2024-05-01", "A9303933.JPG")));
  });

  test("footage goes to the footage library instead", async () => {
    assert.ok(await exists(path.join(world.footage, clipFolder, "C0001.MP4")));
    assert.equal(
      await exists(path.join(world.photos, clipFolder, "C0001.MP4")),
      false,
      "a clip in the photo library would be the whole point missed",
    );
  });

  test("the copies are byte for byte the originals", async () => {
    const source = await fs.readFile(path.join(world.card, "DCIM", "100MSDCF", "A9303931.ARW"));
    const copy = await fs.readFile(path.join(world.photos, "2024", "2024-05-01", "A9303931.ARW"));
    assert.deepEqual(copy, source);
  });

  test("the card is left exactly as it was", async () => {
    assert.deepEqual(await treeOf(world.card), cardBefore);
  });

  test("no half-copied file is left lying about", async () => {
    const strays = (await treeOf(world.photos)).filter((f) => f.includes(".cif-part"));
    assert.deepEqual(strays, []);
  });

  test("the libraries are re-indexed, so they know about the new files", () => {
    assert.deepEqual(outcome.reindexed.sort(), ["footage", "photos"]);
  });

  test("and the card is re-checked without being asked", () => {
    assert.ok(outcome.rescan, "a folder library needs no help from the user");
    assert.equal(outcome.rescan?.status, "safe", "everything was copied, so nothing blocks a format");
  });

  test("nothing was reported as failed", () => {
    assert.deepEqual(outcome.failed, []);
    assert.equal(outcome.copied, 4);
  });
});

describe("a file the destination library already holds", () => {
  let world: World;
  let plan: Awaited<ReturnType<typeof planImport>>;

  before(async () => {
    world = await makeWorld("held");
    // Already filed in `photos`, but the rule wants it in `backup` too — so it
    // is blocked, and a naive import would copy it into `photos` a second time.
    await fs.writeFile(
      path.join(world.photos, "A9303931.ARW"),
      await fs.readFile(path.join(world.card, "DCIM", "100MSDCF", "A9303931.ARW")),
    );

    const config = configFor(world, { rule: "photos and backup" });
    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "card" });
    plan = await planImport(world.db, config, scan.scanId);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("is blocked by the rule but not copied again", () => {
    const targets = plan.items.map((i) => i.name);
    assert.equal(targets.includes("A9303931.ARW"), false, "it is already in the photo library");
    assert.ok(targets.includes("A9303932.ARW"), "the ones that really are missing still go");
  });

  test("and the reason is reported rather than silently dropped", () => {
    const skipped = plan.skipped.find((s) => s.name === "A9303931.ARW");
    assert.match(skipped?.reason ?? "", /already in photos/i);
    assert.equal(plan.groups.find((g) => g.group === "photos")?.alreadyHeld, 1);
  });
});

describe("something is already at the destination", () => {
  let world: World;
  let config: AppConfig;
  let scanId: number;

  before(async () => {
    world = await makeWorld("collide");
    config = configFor(world);
    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "card" });
    scanId = scan.scanId;
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("a different photograph with the same name is never overwritten", async () => {
    const dir = path.join(world.photos, "2024", "2024-05-01");
    await fs.mkdir(dir, { recursive: true });
    const stranger = Buffer.from("a completely different photograph");
    await fs.writeFile(path.join(dir, "A9303931.ARW"), stranger);

    const plan = await planImport(world.db, config, scanId);
    await runImport(world.db, config, plan);

    assert.deepEqual(
      await fs.readFile(path.join(dir, "A9303931.ARW")),
      stranger,
      "the file that was there first still is",
    );
    assert.ok(await exists(path.join(dir, "A9303931_2.ARW")), "the card's copy took a suffix");
  });

  test("an identical copy already there is counted, not written twice", async () => {
    const world2 = await makeWorld("identical");
    const config2 = configFor(world2);
    await indexAll(world2, config2);
    const scan = await scanCard(world2.db, config2, world2.card, { label: "card" });

    const plan = await planImport(world2.db, config2, scan.scanId);
    const first = await runImport(world2.db, config2, plan);
    assert.equal(first.copied, 4);

    // The same plan again: every target now exists and matches.
    const second = await runImport(world2.db, config2, plan);
    assert.equal(second.identical, 4, "recognised as the same file");
    assert.equal(second.copied, 0, "and not duplicated with _2 suffixes");

    const strays = (await treeOf(world2.photos)).filter((f) => f.includes("_2"));
    assert.deepEqual(strays, []);

    world2.db.close();
    await fs.rm(world2.tmp, { recursive: true, force: true });
  });
});

describe("when a copy cannot be made", () => {
  let world: World;
  let outcome: Awaited<ReturnType<typeof importFromScan>>;

  before(async () => {
    world = await makeWorld("failure");
    const config = configFor(world);
    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "card" });

    // Pulled out from under the import, the way a card yanked mid-copy would be.
    await fs.rm(path.join(world.card, "DCIM", "100MSDCF", "A9303932.ARW"));
    outcome = await importFromScan(world.db, config, scan.scanId);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("the failure is reported by name", () => {
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0]?.name, "A9303932.ARW");
  });

  test("the ones that could be copied still were", async () => {
    assert.ok(await exists(path.join(world.photos, "2024", "2024-05-01", "A9303931.ARW")));
    assert.equal(outcome.copied, 3);
  });

  test("nothing half-written is left behind", async () => {
    const strays = (await treeOf(world.photos)).filter((f) => f.includes(".cif-part"));
    assert.deepEqual(strays, []);
  });

  test("and no verdict is offered, because the card is genuinely not safe", () => {
    // Re-scanning here would report a card that is still missing a file, and
    // showing a fresh green verdict after a failed copy is how footage is lost.
    assert.equal(outcome.rescan, null);
  });
});

describe("a Lightroom catalog as the destination", () => {
  let world: World;
  let plan: Awaited<ReturnType<typeof planImport>>;

  let outcome: Awaited<ReturnType<typeof importFromScan>>;

  before(async () => {
    world = await makeWorld("catalog");

    // A real catalog, holding one frame that is already filed. Its root folder
    // is what tells an import where a file has to land for Lightroom to be
    // able to find it — the catalog file itself is just a database.
    const catalog = path.join(world.tmp, "Main.lrcat");
    writeCatalog(catalog, {
      rootPath: world.photos.split(path.sep).join("/"),
      files: [
        {
          pathFromRoot: "2023/2023-01-01/",
          baseName: "OLD_0001",
          extension: "ARW",
          captureTime: "2023-01-01T10:00:00",
          cameraModel: "ILCE-7RM5",
        },
      ],
    });

    const config = configFor(world);
    config.libraries = [
      defaultLibrary({ path: catalog, key: "photos", label: "photos", kind: "lightroom" }),
      defaultLibrary({ path: world.footage, key: "footage", label: "footage" }),
    ];

    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "card" });
    plan = await planImport(world.db, config, scan.scanId);
    outcome = await importFromScan(world.db, config, scan.scanId);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("files land in the folder the catalog says its photos live in", async () => {
    // Not beside the .lrcat, which is only a database and often lives on a
    // different disk entirely.
    assert.ok(await exists(path.join(world.photos, "2024", "2024-05-01", "A9303931.ARW")));
  });

  test("is listed as needing a synchronize before it sees the files", () => {
    assert.equal(plan.needsSync.length, 1);
    assert.equal(plan.needsSync[0]?.label, "photos");
    assert.deepEqual(plan.needsSync[0]?.folders, [world.photos.split(path.sep).join("/")]);
  });

  test("so it is not in the list of libraries that can just be re-indexed", () => {
    assert.equal(plan.reindex.includes("photos"), false);
    assert.ok(plan.reindex.includes("footage"), "the folder library still can be");
  });

  test("and no re-scan is run, because it would say the files are still missing", () => {
    // The bytes are on disk but the catalog has not been told. Scanning now
    // would report every one of them missing and undo the trust the copy
    // just earned, so it waits for Lightroom.
    assert.equal(outcome.rescan, null);
    assert.equal(outcome.copied, 4, "the copying itself still happened");
  });
});

describe("the plan, before anything is written", () => {
  let world: World;
  let plan: Awaited<ReturnType<typeof planImport>>;

  before(async () => {
    world = await makeWorld("plan");
    const config = configFor(world);
    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "CFexpress 512GB" });
    plan = await planImport(world.db, config, scan.scanId);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("writes nothing at all", async () => {
    assert.deepEqual(await treeOf(world.photos), [], "planning is a question, not an action");
    assert.deepEqual(await treeOf(world.footage), []);
  });

  test("shows real destination paths, not a count", () => {
    const example = plan.examples.find((e) => e.source.endsWith("A9303931.ARW"));
    assert.ok(example, "there should be an example for a real file");
    assert.match(example?.target ?? "", /2024\/2024-05-01\/A9303931\.ARW$/);
  });

  test("says which files had no capture time to file them by", () => {
    // The clip: an empty MP4 has no atoms to read, so its own timestamp
    // decided its folder, and that is worth saying before 50 GB gets filed by it.
    assert.equal(plan.datedByFile, 1);
    assert.ok(plan.warnings.some((w) => /no capture time/i.test(w)));
  });

  test("totals the bytes so free space can be checked", () => {
    assert.equal(plan.files, 4);
    assert.ok(plan.bytes > 50_000, "the clip alone is 50 KB");
    assert.ok(plan.space.every((s) => s.ok), "a temp dir has room for 140 KB");
  });
});

describe("a library filed without leading zeros", () => {
  let world: World;

  before(async () => {
    world = await makeWorld("unpadded");
    const config = configFor(world);
    config.import.folderTemplate = "{YYYY}/{M}-{D}-{YYYY}";

    // The folder the library already uses for that day. Anything that writes
    // 05-01-2024 beside it has quietly split one day's work across two places.
    await fs.mkdir(path.join(world.photos, "2024", "5-1-2024"), { recursive: true });

    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "card" });
    const plan = await planImport(world.db, config, scan.scanId);
    await runImport(world.db, config, plan);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("files land in the folder that is already there", async () => {
    assert.ok(await exists(path.join(world.photos, "2024", "5-1-2024", "A9303931.ARW")));
    assert.ok(await exists(path.join(world.photos, "2024", "5-2-2024", "A9303932.ARW")));
  });

  test("and no padded twin is created beside it", async () => {
    const dirs = await fs.readdir(path.join(world.photos, "2024"));
    assert.deepEqual(dirs.sort(), ["5-1-2024", "5-2-2024"]);
  });
});

describe("a group with nowhere to go", () => {
  let world: World;
  let plan: Awaited<ReturnType<typeof planImport>>;

  before(async () => {
    world = await makeWorld("skip");
    const config = configFor(world);
    config.import.destinations.video = { mode: "skip" };
    await indexAll(world, config);
    const scan = await scanCard(world.db, config, world.card, { label: "card" });
    plan = await planImport(world.db, config, scan.scanId);
  });

  after(async () => {
    world.db.close();
    await fs.rm(world.tmp, { recursive: true, force: true });
  });

  test("stays on the card and is not quietly forgotten", () => {
    assert.equal(plan.items.some((i) => i.name === "C0001.MP4"), false);
    assert.ok(plan.skipped.some((s) => s.name === "C0001.MP4"));
    assert.ok(plan.warnings.some((w) => /no destination/i.test(w)));
  });

  test("while the photos still go", () => {
    assert.equal(plan.files, 3);
  });
});
