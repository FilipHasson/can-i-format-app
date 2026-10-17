import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { cacheDir, configDir, configFile, dbFile } from "../src/core/paths.ts";

/**
 * That the tests are not pointed at the real installation.
 *
 * `test/setup.ts` redirects the application directory into a temporary one, and
 * this is what proves it took effect — in this process, which is a child the
 * test runner spawned, and therefore that the `--import` flag reaches children
 * at all. Everything resolving through `core/paths.ts` follows from these four:
 * the index, the configuration, the preview cache and the catalog copies.
 *
 * If this file fails, the rest of the suite is writing into whatever install
 * the machine has. `readThumbnail` alone would fill a real preview cache with
 * fixtures, and one careless `openDb()` would be editing a real index.
 */

describe("tests are isolated from a real installation", () => {
  const home = process.env.CAN_I_FORMAT_HOME;

  test("an app directory has been set for us", () => {
    assert.ok(home, "CAN_I_FORMAT_HOME is unset — is --import ./test/setup.ts still in the test script?");
  });

  test("and it is a temporary one", () => {
    const real = path.resolve(os.tmpdir());
    assert.ok(
      path.resolve(configDir()).startsWith(real),
      `config directory ${configDir()} is outside ${real}`,
    );
  });

  test("so the index, config and caches all live there too", () => {
    const root = path.resolve(configDir());
    for (const [name, target] of [
      ["index", dbFile()],
      ["config", configFile()],
      ["cache", cacheDir()],
    ] as const) {
      assert.ok(path.resolve(target).startsWith(root), `${name} at ${target} escapes ${root}`);
    }
  });

  test("and reaching for the real one from a test is refused outright", () => {
    // The npm script is not the guard — an ad-hoc `node --test some.test.ts`
    // skips it, and that is exactly how a real preview cache once got filled
    // with fixtures. `paths.ts` refuses instead, so the mistake cannot be made
    // however the tests are launched.
    const saved = process.env.CAN_I_FORMAT_HOME;
    delete process.env.CAN_I_FORMAT_HOME;
    try {
      assert.throws(() => configDir(), /CAN_I_FORMAT_HOME|npm test/);
    } finally {
      process.env.CAN_I_FORMAT_HOME = saved;
    }
  });

  test("nowhere near where a real install would put them", () => {
    // The exact directory a run of the app would use, computed the way
    // paths.ts does it but without the override.
    const homeDir = os.homedir();
    const realish =
      process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "can-i-format")
        : process.platform === "darwin"
          ? path.join(homeDir, "Library", "Application Support", "can-i-format")
          : path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "can-i-format");

    assert.notEqual(path.resolve(configDir()), path.resolve(realish));
  });
});
