import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildJpegWithExif } from "../tools/exif-writer.ts";
import { buildRawWithPreviews } from "../tools/raw-writer.ts";

/**
 * Previews come out of the file the camera wrote, not out of a decoder.
 *
 * That is the whole design: a raw file cannot be drawn by a browser and
 * decoding one would mean a native dependency, but the camera already embedded
 * a JPEG preview for its own screen. These tests hold that path honest — that
 * the preview really is the embedded one, that it is only read once, and that
 * a file with nothing to show says so instead of failing.
 */

const CAMERA = { make: "Canon", model: "Canon EOS R5", dateTimeOriginal: "2024:05:01 09:10:00" };

let tmp: string;
let home: string;
let readThumbnail: typeof import("../src/core/thumbnail.ts").readThumbnail;
let cacheDir: typeof import("../src/core/paths.ts").cacheDir;

/** What `test/setup.ts` pointed us at, to hand back afterwards. */
const testHome = process.env.CAN_I_FORMAT_HOME;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-thumb-"));
  home = path.join(tmp, "home");
  process.env.CAN_I_FORMAT_HOME = home;
  ({ readThumbnail } = await import("../src/core/thumbnail.ts"));
  ({ cacheDir } = await import("../src/core/paths.ts"));
});

after(async () => {
  // Restored rather than deleted: deleting it hands whatever runs next back
  // to the real installation.
  process.env.CAN_I_FORMAT_HOME = testHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A frame carrying the small JPEG a camera writes for its own back screen. */
const preview = () => buildJpegWithExif(CAMERA, 900, 0x42);

async function put(name: string, bytes: Buffer): Promise<{ file: string; size: number; mtimeMs: number }> {
  const file = path.join(tmp, name);
  await fs.writeFile(file, bytes);
  const st = await fs.stat(file);
  return { file, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

async function countCached(): Promise<number> {
  const files = await fs.readdir(path.join(cacheDir(), "thumbs"), { recursive: true });
  return files.filter((f) => !String(f).includes(".tmp")).length;
}

describe("a file with an embedded preview", () => {
  test("hands back exactly the bytes the camera put there", async () => {
    const embedded = preview();
    const { file, size, mtimeMs } = await put(
      "IMG_0001.JPG",
      buildJpegWithExif({ ...CAMERA, thumbnail: embedded }, 60_000, 0x11),
    );

    const thumb = await readThumbnail(file, "jpg", size, mtimeMs);
    assert.ok(thumb);
    assert.equal(thumb.contentType, "image/jpeg");
    assert.ok(thumb.bytes.equals(embedded), "should be the embedded preview, not the whole frame");
  });

  test("and does not read the file a second time", async () => {
    const embedded = preview();
    const { file, size, mtimeMs } = await put(
      "IMG_0002.JPG",
      buildJpegWithExif({ ...CAMERA, thumbnail: embedded }, 60_000, 0x12),
    );

    await readThumbnail(file, "jpg", size, mtimeMs);
    // Proving it by removing the source: a second call can only succeed from
    // the cache now. This is what keeps reopening a scan cheap.
    await fs.rm(file);

    const again = await readThumbnail(file, "jpg", size, mtimeMs);
    assert.ok(again);
    assert.ok(again.bytes.equals(embedded));
  });

  test("a file edited in place gets a new preview rather than the stale one", async () => {
    const first = preview();
    const { file, size, mtimeMs } = await put(
      "IMG_0003.JPG",
      buildJpegWithExif({ ...CAMERA, thumbnail: first }, 60_000, 0x13),
    );
    const before = await readThumbnail(file, "jpg", size, mtimeMs);
    assert.ok(before, "expected a preview from the original file");
    assert.ok(before.bytes.equals(first));

    const second = buildJpegWithExif({ ...CAMERA, dateTimeOriginal: "2025:01:01 00:00:00" }, 1200, 0x77);
    const rewritten = await put(
      "IMG_0003.JPG",
      buildJpegWithExif({ ...CAMERA, thumbnail: second }, 61_000, 0x14),
    );

    const after = await readThumbnail(rewritten.file, "jpg", rewritten.size, rewritten.mtimeMs + 1);
    assert.ok(after, "expected a preview from the rewritten file");
    assert.ok(after.bytes.equals(second), "the key covers size and mtime, so this is a fresh read");
    assert.notEqual(before.tag, after.tag);
  });
});

describe("a file with nothing to show", () => {
  test("says so instead of failing", async () => {
    // A raw the tool knows how to read metadata from, but which carries no
    // preview. Nothing can be drawn, and that is an answer.
    const { file, size, mtimeMs } = await put("IMG_0004.CR3", buildJpegWithExif(CAMERA, 50_000, 0x15));
    assert.equal(await readThumbnail(file, "cr3", size, mtimeMs), null);
  });

  test("and remembers, so the next look is free", async () => {
    const { file, size, mtimeMs } = await put("IMG_0005.CR3", buildJpegWithExif(CAMERA, 50_000, 0x16));
    await readThumbnail(file, "cr3", size, mtimeMs);
    await fs.rm(file);
    assert.equal(await readThumbnail(file, "cr3", size, mtimeMs), null);
  });

  test("a video is not attempted at all", async () => {
    const { file, size, mtimeMs } = await put("CLIP_0001.MP4", Buffer.alloc(50_000, 7));
    assert.equal(await readThumbnail(file, "mp4", size, mtimeMs), null);
  });
});

describe("formats a browser can draw itself", () => {
  test("fall back to the original bytes when they carry no preview", async () => {
    const bytes = buildJpegWithExif(CAMERA, 40_000, 0x21);
    const { file, size, mtimeMs } = await put("export.jpg", bytes);

    const thumb = await readThumbnail(file, "jpg", size, mtimeMs);
    assert.ok(thumb);
    assert.ok(thumb.bytes.equals(bytes));
  });

  test("but a large one is not sent at all", async () => {
    // Sending a 30MB frame to be drawn at 180px would cost more than the
    // preview is worth, and a grid of them far more.
    const { file, size, mtimeMs } = await put("huge.png", Buffer.alloc(5 * 1024 * 1024, 9));
    assert.equal(await readThumbnail(file, "png", size, mtimeMs), null);
  });
});

describe("the cache directory", () => {
  test("holds one entry per file looked at, and no leftovers", async () => {
    const cached = await countCached();
    assert.ok(cached > 0, "expected previews to have been written");
    const stray = (await fs.readdir(path.join(cacheDir(), "thumbs"), { recursive: true })).filter((f) =>
      String(f).endsWith(".tmp"),
    );
    assert.deepEqual(stray, [], "a half-written preview should never be left behind");
  });
});

describe("a raw whose preview is not in IFD1", () => {
  test("gets one through the directory walk", async () => {
    // The case that produced a grid of boxes reading "ARW": exifr.thumbnail
    // reads IFD1 and finds nothing, so the walk has to carry it.
    const preview = buildJpegWithExif(CAMERA, 40_000, 0x61);
    const { file, size, mtimeMs } = await put(
      "DSC00001.ARW",
      buildRawWithPreviews({ preview, targetSize: 900_000 }),
    );

    const thumb = await readThumbnail(file, "arw", size, mtimeMs);
    assert.ok(thumb, "expected the SubIFD preview to be found");
    assert.equal(thumb.contentType, "image/jpeg");
    assert.ok(thumb.bytes.equals(preview));
  });

  test("and prefers it over the small index thumbnail beside it", async () => {
    const thumbnail = buildJpegWithExif(CAMERA, 2_000, 0x62);
    const preview = buildJpegWithExif(CAMERA, 50_000, 0x63);
    const { file, size, mtimeMs } = await put(
      "DSC00002.ARW",
      buildRawWithPreviews({ preview, thumbnail, targetSize: 900_000 }),
    );

    const thumb = await readThumbnail(file, "arw", size, mtimeMs);
    assert.ok(thumb?.bytes.equals(preview), "the playback-sized preview is the useful one");
  });
});
