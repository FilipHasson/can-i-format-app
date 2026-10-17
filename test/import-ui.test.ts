import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, loadConfig, saveConfig } from "../src/core/config.ts";
import { startServer, type StartedServer } from "../src/server/server.ts";
import { indexLibrary } from "../src/index/library.ts";
import { scanCard } from "../src/scan/card.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";
import { installDom, type FakeNode } from "./dom.ts";

/**
 * The import dialog, clicked rather than read.
 *
 * The engine is tested against the filesystem elsewhere. What is in question
 * here is the wiring: that the button appears on a blocked scan, that opening
 * the dialog really asks the server what would happen, that changing the
 * layout re-plans, and — the one that matters — that the confirm button stays
 * disabled until there is a plan that can actually run.
 */

let byId: Map<string, FakeNode>;
/** Creates on demand, the way the real page has the element already. */
let $: (id: string) => FakeNode;
let server: StartedServer;
let db: Db;
let tmp: string;
let photos: string;


const settle = () => new Promise((resolve) => setTimeout(resolve, 350));

/**
 * Click handlers are async, so anything they throw becomes an unhandled
 * rejection and the test just sees a control that did nothing. Surfacing them
 * is the difference between a failure that names itself and half an hour.
 */
const crashes: unknown[] = [];
process.on("unhandledRejection", (err) => crashes.push(err));

