import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Keeps the tests away from the real installation.
 *
 * Loaded with `--import` from the test script, so it runs before any test
 * module is evaluated — including in the child process the runner spawns per
 * file. That timing is the point: `configDir()` reads this variable at call
 * time, but a test that reaches a cache path during module evaluation would
 * beat any `before()` hook.
 *
 * Without it, anything resolving through `core/paths.ts` lands in the user's
 * own application directory: `readThumbnail` writes into their preview cache,
 * indexing a catalog leaves copies in it, and a test that ever called
 * `openDb()` or `saveConfig()` with no argument would be writing over the
 * index and configuration of a working install. The last of those has not
 * happened yet, which is exactly why it is worth making impossible rather than
 * remembering not to do.
 *
 * An already-set value is honoured, so a single test can still point somewhere
 * of its own.
 */
if (!process.env.CAN_I_FORMAT_HOME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "can-i-format-test-home-"));
  process.env.CAN_I_FORMAT_HOME = dir;

  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp directory that outlives the run is untidy, not a failure.
    }
  });
}
