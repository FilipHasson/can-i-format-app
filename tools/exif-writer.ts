/**
 * Builds tiny JPEGs carrying real EXIF, for fixtures and tests.
 *
 * The matcher's most important claim — that a photo keeps its identity through
 * renaming and RAW->DNG conversion — can only be tested against files that
 * actually contain capture metadata. Rather than commit binary blobs, we
 * synthesise a minimal but genuinely valid APP1/TIFF block that exifr parses
 * exactly as it would a camera's.
 */

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_SUB_SEC_TIME_ORIGINAL = 0x9291;
const TAG_BODY_SERIAL = 0xa431;
const TAG_ORIGINAL_RAW_FILE_NAME = 0xc68b;
const TAG_THUMBNAIL_OFFSET = 0x0201;
const TAG_THUMBNAIL_LENGTH = 0x0202;

/** Two inline LONG entries: count, the entries themselves, next-IFD pointer. */
const IFD1_SIZE = 2 + 2 * 12 + 4;

const TYPE_ASCII = 2;
const TYPE_LONG = 4;

interface TagValue {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

function ascii(tag: number, value: string): TagValue {
  const data = Buffer.from(`${value}\0`, "latin1");
  return { tag, type: TYPE_ASCII, count: data.length, data };
}

function long(tag: number, value: number): TagValue {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value, 0);
  return { tag, type: TYPE_LONG, count: 1, data };
}

/**
 * Lays out one IFD plus its overflow data area.
 *
 * Values of four bytes or fewer live inline in the entry; anything larger is
 * appended after the directory and referenced by offset from the TIFF header.
 */
function serializeIfd(entries: TagValue[], ifdStart: number, nextIfd: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const ifdSize = 2 + sorted.length * 12 + 4;

  const directory = Buffer.alloc(ifdSize);
  const overflow: Buffer[] = [];
  let dataOffset = ifdStart + ifdSize;

  directory.writeUInt16LE(sorted.length, 0);

  for (const [i, entry] of sorted.entries()) {
    const at = 2 + i * 12;
    directory.writeUInt16LE(entry.tag, at);
    directory.writeUInt16LE(entry.type, at + 2);
    directory.writeUInt32LE(entry.count, at + 4);

    if (entry.data.length <= 4) {
      entry.data.copy(directory, at + 8);
    } else {
      directory.writeUInt32LE(dataOffset, at + 8);
      // TIFF requires values to start on a word boundary.
      const padded =
        entry.data.length % 2 === 0
          ? entry.data
          : Buffer.concat([entry.data, Buffer.alloc(1)]);
      overflow.push(padded);
      dataOffset += padded.length;
    }
  }

  directory.writeUInt32LE(nextIfd, 2 + sorted.length * 12);
  return Buffer.concat([directory, ...overflow]);
}

export interface ExifSpec {
  make: string;
  model: string;
  serial?: string;
  /** `YYYY:MM:DD HH:MM:SS`. */
  dateTimeOriginal: string;
  subSec?: string;
  /** Set on DNGs to record the RAW file they were converted from. */
  originalRawFileName?: string;
  /** JPEG bytes to embed as the IFD1 preview, the way a camera does. */
  thumbnail?: Buffer;
}

function buildTiff(spec: ExifSpec): Buffer {
  const header = Buffer.alloc(8);
  header.write("II", 0, "latin1");
  header.writeUInt16LE(0x002a, 2);
  header.writeUInt32LE(8, 4); // IFD0 immediately follows the header.

  const exifEntries: TagValue[] = [ascii(TAG_DATE_TIME_ORIGINAL, spec.dateTimeOriginal)];
  if (spec.subSec) exifEntries.push(ascii(TAG_SUB_SEC_TIME_ORIGINAL, spec.subSec));
  if (spec.serial) exifEntries.push(ascii(TAG_BODY_SERIAL, spec.serial));

  const ifd0Entries: TagValue[] = [
    ascii(TAG_MAKE, spec.make),
    ascii(TAG_MODEL, spec.model),
    long(TAG_EXIF_IFD, 0), // Patched below once IFD0's true length is known.
  ];
  if (spec.originalRawFileName) {
    ifd0Entries.push(ascii(TAG_ORIGINAL_RAW_FILE_NAME, spec.originalRawFileName));
  }

  // First pass establishes IFD0's size; the pointer is a fixed-width inline
  // value, so patching it cannot shift anything.
  const sized = serializeIfd(ifd0Entries, 8, 0);
  const exifStart = 8 + sized.length;

  const pointer = ifd0Entries.find((e) => e.tag === TAG_EXIF_IFD) as TagValue;
  pointer.data.writeUInt32LE(exifStart, 0);

  const ifd0WithoutThumb = serializeIfd(ifd0Entries, 8, 0);
  const exifIfd = serializeIfd(exifEntries, exifStart, 0);

  if (!spec.thumbnail) {
    return Buffer.concat([header, ifd0WithoutThumb, exifIfd]);
  }

  // IFD1 is where a camera keeps its preview, and it lives after IFD0's chain:
  // header, IFD0, the Exif sub-IFD, then IFD1 and the thumbnail bytes it
  // points at. IFD1's size is fixed, so the offset is known before laying out.
  const ifd1Start = exifStart + exifIfd.length;
  const thumbStart = ifd1Start + IFD1_SIZE;

  const ifd0 = serializeIfd(ifd0Entries, 8, ifd1Start);
  const ifd1 = serializeIfd(
    [long(TAG_THUMBNAIL_OFFSET, thumbStart), long(TAG_THUMBNAIL_LENGTH, spec.thumbnail.length)],
    ifd1Start,
    0,
  );
  if (ifd1.length !== IFD1_SIZE) throw new Error("IFD1 layout changed; offsets would be wrong");

  return Buffer.concat([header, ifd0, exifIfd, ifd1, spec.thumbnail]);
}

/**
 * A valid-enough JPEG: start of image, an EXIF APP1 segment, end of image,
 * then filler to reach `targetSize`. The filler sits after EOI where decoders
 * ignore it, and gives each fixture a distinct size and content hash.
 */
export function buildJpegWithExif(spec: ExifSpec, targetSize = 0, filler = 0x00): Buffer {
  const tiff = buildTiff(spec);
  const app1Length = 2 + 6 + tiff.length;

  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(app1Length, 2);

  const parts = [
    Buffer.from([0xff, 0xd8]),
    segment,
    Buffer.from("Exif\0\0", "latin1"),
    tiff,
    Buffer.from([0xff, 0xd9]),
  ];

  const base = Buffer.concat(parts);
  if (targetSize <= base.length) return base;
  return Buffer.concat([base, Buffer.alloc(targetSize - base.length, filler)]);
}