/** What `test/setup.ts` pointed us at, to hand back afterwards. */
const testHome = process.env.CAN_I_FORMAT_HOME;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-import-ui-"));
  process.env.CAN_I_FORMAT_HOME = path.join(tmp, "home");

  photos = path.join(tmp, "photos");
  const footage = path.join(tmp, "footage");
  await fs.mkdir(photos, { recursive: true });
  await fs.mkdir(footage, { recursive: true });

  const config = {
    ...defaultConfig(),
    setupComplete: true,
    rule: "photos",
    libraries: [
      defaultLibrary({ path: photos, key: "photos", label: "Photos" }),
      defaultLibrary({ path: footage, key: "footage", label: "Footage" }),
    ],
    // Not 4190: that one is on the blocked-ports list and fetch refuses it.
    port: 4189,
  };
  await saveConfig(config);
  db = new Db(path.join(tmp, "import-ui.db"));

  // A card holding one frame that is nowhere in the libraries, so the scan is
  // blocked and there is something to import.
  const card = path.join(tmp, "card", "DCIM", "100MSDCF");
  await fs.mkdir(card, { recursive: true });
  await fs.writeFile(
    path.join(card, "A7203841.ARW"),
    buildJpegWithExif(
      { make: "Sony", model: "ILCE-7RM5", dateTimeOriginal: "2024:05:01 09:10:00" },
      20_000,
      3,
    ),
  );
  for (const lib of config.libraries) await indexLibrary(db, lib);
  const scan = await scanCard(db, config, path.join(tmp, "card"), { label: "CFexpress" });
  assert.equal(scan.verdict.status, "unsafe", "the fixture card has to start out blocked");

  server = await startServer(db, config);
  ({ byId, $ } = installDom());

  const realFetch = globalThis.fetch;
  const origin = server.url;
  (globalThis as unknown as Record<string, unknown>).fetch = (
    url: string,
    options?: RequestInit,
  ) => {
    if (url.startsWith("/api/volumes")) {
      return Promise.resolve(
        new Response(JSON.stringify({ volumes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return realFetch(url.startsWith("http") ? url : origin + url, options);
  };

  await import("../src/web/app.js" as string);
  await settle();
});

after(async () => {
  // Restored, not deleted: deleting it hands the rest of the process back to
  // the real installation.
  process.env.CAN_I_FORMAT_HOME = testHome;
  await server.close();
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Opens the most recent scan and then the import dialog on it, by clicking. */
async function openTheDialog(): Promise<void> {
  const row = $("recent").descendants.find((n) => n.className.includes("recent-open"));
  assert.ok(row, "the scan from before() should be in the recent list");
  row.click();
  await settle();

  // The button, not the div wrapping it — a container's textContent reads the
  // same and clicking it does nothing at all.
  const button = $("verdict").descendants.find(
    (n) => n.tagName === "BUTTON" && n.textContent.startsWith("Import the"),
  );
  assert.ok(button, "a blocked scan should offer a way to import");
  button.click();
  await settle();
}

describe("a card that really is missing files", () => {
  test("is red in the recent list, and says how many", () => {
    // The counterpart to ui.test.ts: red has to still mean something once
    // an empty card stopped using it.
    const row = $("recent").children[0];
    assert.ok(row, "expected the seeded scan to be listed");

    const dot = row.children[0]?.children.find((c) => c.className.startsWith("dot"));
    assert.ok(dot?.className.includes("blocked"), `dot was: ${dot?.className}`);
    assert.match(row.textContent, /1 files? blocked/);
  });
});

describe("the import dialog", () => {
  before(openTheDialog);

  test("opens from the verdict of a blocked scan", () => {
    assert.deepEqual(crashes, [], "opening the dialog threw");
    assert.ok($("import").open, "the dialog should be showing");
  });

  test("offers a row for each kind of media, with the libraries as choices", () => {
    const rows = $("import-groups").children;
    assert.equal(rows.length, 3, "photos, video and audio");

    const selects = $("import-groups").descendants.filter((n) => n.tagName === "SELECT");
    const options = selects[0]?.children.map((o) => o.textContent) ?? [];
    assert.ok(options.includes("Photos"), "a configured library is a destination");
    assert.ok(options.includes("Footage"));
    assert.ok(options.includes("Leave on the card"));
  });

  test("nothing can be copied until a destination is chosen", () => {
    // Everything defaults to staying on the card, so there is no plan yet and
    // the button must not invite a click that would do nothing.
    assert.equal($("import-go").disabled, true);
  });

  test("the folder layout starts from the saved template", () => {
    assert.equal($("import-folder").value, "{YYYY}/{YYYY}-{MM}-{DD}");
  });

  test("and shows what it does to a real file straight away", () => {
    // Before any destination is chosen — which is exactly when someone is
    // deciding whether the template says what they want.
    assert.match($("import-example").textContent, /2024\/2024-05-01\/A7203841\.ARW/);
  });

  test("the tokens are offered as buttons, not left to be guessed", () => {
    const chips = $("import-chips").children.map((c) => c.textContent);
    assert.ok(chips.includes("{YYYY}"));
    assert.ok(chips.includes("{MM}"));
    assert.ok(chips.includes("{camera}"));
  });
});

describe("typing a layout of your own", () => {
  before(async () => {
    // Year, then month-day-year — a real layout, and not one of the presets
    // until it was added as one.
    $("import-folder").value = "{YYYY}/{MM}-{DD}-{YYYY}";
    $("import-folder").fire("input");
    await settle();
  });

  test("the example follows it as it is typed", () => {
    assert.match($("import-example").textContent, /2024\/05-01-2024\/A7203841\.ARW/);
  });

  test("a case slip is named rather than silently rejected", async () => {
    $("import-folder").value = "{yyyy}/{MM}-{DD}";
    $("import-folder").fire("input");
    await settle();

    const shown = $("import-example").textContent;
    assert.match(shown, /\{yyyy\}/, `said: ${shown}`);
    assert.match(shown, /did you mean \{YYYY\}/i, `said: ${shown}`);
  });

  test("and a word that is not a token at all just says so", async () => {
    $("import-folder").value = "{month}";
    $("import-folder").fire("input");
    await settle();

    const shown = $("import-example").textContent;
    assert.match(shown, /\{month\} is not a token/);
    assert.equal(/did you mean/i.test(shown), false, "there is nothing to suggest");
  });

  test("clicking a token adds it to the field", async () => {
    $("import-folder").value = "{YYYY}";
    $("import-folder").fire("input");
    await settle();

    const chip = $("import-chips").children.find((c) => c.textContent === "{MM}");
    assert.ok(chip);
    chip.click();
    await settle();

    assert.equal($("import-folder").value, "{YYYY}{MM}");
  });
});

describe("choosing where photos go", () => {
  before(async () => {
    // Set what this asserts rather than inheriting whatever the block above
    // left in the field.
    $("import-folder").value = "{YYYY}/{YYYY}-{MM}-{DD}";
    $("import-folder").fire("input");
    await settle();

    const select = $("import-groups").descendants.find((n) => n.tagName === "SELECT");
    assert.ok(select);
    select.value = "photos";
    select.fire("change");
    await settle();
  });

  test("plans the copy and says exactly where the file lands", () => {
    const shown = $("import-preview").textContent;
    assert.match(shown, /2024\/2024-05-01\/A7203841\.ARW/, `preview said: ${shown}`);
  });

  test("and the button now offers to do it", () => {
    assert.equal($("import-go").disabled, false);
    assert.match($("import-go").textContent, /Copy 1 file/);
  });

  test("the choice is saved, so the next card starts from it", async () => {
    const saved = await loadConfig();
    assert.deepEqual(saved.import.destinations.photos, { mode: "library", libraryKey: "photos" });
  });
});

describe("changing the layout re-plans", () => {
  before(async () => {
    $("import-folder").value = "{YYYY}/{MM}/{DD}";
    $("import-folder").fire("input");
    await settle();
  });

  test("the preview follows the template", () => {
    assert.match($("import-preview").textContent, /2024\/05\/01\/A7203841\.ARW/);
  });

  test("a template with a token that means nothing is refused, not guessed at", async () => {
    $("import-folder").value = "{month}/{YYYY}";
    $("import-folder").fire("input");
    await settle();

    assert.match($("import-preview").textContent, /\{month\}/);
    assert.equal($("import-go").disabled, true, "and it cannot be run");
  });
});

describe("actually running it", () => {
  before(async () => {
    $("import-folder").value = "{YYYY}/{YYYY}-{MM}-{DD}";
    $("import-folder").fire("input");
    await settle();

    $("import-go").click();
    // The copy, the re-index and the re-scan all run inside one job.
    for (let i = 0; i < 40; i++) {
      await settle();
      const jobs = (await (await fetch("/api/jobs")).json()) as { active: unknown };
      if (!jobs.active) break;
    }
  });

  test("copies the file into the library, filed by capture date", async () => {
    const landed = path.join(photos, "2024", "2024-05-01", "A7203841.ARW");
    assert.ok(await fs.stat(landed).then(() => true, () => false), `${landed} should exist`);
  });

  test("and the card is left exactly as it was", async () => {
    const onCard = await fs.readdir(path.join(tmp, "card", "DCIM", "100MSDCF"));
    assert.deepEqual(onCard, ["A7203841.ARW"]);
  });

  test("the follow-up scan says the card is now safe", async () => {
    const { scans } = (await (await fetch("/api/scans")).json()) as {
      scans: Array<{ stats: string | null }>;
    };
    const latest = JSON.parse(scans[0]?.stats ?? "{}") as { status?: string };
    assert.equal(latest.status, "safe", "the whole point of the round trip");
  });
});
