import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findEmbeddedJpegs, pickPreview } from "../src/core/preview.ts";
import { buildJpegWithExif } from "../tools/exif-writer.ts";
import { buildRawWithPreviews } from "../tools/raw-writer.ts";

/**
 * Where a raw keeps its preview.
 *
 * The first version of this looked in IFD1, which is where a JPEG keeps its
 * thumbnail and where Sony's ARW does not — so a card of raws came back as a
 * grid of empty boxes. What matters is that the whole directory structure is
 * walked, and that a file with several previews gives up the useful one.
 */

const CAMERA = { make: "Sony", model: "ILCE-7RM5", dateTimeOriginal: "2024:05:01 09:10:00" };
const jpeg = (size: number, filler: number) => buildJpegWithExif(CAMERA, size, filler);

/**
 * A JPEG whose segments account for every byte of it, which is what a real
 * embedded preview looks like — `buildJpegWithExif` pads after the end marker,
 * where a decoder ignores it and a measurement should too.
 */
function measurableJpeg(size: number, filler: number, nested?: Buffer): Buffer {
  const payload = nested ?? Buffer.alloc(0);
  // APP1, long enough to carry anything asked for plus filler to reach size.
  const appLength = size - 4 - 2 - 2 + 2;
  const app = Buffer.alloc(appLength);
  app.writeUInt16BE(appLength, 0);
  app.fill(filler, 2);
  payload.copy(app, 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    app,
    Buffer.from([0xff, 0xd9]),
  ]);
}

let tmp: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "can-i-format-preview-"));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function scan(name: string, bytes: Buffer) {
  const file = path.join(tmp, name);
  await fs.writeFile(file, bytes);
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    return await findEmbeddedJpegs(handle, size, path.extname(name).slice(1).toLowerCase());
  } finally {
    await handle.close();
  }
}

describe("a preview kept outside IFD1", () => {
  test("is found anyway", async () => {
    // The ARW arrangement: nothing in IFD1, the preview hanging off a SubIFD.
    const preview = jpeg(40_000, 0x31);
    const found = await scan("DSC00001.ARW", buildRawWithPreviews({ preview, targetSize: 500_000 }));

    assert.equal(found.length, 1, "expected the SubIFD preview to be found");
    assert.equal(found[0]?.length, preview.length);
    assert.match(found[0]?.source ?? "", /sub/);
  });

  test("and reading at the reported offset gives back the JPEG itself", async () => {
    const preview = jpeg(40_000, 0x32);
    const raw = buildRawWithPreviews({ preview, targetSize: 500_000 });
    const found = await scan("DSC00002.ARW", raw);

    const at = found[0];
    assert.ok(at);
    assert.ok(raw.subarray(at.offset, at.offset + at.length).equals(preview));
  });
});

describe("a file carrying several previews", () => {
  test("reports them largest first", async () => {
    const thumbnail = jpeg(2_000, 0x41);
    const preview = jpeg(60_000, 0x42);
    const found = await scan(
      "DSC00003.ARW",
      buildRawWithPreviews({ preview, thumbnail, targetSize: 800_000 }),
    );

    assert.equal(found.length, 2);
    assert.equal(found[0]?.length, preview.length);
    assert.equal(found[1]?.length, thumbnail.length);
  });

  test("and the playback-sized one is chosen over the index thumbnail", async () => {
    const thumbnail = jpeg(2_000, 0x43);
    const preview = jpeg(60_000, 0x44);
    const found = await scan(
      "DSC00004.ARW",
      buildRawWithPreviews({ preview, thumbnail, targetSize: 800_000 }),
    );

    assert.equal(pickPreview(found, 2 * 1024 * 1024)?.length, preview.length);
  });

  test("unless it is too big to be worth sending, when the smaller one wins", async () => {
    // Raws routinely carry a full-resolution preview. Shipping several
    // megabytes to draw a 180px tile would undo the point of previewing.
    const thumbnail = jpeg(2_000, 0x45);
    const preview = jpeg(300_000, 0x46);
    const found = await scan(
      "DSC00005.ARW",
      buildRawWithPreviews({ preview, thumbnail, targetSize: 900_000 }),
    );

    assert.equal(pickPreview(found, 100_000)?.length, thumbnail.length);
  });
});

