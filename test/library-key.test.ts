import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, loadConfig, saveConfig, type AppConfig } from "../src/core/config.ts";
import { indexLibrary, renameLibraryKey } from "../src/index/library.ts";
import { scanCard } from "../src/scan/card.ts";
import { planImport } from "../src/scan/import.ts";
import { startServer, type StartedServer } from "../src/server/server.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";

/**
 * A library's key is written down in more places than its config entry: the
 * rules, the import destinations, the index, and every past scan's matches.
 * Renaming it has to reach all of them, or the rules stop validating and an
 * import from an older scan copies files the library already holds.
 */

const testHome = process.env.CAN_I_FORMAT_HOME;
let tmp: string;
let db: Db;
let config: AppConfig;
let scanId: number;

const frame = (time: string, filler: number) =>
  buildJpegWithExif({ make: "Sony", model: "ILCE-7RM5", dateTimeOriginal: time }, 20_000 + filler, filler);

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-key-"));
  process.env.CAN_I_FORMAT_HOME = path.join(tmp, "home");

  const dirs = Object.fromEntries(
    ["card/DCIM/100MSDCF", "main", "backup", "backup-2", "footage"].map((d) => [d, path.join(tmp, d)]),
  );
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });

  // One frame in main only, one in backup only: both blocked by
  // `main and backup`, for different reasons.
  const inMain = frame("2024:05:01 09:10:00", 1);
  const inBackup = frame("2024:05:01 09:11:00", 2);
  await fs.writeFile(path.join(dirs["card/DCIM/100MSDCF"]!, "A0000001.JPG"), inMain);
  await fs.writeFile(path.join(dirs["card/DCIM/100MSDCF"]!, "A0000002.JPG"), inBackup);
  await fs.writeFile(path.join(dirs.main!, "A0000001.JPG"), inMain);
  await fs.writeFile(path.join(dirs.backup!, "A0000002.JPG"), inBackup);

  config = {
    ...defaultConfig(),
    setupComplete: true,
    rule: "main and backup",
    libraries: [
      defaultLibrary({ path: dirs.main!, key: "main", label: "Main" }),
      defaultLibrary({ path: dirs.backup!, key: "backup", label: "Backup" }),
      defaultLibrary({ path: dirs["backup-2"]!, key: "backup-2", label: "Backup 2" }),
      defaultLibrary({ path: dirs.footage!, key: "footage", label: "Footage" }),
    ],
    kinds: { video: { mode: "rule", rule: "footage and backup" } },
    port: 0,
  };
  config.import = {
    ...config.import,
    destinations: { photos: { mode: "library", libraryKey: "backup" } },
  };

  db = new Db(path.join(tmp, "key.db"));
  for (const library of config.libraries) await indexLibrary(db, library);
  scanId = (await scanCard(db, config, path.join(tmp, "card"), { label: "SD" })).scanId;
});

after(async () => {
  process.env.CAN_I_FORMAT_HOME = testHome;
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("renaming a library's key", () => {
  let renamed: AppConfig;
  let planBefore: Awaited<ReturnType<typeof planImport>>;

  before(async () => {
    planBefore = await planImport(db, config, scanId);
    renamed = renameLibraryKey(db, config, "backup", "offsite");
  });

  test("renames the library", () => {
    assert.deepEqual(
      renamed.libraries.map((l) => l.key),
      ["main", "offsite", "backup-2", "footage"],
    );
  });

  test("rewrites the main rule and the video rule", () => {
    assert.equal(renamed.rule, "main and offsite");
    assert.deepEqual(renamed.kinds.video, { mode: "rule", rule: "footage and offsite" });
  });

  test("points the import destination at the new key", () => {
    assert.deepEqual(renamed.import.destinations.photos, { mode: "library", libraryKey: "offsite" });
  });

  test("moves the library in the index, with its files", () => {
    assert.equal(db.getLibrary("backup"), undefined);
    const row = db.getLibrary("offsite");
    assert.ok(row);
    assert.equal(db.countEntries(row.id), 1);
  });

  test("renames past scans' matches, keeping each one an object", () => {
    const rows = db.allAs<{ matches: string; gap: string }>(
      "SELECT matches, gap FROM scan_file WHERE scan_id = ? ORDER BY name",
      scanId,
    );
    for (const row of rows) {
      const matches = JSON.parse(row.matches) as Record<string, { tier: string }>;
      assert.equal(matches.backup, undefined);
      assert.equal(typeof matches.offsite, "object");
    }
    const second = JSON.parse(rows[1]!.matches) as Record<string, { tier: string } | undefined>;
    assert.notEqual(second.offsite?.tier ?? "none", "none", "the frame on the backup drive is still matched there");
    assert.deepEqual(rows.map((r) => r.gap), ["offsite", "main"]);
  });

  test("renames past scans' rule and gap summary", () => {
    const scan = db.getAs<{ rule: string; stats: string }>("SELECT rule, stats FROM scan WHERE id = ?", scanId);
    assert.equal(scan?.rule, "main and offsite");
    const gaps = (JSON.parse(scan!.stats) as { gaps: Array<{ requirement: string }> }).gaps;
    assert.deepEqual(gaps.map((g) => g.requirement).sort(), ["main", "offsite"]);
  });

  test("an import from the old scan still knows what the library already holds", async () => {
    // The frame already on the backup drive must not be copied there again.
    const after = await planImport(db, renamed, scanId);
    assert.equal(planBefore.items.length, 1);
    assert.equal(after.items.length, planBefore.items.length);
    assert.deepEqual(
      after.items.map((i) => i.name),
      planBefore.items.map((i) => i.name),
    );
  });

  test("leaves a key that only starts the same alone", () => {
    assert.ok(db.getLibrary("backup-2"));
    assert.ok(renamed.libraries.some((l) => l.key === "backup-2"));
  });

  after(() => {
    // Back as it was, for the tests below.
    config = renameLibraryKey(db, renamed, "offsite", "backup");
  });
});

describe("a key that cannot be used", () => {
  for (const [to, why] of [
    ["main", /already/],
    ["and", /rules use/],
    ["Offsite", /lowercase/],
    ["", /empty/],
  ] as const) {
    test(`${JSON.stringify(to)} is refused, and nothing changes`, () => {
      assert.throws(() => renameLibraryKey(db, config, "backup", to), why);
      assert.ok(db.getLibrary("backup"));
      assert.equal(config.rule, "main and backup");
    });
  }
});

describe("through the app's API", () => {
  let server: StartedServer;

  before(async () => {
    await saveConfig(config);
    server = await startServer(db, await loadConfig());
  });
  after(() => server.close());

  const post = (key: string, body: unknown) =>
    fetch(`${server.url}/api/libraries/${key}/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("renames it, and saves the rules that changed with it", async () => {
    const res = await post("footage", { key: "clips" });
    assert.equal(res.status, 200);
    const state = (await res.json()) as { config: AppConfig };
    assert.equal(state.config.kinds.video?.mode === "rule" && state.config.kinds.video.rule, "clips and backup");

    const saved = await loadConfig();
    assert.ok(saved.libraries.some((l) => l.key === "clips"));
    assert.deepEqual(saved.kinds.video, { mode: "rule", rule: "clips and backup" });
  });

  test("says why a key is refused", async () => {
    const res = await post("clips", { key: "main" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /already/);
  });

  test("an unknown library is a 404", async () => {
    assert.equal((await post("nope", { key: "other" })).status, 404);
  });
});
