import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Db } from "../src/core/db.ts";
import { defaultConfig, defaultLibrary, saveConfig } from "../src/core/config.ts";
import { startServer, type StartedServer } from "../src/server/server.ts";
import { indexLibrary } from "../src/index/library.ts";
import { scanCard } from "../src/scan/card.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";
import { installDom, type FakeNode } from "./dom.ts";

/**
 * The front end, driven for real.
 *
 * Two bugs in a row got past code review because reading a UI is not the same
 * as running one: a banner whose `hidden` attribute did nothing because a CSS
 * rule outranked it, and a settings control that looked broken but was not.
 * This loads the actual `app.js` against the actual server, through a DOM
 * small enough to keep in one file, and clicks things.
 */


/** What `test/setup.ts` pointed us at, to hand back afterwards. */
const testHome = process.env.CAN_I_FORMAT_HOME;

let byId: Map<string, FakeNode>;
let server: StartedServer;
let db: Db;
let tmp: string;

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-ui-"));
  process.env.CAN_I_FORMAT_HOME = path.join(tmp, "home");

  const photos = path.join(tmp, "photos");
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
    port: 4188,
  };
  await saveConfig(config);
  db = new Db(path.join(tmp, "ui.db"));

  // A scan already in the history, so the recent list has a row to render.
  const card = path.join(tmp, "card", "DCIM", "100MSDCF");
  await fs.mkdir(card, { recursive: true });
  const frame = buildJpegWithExif(
    { make: "Sony", model: "ILCE-7RM5", dateTimeOriginal: "2024:05:01 09:10:00" },
    20_000,
    3,
  );
  await fs.writeFile(path.join(card, "A7203841.ARW"), frame);
  await fs.writeFile(path.join(photos, "A7203841.ARW"), frame);
  // A second card holding nothing worth checking — a freshly formatted one,
  // give or take the bookkeeping every removable volume carries.
  const bare = path.join(tmp, "bare");
  await fs.mkdir(bare, { recursive: true });
  await fs.writeFile(path.join(bare, "readme.txt"), "not a photograph");

  for (const lib of config.libraries) await indexLibrary(db, lib);
  await scanCard(db, config, bare, { label: "Empty SD" });
  await scanCard(db, config, path.join(tmp, "card"), { label: "CFexpress" });

  server = await startServer(db, config);

  byId = installDom().byId;

  const realFetch = globalThis.fetch;
  const origin = server.url;
  // Volumes are whatever happens to be plugged into the machine running the
  // tests, which is no basis for asserting what gets listed. One card and two
  // fixed disks, always.
  (globalThis as unknown as Record<string, unknown>).fetch = (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/volumes")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            volumes: [
              { path: "G:/", label: "CFexpress", looksLikeCard: true, marker: "DCIM", removable: true, totalBytes: 0 },
              { path: "C:/", label: "System", looksLikeCard: false, marker: null, removable: false, totalBytes: 0 },
              { path: "D:/", label: "Archive", looksLikeCard: false, marker: null, removable: false, totalBytes: 0 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return realFetch(url.startsWith("http") ? url : origin + url, options);
  };

  // Plain JavaScript with no types of its own; the point is to run it.
  await import("../src/web/app.js" as string);
  await settle();
});

after(async () => {
  // Restored rather than deleted: deleting it hands whatever runs next back
  // to the real installation.
  process.env.CAN_I_FORMAT_HOME = testHome;
  await server.close();
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** The three-button switch for a kind, by its visible label. */
function switchFor(title: string): FakeNode | undefined {
  for (const row of (byId.get("kind-rules") as FakeNode).children) {
    const name = row.children.find((c) => c.className === "kind-name");
    if (name?.textContent === title) return row.children.find((c) => c.className === "layout-switch");
  }
  return undefined;
}

const pressed = (title: string): string | undefined =>
  switchFor(title)?.children.find((b) => b.className.includes("is-on"))?.textContent;

const button = (title: string, text: string): FakeNode | undefined =>
  switchFor(title)?.children.find((b) => b.textContent === text);

describe("the video and audio controls", () => {
  test("both render, starting on the main rule", () => {
    assert.ok(switchFor("Video"), "expected a Video switch");
    assert.ok(switchFor("Audio"), "expected an Audio switch");
    assert.equal(pressed("Video"), "Same as photos");
  });

  test("clicking Ignore saves it and moves the highlight", async () => {
    button("Video", "Ignore")?.click();
    await settle();

    assert.equal(pressed("Video"), "Ignore", "the clicked option should be the highlighted one");
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      config: { kinds: Record<string, unknown> };
    };
    assert.deepEqual(state.config.kinds.video, { mode: "ignore" });
  });

  test("and says so", () => {
    assert.match((byId.get("toast") as FakeNode).textContent, /Video handling saved/);
  });

  test("the other kind is left alone", async () => {
    assert.equal(pressed("Audio"), "Same as photos");
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      config: { kinds: Record<string, unknown> };
    };
    assert.equal(state.config.kinds.audio, undefined);
  });

  test("switching back to the main rule clears the setting", async () => {
    button("Video", "Same as photos")?.click();
    await settle();

    assert.equal(pressed("Video"), "Same as photos");
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      config: { kinds: Record<string, unknown> };
    };
    assert.equal(state.config.kinds.video, undefined);
  });
});