describe("files the walk cannot use", () => {
  test("something that is not a TIFF at all", async () => {
    assert.deepEqual(await scan("CLIP_0001.MP4", Buffer.alloc(50_000, 7)), []);
  });

  test("a raw whose directories point at no JPEG", async () => {
    assert.deepEqual(await scan("DSC00006.ARW", buildRawWithPreviews({ targetSize: 400_000 })), []);
  });

  test("an offset that runs past the end of the file", async () => {
    // A truncated download, or a file still being written. The bytes at the
    // offset are checked before being trusted, so this is not a crash.
    const raw = buildRawWithPreviews({ preview: jpeg(40_000, 0x51), targetSize: 500_000 });
    assert.deepEqual(await scan("DSC00007.ARW", raw.subarray(0, 200)), []);
  });

  test("a directory count that is nonsense", async () => {
    const raw = buildRawWithPreviews({ preview: jpeg(40_000, 0x52), targetSize: 500_000 });
    raw.writeUInt16LE(60_000, 8); // IFD0 now claims 60,000 entries.
    assert.deepEqual(await scan("DSC00008.ARW", raw), []);
  });

  test("a SubIFD pointing back at itself", async () => {
    // A cycle has to terminate rather than spin: the walk is bounded and
    // remembers where it has been.
    const raw = buildRawWithPreviews({ preview: jpeg(40_000, 0x53), targetSize: 500_000 });
    raw.writeUInt32LE(8, 18); // IFD0's SubIFDs value now points at IFD0.
    const found = await scan("DSC00009.ARW", raw);
    assert.ok(Array.isArray(found));
  });
});

describe("a container the walk cannot parse", () => {
  /** An ISO-BMFF file — the shape of a HEIC or a CR3 — with a JPEG inside. */
  function bmffWith(preview: Buffer, padding = 200_000): Buffer {
    const box = (type: string, payload: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(payload.length + 8, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, payload]);
    };
    return Buffer.concat([
      box("ftyp", Buffer.from("heicheix mif1", "latin1")),
      box("meta", Buffer.alloc(64, 1)),
      // The preview lives in mdat, the way a HEIC thumbnail item does.
      box("mdat", Buffer.concat([Buffer.alloc(128, 2), preview, Buffer.alloc(padding, 3)])),
    ]);
  }

  test("its preview is found anyway", async () => {
    const preview = measurableJpeg(40_000, 0x71);
    const found = await scan("IMG_0001.HEIC", bmffWith(preview));

    assert.equal(found.length, 1, "expected the JPEG inside the container to be found");
    assert.equal(found[0]?.length, preview.length);
    assert.equal(found[0]?.source, "scan");
  });

  test("and reading at the reported offset gives back the JPEG", async () => {
    const preview = measurableJpeg(40_000, 0x72);
    const file = bmffWith(preview);
    const found = await scan("IMG_0002.HEIC", file);

    const at = found[0];
    assert.ok(at);
    assert.ok(file.subarray(at.offset, at.offset + at.length).equals(preview));
  });

  test("a file with nothing image-shaped in it stays empty", async () => {
    assert.deepEqual(await scan("IMG_0003.HEIC", Buffer.alloc(400_000, 9)), []);
  });

  test("and a run too short to be an image is not offered", async () => {
    // Two stray marker bytes are not a preview.
    const tiny = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 5), Buffer.from([0xff, 0xd9])]);
    assert.deepEqual(await scan("IMG_0004.HEIC", bmffWith(tiny)), []);
  });

  test("a preview carrying its own thumbnail is measured whole", async () => {
    // The trap: a preview has EXIF, and that EXIF can hold a thumbnail whose
    // end marker comes first. Hunting for FF D9 would report the preview as a
    // few hundred bytes and show a smudge.
    const nested = measurableJpeg(2_000, 0x74);
    const preview = measurableJpeg(60_000, 0x75, nested);
    const found = await scan("IMG_0005.HEIC", bmffWith(preview));

    assert.equal(found[0]?.length, preview.length, "the whole preview, not the thumbnail inside it");
  });

  test("a raw whose directories do have a preview never reaches the scan", async () => {
    // The cheap route has to keep winning, or every raw pays for a 16MB read.
    const preview = jpeg(40_000, 0x73);
    const found = await scan("DSC00010.ARW", buildRawWithPreviews({ preview, targetSize: 500_000 }));
    assert.equal(found[0]?.source?.includes("sub"), true);
    assert.ok(!found.some((f) => f.source === "scan"));
  });
});
