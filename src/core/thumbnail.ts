import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import exifr from "exifr";

import { cacheDir, stemOf } from "./paths.ts";
import { classify, hasReadableExif } from "./media.ts";
import { findEmbeddedJpegs, pickPreview } from "./preview.ts";

/**
 * Previews for the files view, without a decoder.
 *
 * Adding an image library to render a 45MB raw would be the obvious way to do
 * this and the wrong one: it is a native dependency, it is slow, and it is
 * unnecessary, because the camera already did the work. Every camera JPEG and
 * essentially every raw carries at least one JPEG preview, put there for the
 * camera's own screen. Reading it costs no decoding at all.
 *
 * Where it is kept varies by maker, which is the trap: JPEGs use IFD1, and so
 * does `exifr.thumbnail()`, but Sony's ARW keeps its preview in a SubIFD and
 * other raws elsewhere again. Looking only in IFD1 is what turned a card of
 * raws into a grid of empty boxes. `preview.ts` walks the whole directory
 * structure instead, and the largest affordable preview wins — often a
 * playback-sized image rather than a 160px thumbnail.
 */

/** Formats a browser will render from the original bytes. */
const BROWSER_READABLE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
};

/**
 * Above this, sending the original is worse than showing nothing: a grid of
 * them would pull hundreds of megabytes over the socket to draw at 160px.
 */
const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024;

export interface Thumbnail {
  bytes: Buffer;
  contentType: string;
  /** Content hash of the source file's identity, for an ETag. */
  tag: string;
}

/** Marks a file we have already looked at and found no preview in. */
const NO_PREVIEW = ".none";

/**
 * Bumped whenever extraction changes what it can find.
 *
 * Without it, teaching the extractor a new place to look would change nothing
 * for anyone who had already opened a scan: the cache remembers "no preview"
 * against the file, and the file has not changed. Versioning the key retires
 * those answers along with the code that produced them.
 */
const EXTRACTOR_VERSION = 3;

function keyFor(absPath: string, size: number, mtimeMs: number): string {
  return crypto
    .createHash("sha1")
    .update(`${EXTRACTOR_VERSION}|${absPath}|${size}|${mtimeMs}`)
    .digest("hex");
}

async function readCached(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** Written to a temporary name first, so a crash cannot leave a half file. */
async function writeCache(file: string, bytes: Buffer): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Above this a preview is more expensive to send than it is worth at the size
 * it will be drawn. Raws routinely carry a full-resolution preview.
 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Where a camera leaves a still for a clip it recorded.
 *
 * Video cannot be previewed without decoding a frame, which would mean the
 * dependency this module exists to avoid — but cameras already wrote one.
 * Sony fills M4ROOT/THMBNL with a JPEG per clip; Canon and others drop a .THM
 * beside the file. Those directories are skipped during a scan precisely
 * because they are not footage, which makes this the one place they are useful.
 */
function clipStills(absPath: string): string[] {
  const slash = absPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : absPath.slice(0, slash);
  const stem = stemOf(absPath.slice(slash + 1));
  const parent = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));

  const names = [`${stem}.thm`, `${stem}.THM`, `${stem}.jpg`, `${stem}.JPG`];
  const out = names.map((n) => `${dir}/${n}`);

  if (parent !== "") {
    // Sony: CLIP/C0001.MP4 has its still at THMBNL/C0001T01.JPG.
    for (const folder of ["THMBNL", "thmbnl"]) {
      for (const suffix of ["T01.JPG", "T01.jpg", ".JPG", ".jpg"]) {
        out.push(`${parent}/${folder}/${stem}${suffix}`);
      }
    }
  }
  return out;
}

async function extract(absPath: string, ext: string, size: number): Promise<Buffer | null> {
  // Only clips. A raw carries its own preview and the walk finds a better
  // one than a sidecar still would be.
  if (classify(`f.${ext}`, ext) === "video") {
    for (const still of clipStills(absPath)) {
      const bytes = await readCached(still);
      if (bytes && bytes.length > 0 && looksLikeJpeg(bytes)) return bytes;
    }
  }

  if (hasReadableExif(ext)) {
    const walked = await fromDirectories(absPath);
    if (walked) return walked;

    // JPEGs, and anything the walk could not make sense of.
    try {
      const embedded = (await exifr.thumbnail(absPath)) as Uint8Array | undefined;
      if (embedded && embedded.length > 0) return Buffer.from(embedded);
    } catch {
      // A truncated or unusual file. Fall through to the original bytes.
    }
  }

  if (BROWSER_READABLE[ext] && size > 0 && size <= MAX_ORIGINAL_BYTES) {
    return readCached(absPath);
  }
  return null;
}

/** Walks the file's own directories for the best preview it points at. */
async function fromDirectories(absPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await fs.open(absPath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const candidates = await findEmbeddedJpegs(handle, size, "");
    const best = pickPreview(candidates, MAX_PREVIEW_BYTES);
    if (!best) return null;

    const bytes = Buffer.alloc(best.length);
    const { bytesRead } = await handle.read(bytes, 0, best.length, best.offset);
    return bytesRead === best.length ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The preview for one file, or null when there is nothing to show.
 *
 * Cached against the file's identity — path, size, mtime — so a second look at
 * the same card costs one small read from the cache directory, and an edited
 * file gets a new key rather than a stale picture.
 */
export async function readThumbnail(
  absPath: string,
  ext: string,
  size: number,
  mtimeMs: number,
): Promise<Thumbnail | null> {
  const tag = keyFor(absPath, size, mtimeMs);
  const dir = path.join(cacheDir(), "thumbs", tag.slice(0, 2));
  const file = path.join(dir, tag);

  if (await readCached(file + NO_PREVIEW)) return null;

  const cached = await readCached(file);
  if (cached) return { bytes: cached, contentType: "image/jpeg", tag };

  const bytes = await extract(absPath, ext, size);
  if (!bytes) {
    await writeCache(file + NO_PREVIEW, Buffer.alloc(0));
    return null;
  }

  const contentType = looksLikeJpeg(bytes) ? "image/jpeg" : (BROWSER_READABLE[ext] ?? "image/jpeg");
  // Only JPEG previews are cached: the fallback path serves the original file,
  // which is already on disk and would only be stored a second time.
  if (contentType === "image/jpeg" && bytes.length <= MAX_PREVIEW_BYTES) {
    await writeCache(file, bytes);
  }
  return { bytes, contentType, tag };
}

function looksLikeJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** True where a preview is at least plausible, so the UI can skip the rest. */
export function mayHaveThumbnail(ext: string): boolean {
  return (
    hasReadableExif(ext) ||
    classify(`f.${ext}`, ext) === "video" ||
    BROWSER_READABLE[ext] !== undefined
  );
}
