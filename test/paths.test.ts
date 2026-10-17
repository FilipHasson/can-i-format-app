import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { joinPath } from "../src/core/paths.ts";

/**
 * A whole card is checked from its drive root, and `G:/` + `/DCIM` is
 * `G://DCIM`. Windows opens that; exifr reads the `://` as a URL and fails,
 * which silently cost every file on such a card its capture time.
 */
describe("joining a path", () => {
  test("from a drive root does not double the separator", () => {
    assert.equal(joinPath("G:/", "DCIM"), "G:/DCIM");
  });

  test("from a folder adds one", () => {
    assert.equal(joinPath("G:/DCIM", "100MSDCF"), "G:/DCIM/100MSDCF");
  });

  test("from the POSIX root does not double it either", () => {
    assert.equal(joinPath("/", "Volumes"), "/Volumes");
  });

  test("never produces something that reads as a URL", () => {
    assert.ok(!joinPath(joinPath("G:/", "DCIM"), "A9309826.ARW").includes("//"));
  });
});
