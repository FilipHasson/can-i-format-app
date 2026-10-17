import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isInternalUrl,
  isSafeExternal,
  parseWindowState,
  placeWindow,
  type DisplayArea,
} from "../electron/policy.ts";

/**
 * The desktop shell's decisions, checked without launching one. Everything
 * here is reachable from a page that can already read the filesystem through
 * its API, so "it looked right when I ran it" is not the standard.
 */

const ORIGIN = "http://127.0.0.1:4111";

describe("what the window is allowed to navigate to", () => {
  test("its own origin, and nothing that merely resembles it", () => {
    assert.equal(isInternalUrl(`${ORIGIN}/`, ORIGIN), true);
    assert.equal(isInternalUrl(`${ORIGIN}/api/scans/3`, ORIGIN), true);

    // A different port is a different server. Something else on the machine
    // is still something else.
    assert.equal(isInternalUrl("http://127.0.0.1:4112/", ORIGIN), false);
    assert.equal(isInternalUrl("http://localhost:4111/", ORIGIN), false);
    assert.equal(isInternalUrl("https://127.0.0.1:4111/", ORIGIN), false);

    // The classic near-miss: a host that starts with the right characters.
    assert.equal(isInternalUrl("http://127.0.0.1:4111.example.com/", ORIGIN), false);
    assert.equal(isInternalUrl("http://evil.com/http://127.0.0.1:4111", ORIGIN), false);
  });

  test("nothing that is not a URL at all", () => {
    assert.equal(isInternalUrl("", ORIGIN), false);
    assert.equal(isInternalUrl("/api/state", ORIGIN), false);
    assert.equal(isInternalUrl("not a url", ORIGIN), false);
  });
});

describe("what may be handed to the operating system", () => {
  test("pages, and nothing that opens a program", () => {
    assert.equal(isSafeExternal("https://example.com/docs"), true);
    assert.equal(isSafeExternal("http://example.com"), true);
    assert.equal(isSafeExternal("mailto:someone@example.com"), true);
  });

  test("a local path is refused, however it is dressed up", () => {
    // `shell.openExternal` on a file: URL runs it through whatever is
    // registered for that type, which for a .bat or a .lnk is not a viewer.
    assert.equal(isSafeExternal("file:///C:/Windows/System32/cmd.exe"), false);
    assert.equal(isSafeExternal("file://server/share/run.bat"), false);
    assert.equal(isSafeExternal("javascript:alert(1)"), false);
    assert.equal(isSafeExternal("ms-msdt:/id"), false);
    assert.equal(isSafeExternal("search-ms:query=x"), false);
    assert.equal(isSafeExternal("data:text/html,<script>"), false);
    assert.equal(isSafeExternal("nonsense"), false);
  });
});

describe("putting the window back where it was", () => {
  const laptop: DisplayArea = { x: 0, y: 0, width: 2560, height: 1400 };
  const second: DisplayArea = { x: 2560, y: 0, width: 1920, height: 1080 };
  const size = { width: 1180, height: 820 };

  test("with nothing remembered, the default and no position", () => {
    const placed = placeWindow(null, [laptop], size);
    assert.deepEqual(placed, { width: 1180, height: 820 });
  });

  test("a remembered position on a screen that is still there is kept", () => {
    const placed = placeWindow({ x: 2700, y: 120, width: 1000, height: 700 }, [laptop, second], size);
    assert.deepEqual(placed, { x: 2700, y: 120, width: 1000, height: 700 });
  });

  test("and is dropped when that screen is gone", () => {
    // The second monitor was unplugged. Honouring this would open the window
    // somewhere there is no longer a screen: running, focused, invisible.
    const placed = placeWindow({ x: 2700, y: 120, width: 1000, height: 700 }, [laptop], size);
    assert.deepEqual(placed, { width: 1000, height: 700 }, "size survives, position does not");
  });

  test("a sliver still on screen is enough to grab and drag back", () => {
    const placed = placeWindow({ x: -880, y: 40, width: 1000, height: 700 }, [laptop], size);
    assert.equal(placed.x, -880, "120px of it is visible");

    const gone = placeWindow({ x: -960, y: 40, width: 1000, height: 700 }, [laptop], size);
    assert.equal(gone.x, undefined, "40px is not");
  });

  test("a size from a much larger screen is brought back to something usable", () => {
    const placed = placeWindow({ width: 40, height: 12 }, [laptop], size);
    assert.equal(placed.width, 720);
    assert.equal(placed.height, 520);
  });

  test("maximised is remembered, and carries its restored size with it", () => {
    const placed = placeWindow(
      { x: 10, y: 10, width: 1000, height: 700, maximized: true },
      [laptop],
      size,
    );
    assert.equal(placed.maximized, true);
    assert.equal(placed.width, 1000, "so restoring down gives back the window that was there");
  });

  test("nonsense in the file is ignored rather than obeyed", () => {
    const placed = placeWindow({ x: Number.NaN, y: 0, width: 1000, height: 700 }, [laptop], size);
    assert.equal(placed.x, undefined);
  });
});

describe("reading the saved geometry back", () => {
  test("keeps the numbers and nothing else", () => {
    const state = parseWindowState('{"x":1,"y":2,"width":3,"height":4,"maximized":true}');
    assert.deepEqual(state, { x: 1, y: 2, width: 3, height: 4, maximized: true });
  });

  test("a file that is not geometry produces nothing to act on", () => {
    assert.equal(parseWindowState("not json"), null);
    assert.equal(parseWindowState("null"), null);
    assert.equal(parseWindowState('"a string"'), null);
    assert.deepEqual(parseWindowState('{"x":"10","width":900}'), { width: 900 });
    assert.deepEqual(parseWindowState('{"width":null}'), {});
  });
});
