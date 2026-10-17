import path from "node:path";
import os from "node:os";

/**
 * Windows and macOS both default to case-insensitive filesystems. We keep the
 * original casing for display but compare on a folded key, otherwise the same
 * file indexed from two differently-cased roots looks like two files.
 */
export const CASE_INSENSITIVE_FS =
  process.platform === "win32" || process.platform === "darwin";

/** Absolute path with forward slashes, so stored paths compare consistently. */
export function normPath(p: string): string {
  return path.resolve(p).split(path.sep).join("/");
}

/**
 * A child of a directory. Not a template string: a drive root normalises to
 * `G:/`, and `${dir}/${name}` from there is `G://DCIM`. Windows opens that
 * without complaint, but exifr reads `://` as a URL and fails — which, with
 * the error swallowed, meant no card checked from its root ever had a single
 * capture time read, and name-and-size coincidences went unchallenged.
 */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Comparison key for a path. Never show this to the user. */
export function pathKey(p: string): string {
  const n = normPath(p);
  return CASE_INSENSITIVE_FS ? n.toLowerCase() : n;
}

/** Lowercased extension without the leading dot. `""` when there is none. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Basename without extension, lowercased — used for filename-tier matching. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot <= 0 ? name : name.slice(0, dot);
  return base.toLowerCase();
}

export function configDir(): string {
  const override = process.env.CAN_I_FORMAT_HOME;
  if (override) return path.resolve(override);

  // Under the test runner with no override set, something is a moment away
  // from reading or writing a real installation: the index, the config, the
  // preview cache of whoever is running the tests. That has actually happened
  // — a bare `node --test test/video.test.ts` filled a real cache with
  // fixtures — so it is refused rather than guarded against by convention.
  // `test/setup.ts` sets the override for the whole suite; this catches the
  // ad-hoc run that skips it.
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      "Refusing to use the real application directory from a test. Run `npm test`, " +
        "which loads test/setup.ts, or set CAN_I_FORMAT_HOME yourself.",
    );
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "can-i-format");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "can-i-format");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "can-i-format");
}

export function configFile(): string {
  return path.join(configDir(), "config.json");
}

export function dbFile(): string {
  return path.join(configDir(), "index.db");
}

/** Scratch space for things like Lightroom catalog copies. */
export function cacheDir(): string {
  return path.join(configDir(), "cache");
}
