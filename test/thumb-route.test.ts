import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { normPath } from "../src/core/paths.ts";

/**
 * The preview endpoint checks that the file it is about to read really is
 * inside the scan it belongs to. That check has to hold for the roots people
 * actually scan — and the first one they scan is a whole card.
 */

/** Exactly the containment test the route performs. */
function contains(scanRoot: string, relDir: string, name: string): boolean {
  const root = normPath(scanRoot).replace(/\/+$/, "");
  const dir = relDir === "" ? root : `${root}/${relDir}`;
  const absolute = normPath(`${dir}/${name}`);
  return absolute === root || absolute.startsWith(`${root}/`);
}

describe("a file is inside the scan it came from", () => {
  test("when the whole card was scanned", () => {
    // The case that broke it: normPath("I:\\") is "I:/", so a naive prefix of
    // "I://" matched nothing and every preview on the card 404'd.
    assert.ok(contains(`I:${path.sep}`, "DCIM/10160325", "A7203841.ARW"));
  });

  test("when a folder on the card was scanned", () => {
    assert.ok(contains(`I:${path.sep}DCIM`, "10160325", "A7203841.ARW"));
  });

  test("when the file sits at the root of the scan", () => {
    assert.ok(contains(`I:${path.sep}DCIM${path.sep}10160325`, "", "A7203841.ARW"));
  });

  test("and a trailing separator changes nothing", () => {
    const withSlash = contains(`I:${path.sep}DCIM${path.sep}`, "10160325", "A7203841.ARW");
    const without = contains(`I:${path.sep}DCIM`, "10160325", "A7203841.ARW");
    assert.equal(withSlash, without);
    assert.ok(without);
  });
});

describe("a file that is not", () => {
  test("climbing out with .. is refused", () => {
    assert.equal(contains(`I:${path.sep}DCIM`, "../../Windows/System32", "config.sys"), false);
  });

  test("a sibling folder with a shared prefix is not inside", () => {
    // "I:/DCIM-backup" starts with "I:/DCIM", which is why the check compares
    // against the separator rather than the bare prefix.
    assert.equal(contains(`I:${path.sep}DCIM`, "", "../DCIM-backup/A7203841.ARW"), false);
  });
});
