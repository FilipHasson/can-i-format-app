import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * GPLv3 section 5(d): an interactive program shows its legal notices, and a
 * modified version has to keep showing them. These hold that in place.
 */

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("the licence", () => {
  test("is the GPL, version 3, in full", () => {
    const license = read("LICENSE");
    assert.match(license, /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
    assert.match(license, /END OF TERMS AND CONDITIONS/);
  });

  test("is declared in package.json as GPL-3.0-only", () => {
    assert.equal(JSON.parse(read("package.json")).license, "GPL-3.0-only");
  });
});

describe("the app's footer", () => {
  const html = read("src/web/index.html");
  const footer = html.match(/<footer class="app-foot">[\s\S]*?<\/footer>/)?.[0] ?? "";

  test("is there", () => {
    assert.ok(footer, "no footer in src/web/index.html");
  });

  test("carries the copyright", () => {
    assert.match(footer, /© \d{4} Filip Hasson/);
  });

  test("says it is GPL software with no warranty", () => {
    assert.match(footer, /GNU General Public License\s+v3/);
    assert.match(footer, /no warranty/);
  });

  test("says where to read the licence and get the source", () => {
    assert.match(footer, /href="https:\/\/www\.gnu\.org\/licenses\/gpl-3\.0\.html"/);
    assert.match(footer, /href="https:\/\/github\.com\/FilipHasson\/can-i-format-app"/);
  });
});