describe("when the running app is older than the page", () => {
  test("a setting it silently ignored is reported, not announced as saved", async () => {
    // A server without this setting accepts the request, drops the part it
    // does not understand, and returns 200. The save then looks successful and
    // nothing changes — which is exactly what it looked like in the field.
    const realFetch = globalThis.fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = async (
      url: string,
      options?: RequestInit,
    ) => {
      const response = await realFetch(url, options);
      if (!url.includes("/api/config")) return response;
      const body = (await response.json()) as { config: Record<string, unknown> };
      delete body.config.kinds;
      return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
    };

    button("Video", "Ignore")?.click();
    await settle();
    (globalThis as unknown as Record<string, unknown>).fetch = realFetch;

    assert.match(
      (byId.get("toast") as FakeNode).textContent,
      /not applied.*restart/i,
      "the user has to be told the save did not take",
    );
  });
});

describe("cards and drives", () => {
  const listed = () =>
    (byId.get("volumes") as FakeNode).children.map(
      (c) => c.children.find((x) => x.className === "card-path")?.textContent,
    );

  test("only the card is listed, out of a card and two disks", () => {
    // A fixed disk is not what anyone opened this to look at, and on a machine
    // with several mounted it buries the one card that matters.
    assert.deepEqual(listed(), ["G:/"]);
  });

  test("the checkbox exists and remembers itself", () => {
    const box = byId.get("volumes-show-drives") as FakeNode;
    assert.ok(box.listeners.change?.length, "the checkbox has to do something");
  });

  test("ticking it shows the disks too", async () => {
    const box = byId.get("volumes-show-drives") as FakeNode;
    for (const fn of box.listeners.change ?? []) fn({ target: { checked: true } });
    await settle();
    assert.deepEqual(listed(), ["G:/", "C:/", "D:/"]);
  });

  test("and unticking hides them again", async () => {
    const box = byId.get("volumes-show-drives") as FakeNode;
    for (const fn of box.listeners.change ?? []) fn({ target: { checked: false } });
    await settle();
    assert.deepEqual(listed(), ["G:/"]);
  });
});

describe("the rules editor", () => {
  test("lives in a dialog rather than the dashboard", () => {
    const open = byId.get("rules-open") as FakeNode;
    assert.ok(open.listeners.click?.length, "the Rules button has to open something");
  });

  test("but the rule itself still shows on the dashboard", () => {
    const summary = byId.get("rule-summary") as FakeNode;
    const text = summary.children.map((c) => c.textContent).join("");
    assert.match(text, /Safe to erase when in/);
    assert.match(text, /photos/, "the rule in force should be readable without opening anything");
  });
});

describe("the delete control on a scan", () => {
  const row = () => (byId.get("recent") as FakeNode).children[0];

  test("the recent list rendered a scan", () => {
    assert.ok(row(), "expected the seeded scan to be listed");
    const label = row()?.children[0]?.children.find((c) => c.className === "recent-label");
    assert.equal(label?.textContent, "CFexpress");
  });

  test("delete is an icon, not a word", () => {
    const button = row()?.children.find((c) => c.className.includes("recent-delete"));
    assert.ok(button);
    assert.equal(button.textContent, "", "no visible text on the button");

    // An icon that renders nothing looks identical to a working one in source.
    const svg = button.children[0];
    assert.equal(svg?.tagName, "SVG");
    assert.ok(svg.children.length >= 4, "expected the trash can to have been drawn");
    assert.equal(svg.getAttribute("stroke"), "currentColor", "so it follows the theme");
  });

  test("but it still says what it does, for anyone not looking at it", () => {
    const button = row()?.children.find((c) => c.className.includes("recent-delete"));
    assert.match(button?.getAttribute("aria-label") ?? "", /Delete the scan of CFexpress/);
    assert.match(button?.getAttribute("title") ?? "", /Nothing on the card/);
  });
});

