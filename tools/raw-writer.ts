/**
 * Builds TIFF-structured raw files, for testing preview extraction.
 *
 * The bug these exist to catch is structural, not visual: a raw keeps its
 * preview somewhere other than IFD1 — Sony's ARW uses a SubIFD — and code that
 * only reads IFD1 finds nothing and reports no preview. Reproducing that
 * arrangement is what makes the walk testable without a shelf of real cameras.
 */

const TYPE_LONG = 4;

interface Entry {
  tag: number;
  value: number;
}

/** One directory: a count, its entries, and the offset of the next one. */
function directory(entries: Entry[], next: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const out = Buffer.alloc(2 + sorted.length * 12 + 4);
  out.writeUInt16LE(sorted.length, 0);

  for (const [i, entry] of sorted.entries()) {
    const at = 2 + i * 12;
    out.writeUInt16LE(entry.tag, at);
    out.writeUInt16LE(TYPE_LONG, at + 2);
    out.writeUInt32LE(1, at + 4);
    // A LONG fits in the four value bytes, so nothing needs an overflow area.
    out.writeUInt32LE(entry.value, at + 8);
  }

  out.writeUInt32LE(next, 2 + sorted.length * 12);
  return out;
}

const sizeOf = (entryCount: number) => 2 + entryCount * 12 + 4;

export interface RawSpec {
  /** The playback-sized preview, kept in a SubIFD the way an ARW does. */
  preview?: Buffer;
  /** The small index thumbnail, kept in IFD1 the way a JPEG does. */
  thumbnail?: Buffer;
  /** Padding, so the file has a plausible size for a raw. */
  targetSize?: number;
}

/**
 * A little-endian TIFF holding up to two JPEGs, in the two places raw formats
 * actually use. Offsets are laid out in one pass because every value here is a
 * LONG and therefore inline — nothing shifts.
 */
export function buildRawWithPreviews(spec: RawSpec): Buffer {
  const ifd0At = 8;
  const ifd0Size = sizeOf(spec.preview ? 1 : 0 || 1);
  const ifd1At = ifd0At + ifd0Size;
  const ifd1Size = sizeOf(spec.thumbnail ? 2 : 1);
  const subAt = ifd1At + ifd1Size;
  const subSize = sizeOf(spec.preview ? 2 : 1);

  const thumbAt = subAt + subSize;
  const thumbLength = spec.thumbnail?.length ?? 0;
  const previewAt = thumbAt + thumbLength;

  const ifd0 = directory(
    // Tag 0x014A is SubIFDs: the chain a raw hangs its real image data off.
    spec.preview ? [{ tag: 0x014a, value: subAt }] : [{ tag: 0x0100, value: 6000 }],
    spec.thumbnail ? ifd1At : 0,
  );
  const ifd1 = directory(
    spec.thumbnail
      ? [
          { tag: 0x0201, value: thumbAt },
          { tag: 0x0202, value: thumbLength },
        ]
      : [{ tag: 0x0100, value: 160 }],
    0,
  );
  const sub = directory(
    spec.preview
      ? [
          { tag: 0x0201, value: previewAt },
          { tag: 0x0202, value: spec.preview.length },
        ]
      : [{ tag: 0x0100, value: 6000 }],
    0,
  );

  if (ifd0.length !== ifd0Size || ifd1.length !== ifd1Size || sub.length !== subSize) {
    throw new Error("directory sizes changed; the offsets above would be wrong");
  }

  const header = Buffer.alloc(8);
  header.write("II", 0, "latin1");
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifd0At, 4);

  const parts = [header, ifd0, ifd1, sub];
  if (spec.thumbnail) parts.push(spec.thumbnail);
  if (spec.preview) parts.push(spec.preview);

  const base = Buffer.concat(parts);
  const target = spec.targetSize ?? 0;
  return target <= base.length ? base : Buffer.concat([base, Buffer.alloc(target - base.length, 0x5a)]);
}
