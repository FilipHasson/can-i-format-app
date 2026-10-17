import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRollup, type ScanFileRecord } from "../src/scan/verdict.ts";

function file(partial: Partial<ScanFileRecord> & { relDir: string; name: string }): ScanFileRecord {
  return {
    required: true,
    size: 1000,
    satisfied: true,
    gap: "",
    ...partial,
  };
}

describe("directory rollup", () => {
  test("counts roll up through every ancestor", () => {
    const { tree, verdict } = buildRollup([
      file({ relDir: "DCIM/100EOSR5", name: "a.jpg" }),
      file({ relDir: "DCIM/100EOSR5", name: "b.jpg", satisfied: false, gap: "backup" }),
      file({ relDir: "DCIM/101EOSR5", name: "c.jpg" }),
    ]);

    assert.equal(tree.totalFiles, 3);
    assert.equal(tree.blocked, 1);
    assert.equal(verdict.status, "unsafe");

    const dcim = tree.children.find((c) => c.name === "DCIM");
    assert.ok(dcim);
    assert.equal(dcim.totalFiles, 3);
    assert.equal(dcim.blocked, 1);
    assert.equal(dcim.status, "partial");

    const clear = dcim.children.find((c) => c.name === "101EOSR5");
    assert.equal(clear?.status, "clear");
  });

  test("a fully unmatched folder reads as blocked, not partial", () => {
    const { tree } = buildRollup([
      file({ relDir: "DCIM/104GOPRO", name: "a.mp4", satisfied: false, gap: "main and backup" }),
      file({ relDir: "DCIM/104GOPRO", name: "b.mp4", satisfied: false, gap: "main and backup" }),
    ]);

    const folder = tree.children[0]?.children[0];
    assert.equal(folder?.name, "104GOPRO");
    assert.equal(folder?.status, "blocked");
  });

  test("sidecars and junk never make a card unsafe", () => {
    const { verdict } = buildRollup([
      file({ relDir: "DCIM/100EOSR5", name: "a.jpg" }),
      file({ relDir: "DCIM/100EOSR5", name: "a.thm", required: false, satisfied: false }),
    ]);

    assert.equal(verdict.status, "safe");
    assert.equal(verdict.totalFiles, 2);
    assert.equal(verdict.requiredFiles, 1);
    assert.equal(verdict.blocked, 0);
  });

  test("blocked directories are reported by the folder that holds them", () => {
    const { verdict } = buildRollup([
      file({ relDir: "DCIM/100EOSR5", name: "a.jpg" }),
      file({ relDir: "DCIM/101EOSR5", name: "b.jpg", satisfied: false, gap: "backup", size: 500 }),
      file({ relDir: "DCIM/101EOSR5", name: "c.jpg", satisfied: false, gap: "backup", size: 700 }),
    ]);

    assert.equal(verdict.blockedDirs.length, 1);
    assert.deepEqual(verdict.blockedDirs[0], {
      path: "DCIM/101EOSR5",
      count: 2,
      bytes: 1200,
    });
  });

  test("gaps are tallied so the fix is obvious at a glance", () => {
    const { verdict } = buildRollup([
      file({ relDir: "a", name: "1.jpg", satisfied: false, gap: "backup" }),
      file({ relDir: "a", name: "2.jpg", satisfied: false, gap: "backup" }),
      file({ relDir: "b", name: "3.jpg", satisfied: false, gap: "main and backup" }),
    ]);

    assert.deepEqual(verdict.gaps, [
      { requirement: "backup", count: 2 },
      { requirement: "main and backup", count: 1 },
    ]);
  });

  test("a card with nothing that needs matching is neither safe nor unsafe", () => {
    const { verdict } = buildRollup([
      file({ relDir: "", name: "readme.txt", required: false, satisfied: false }),
    ]);
    assert.equal(verdict.status, "empty");
  });
});