describe("a scan that found nothing to check", () => {
  /** The bare card, scanned before the CFexpress one so it is second in the list. */
  const row = () =>
    (byId.get("recent") as FakeNode).children.find((r) =>
      r.textContent.includes("Empty SD"),
    ) as FakeNode;

  test("is listed", () => {
    assert.ok(row(), "expected the bare card's scan to be listed");
  });

  test("does not claim files are blocked, because none are", () => {
    // It read "0 files blocked" — a count of zero next to the word blocked,
    // which is the one phrasing that cannot be true.
    const text = row().textContent;
    assert.equal(/blocked/.test(text), false, `said: ${text}`);
    assert.match(text, /nothing to check/);
  });

  test("and is not marked red", () => {
    const dot = row().children[0]?.children.find((c) => c.className.startsWith("dot"));
    assert.ok(dot);
    assert.equal(dot.className.includes("blocked"), false, "red means something would be lost");
    assert.ok(dot.className.includes("clear"), "there is nothing on it to lose");
  });

  test("as does the card that is fully backed up", () => {
    // Both are green, for different reasons. That red still appears when it
    // should is asserted where there is a genuinely blocked scan to look at —
    // see import-ui.test.ts.
    const backedUp = (byId.get("recent") as FakeNode).children.find((r) =>
      r.textContent.includes("CFexpress"),
    ) as FakeNode;
    const dot = backedUp.children[0]?.children.find((c) => c.className.startsWith("dot"));
    assert.ok(dot?.className.includes("clear"));
    assert.match(backedUp.textContent, /safe to format/);
  });
});

describe("a folder checked by hand", () => {
  const cards = () => (byId.get("volumes") as FakeNode).children;
  const cardFor = (label: string) =>
    cards().find((c) => c.children.find((x) => x.className === "card-title")?.textContent?.includes(label));

  test("is kept on the dashboard afterwards", async () => {
    // Somewhere worth checking once is worth checking again, and finding it
    // through a file picker every time is how that stops happening.
    const folder = path.join(tmp, "photos");
    const state = (await (
      await fetch(`${server.url}/api/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folder }),
      })
    ).json()) as { config: { savedFolders: Array<{ path: string; label: string }> } };

    assert.equal(state.config.savedFolders.length, 1);
    assert.equal(state.config.savedFolders[0]?.label, "photos");
  });

  test("and appears as a card once the page refreshes", async () => {
    for (const fn of (byId.get("volumes-refresh") as FakeNode).listeners.click ?? []) fn({});
    await settle();
    await settle();

    const card = cardFor("photos");
    assert.ok(card, "the saved folder should be listed");
    assert.ok(card.className.includes("is-saved"));
  });

  test("with a remove control before its name, not a word", () => {
    const remove = cardFor("photos")?.children[0];
    assert.ok(remove, "expected a remove control");
    assert.ok(remove.className.includes("card-remove"), "the control comes first, so it sits top-left");
    assert.equal(remove.textContent, "");
    assert.equal(remove.children[0]?.tagName, "SVG");
    assert.match(remove.getAttribute("aria-label") ?? "", /Remove photos/);
  });

  test("removing it takes it off the dashboard and out of the config", async () => {
    const remove = cardFor("photos")?.children[0];
    assert.ok(remove);
    remove.click();
    await settle();

    assert.equal(cardFor("photos"), undefined, "gone from the view");
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      config: { savedFolders: unknown[] };
    };
    assert.deepEqual(state.config.savedFolders, [], "and gone from the config");
  });

  test("a folder that is not a folder is refused", async () => {
    const response = await fetch(`${server.url}/api/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(tmp, "does-not-exist") }),
    });
    assert.equal(response.status, 400);
  });
});

describe("a library's key", () => {
  const libraries = () => byId.get("libraries") as FakeNode;
  const keyButton = (key: string) =>
    libraries().descendants.find(
      (n) => n.tagName === "BUTTON" && n.className === "library-key" && n.textContent === key,
    );
  const keyInput = () => libraries().descendants.find((n) => n.className === "library-key-input");
  const ruleText = () =>
    (byId.get("rule-summary") as FakeNode).children.map((c) => c.textContent).join("");

  test("is a control, not just a label", () => {
    assert.ok(keyButton("photos"), "the key should be clickable");
  });

  test("clicking it opens it for editing, and Escape puts it back", async () => {
    keyButton("photos")?.click();
    const input = keyInput();
    assert.ok(input, "an input should replace the key");
    assert.equal(input.value, "photos");

    input.fire("keydown", { key: "Escape" });
    await settle();
    assert.equal(keyInput(), undefined);
    assert.ok(keyButton("photos"));
  });

  test("Enter renames it, and the rule on the dashboard follows", async () => {
    keyButton("photos")?.click();
    const input = keyInput();
    assert.ok(input);
    input.value = "pictures";
    input.fire("keydown", { key: "Enter" });
    await settle();

    assert.ok(keyButton("pictures"), "the new key is shown");
    assert.match(ruleText(), /pictures/);
    assert.doesNotMatch(ruleText(), /\bphotos\b/);

    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      config: { rule: string; libraries: Array<{ key: string }> };
    };
    assert.equal(state.config.rule, "pictures");
    assert.ok(state.config.libraries.some((l) => l.key === "pictures"));
  });

  test("a key that can't be used is refused, and the field stays open to fix it", async () => {
    keyButton("pictures")?.click();
    const input = keyInput();
    assert.ok(input);
    input.value = "footage";
    input.fire("keydown", { key: "Enter" });
    await settle();

    assert.ok(keyInput(), "still editing");
    assert.match((byId.get("toast") as FakeNode).textContent, /already/);
    input.fire("keydown", { key: "Escape" });
    await settle();
  });
});
