import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveDirent } from "../src/core/dirent.ts";
import { walk } from "../src/index/walk.ts";

/**
 * What `readdir` says an entry is, versus what it is.
 *
 * On Windows anything carrying a reparse point comes back from `readdir` as a
 * symlink whether or not it is one, and OneDrive's Files On-Demand root is
 * exactly that. Taking the first answer made a OneDrive folder invisible to
 * the picker and unwalkable by the indexer, so a library kept in one indexed as
 * empty with nothing to say why.
 */

let tmp: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-dirent-"));
  await fs.mkdir(path.join(tmp, "folder"));
  await fs.writeFile(path.join(tmp, "file.jpg"), "x");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const direntFor = async (dir: string, name: string) => {
  const found = (await fs.readdir(dir, { withFileTypes: true })).find((d) => d.name === name);
  assert.ok(found, `${name} not found in ${dir}`);
  return found;
};

/**
 * A directory that `readdir` calls a link and `lstat` does not — a reparse
 * point. Only Windows machines with a cloud folder have one, so the tests that
 * need it say when they had to skip.
 */
async function findReparsePoint(): Promise<string | null> {
  const home = os.homedir();
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const full = path.join(home, entry.name);
    const link = await fs.lstat(full).catch(() => null);
    const real = await fs.stat(full).catch(() => null);
    if (link && real && !link.isSymbolicLink() && real.isDirectory()) return full;
  }
  return null;
}

describe("ordinary entries", () => {
  test("a directory is a directory", async () => {
    assert.equal(await resolveDirent(tmp, await direntFor(tmp, "folder")), "directory");
  });

  test("a file is a file", async () => {
    assert.equal(await resolveDirent(tmp, await direntFor(tmp, "file.jpg")), "file");
  });
});

describe("a directory readdir calls a link", () => {
  test("resolves as the directory it is", async (t) => {
    const reparse = await findReparsePoint();
    if (!reparse) {
      t.skip("no cloud folder on this machine to test against");
      return;
    }

    const parent = path.dirname(reparse);
    const dirent = await direntFor(parent, path.basename(reparse));
    assert.equal(dirent.isDirectory(), false, "readdir should be the thing getting it wrong");
    assert.equal(dirent.isSymbolicLink(), true);

    assert.equal(await resolveDirent(parent, dirent), "directory");
  });

  test("and the walker goes into it", async (t) => {
    const reparse = await findReparsePoint();
    if (!reparse) {
      t.skip("no cloud folder on this machine to test against");
      return;
    }

    // Bounded: enough to prove it descended, without walking someone's whole
    // cloud drive to find out.
    const controller = new AbortController();
    let directories = 0;
    try {
      await walk(reparse, { signal: controller.signal }, () => {
        directories++;
        if (directories >= 5) controller.abort();
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    }

    assert.ok(directories > 1, "a library kept in a cloud folder has to be walkable");
  });
});
