import type { FileHandle } from "node:fs/promises";

/**
 * Finding the JPEG preview inside a raw file.
 *
 * `exifr.thumbnail()` reads IFD1, which is where a JPEG keeps its thumbnail —
 * and where most raw formats do not. Sony's ARW puts its preview in a SubIFD,
 * Nikon and Canon use their own arrangements, and a file can carry several at
 * different sizes. Looking in one place and concluding there is no preview is
 * how a card full of raws ends up as a grid of empty boxes.
 *
 * So this walks the TIFF structure properly: IFD0 and its chain, IFD1, the Exif
 * sub-IFD, and every SubIFD listed along the way, collecting each JPEG any of
 * them points at. Nothing is decoded and the whole file is never read — the
 * walk touches a few hundred bytes per directory and then one preview.
 *
 * Not everything is TIFF. HEIC and Canon's CR3 are ISO-BMFF, and an Olympus
 * raw hides its preview in a maker note laid out differently by every maker.
 * Rather than a parser per container, those fall through to reading the front
 * of the file and finding the JPEGs in it directly.
 */

const TIFF_LITTLE = 0x4949;
const TIFF_BIG = 0x4d4d;

const TAG_STRIP_OFFSETS = 0x0111;
const TAG_COMPRESSION = 0x0103;
const TAG_STRIP_BYTE_COUNTS = 0x0117;
const TAG_SUB_IFDS = 0x014a;
const TAG_JPEG_OFFSET = 0x0201;
const TAG_JPEG_LENGTH = 0x0202;
const TAG_EXIF_IFD = 0x8769;

const COMPRESSION_JPEG = new Set([6, 7, 99]);

/** Enough for any directory we care about; a guard against a corrupt count. */
const MAX_ENTRIES = 512;
/** Raw files nest a few levels at most. Bounded so a cycle cannot spin. */
const MAX_DIRECTORIES = 32;

/** How far into a file the last-resort scan will look. */
const SCAN_LIMIT = 16 * 1024 * 1024;
const SCAN_CHUNK = 1024 * 1024;
/** Below this, a run of bytes is not a preview worth showing. */
const MIN_SCANNED_BYTES = 8 * 1024;
/** Having found one this big, the scan has what it came for. */
const GOOD_ENOUGH_BYTES = 256 * 1024;
/** A JPEG has nothing like this many segments; a corrupt one might claim to. */
const MAX_SEGMENTS = 256;

export interface PreviewCandidate {
  offset: number;
  length: number;
  /** Where it was found, for the probe tool and for debugging a new format. */
  source: string;
}

interface Reader {
  handle: FileHandle;
  size: number;
  little: boolean;
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer | null> {
  if (offset < 0 || length <= 0) return null;
  const buffer = Buffer.alloc(length);
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : bytesRead > 0 ? buffer.subarray(0, bytesRead) : null;
  } catch {
    return null;
  }
}

const u16 = (b: Buffer, at: number, little: boolean) =>
  little ? b.readUInt16LE(at) : b.readUInt16BE(at);
const u32 = (b: Buffer, at: number, little: boolean) =>
  little ? b.readUInt32LE(at) : b.readUInt32BE(at);

/** Reads one IFD's entries, and the offset of the directory that follows it. */
async function readDirectory(
  reader: Reader,
  at: number,
): Promise<{ entries: Map<number, { type: number; count: number; valueAt: number; raw: Buffer }>; next: number } | null> {
  const head = await readAt(reader.handle, at, 2);
  if (!head || head.length < 2) return null;

  const count = u16(head, 0, reader.little);
  if (count === 0 || count > MAX_ENTRIES) return null;

  const body = await readAt(reader.handle, at + 2, count * 12 + 4);
  if (!body || body.length < count * 12) return null;

  const entries = new Map<number, { type: number; count: number; valueAt: number; raw: Buffer }>();
  for (let i = 0; i < count; i++) {
    const base = i * 12;
    entries.set(u16(body, base, reader.little), {
      type: u16(body, base + 2, reader.little),
      count: u32(body, base + 4, reader.little),
      valueAt: at + 2 + base + 8,
      raw: body.subarray(base + 8, base + 12),
    });
  }

  const next = body.length >= count * 12 + 4 ? u32(body, count * 12, reader.little) : 0;
  return { entries, next };
}

/**
 * A tag's values. Four bytes or fewer sit inline in the entry; anything longer
 * is stored elsewhere and referenced by offset.
 */
async function values(
  reader: Reader,
  entry: { type: number; count: number; raw: Buffer },
): Promise<number[]> {
  const width = entry.type === 3 ? 2 : entry.type === 4 || entry.type === 13 ? 4 : 0;
  if (width === 0 || entry.count === 0 || entry.count > MAX_ENTRIES) return [];

  const total = width * entry.count;
  const source =
    total <= 4
      ? entry.raw
      : await readAt(reader.handle, u32(entry.raw, 0, reader.little), total);
  if (!source || source.length < total) return [];

  const out: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    out.push(width === 2 ? u16(source, i * 2, reader.little) : u32(source, i * 4, reader.little));
  }
  return out;
}

/** Does a JPEG really start here? Offsets in a raw file are not always right. */
async function isJpegAt(reader: Reader, offset: number, length: number): Promise<boolean> {
  if (offset <= 0 || length < 128 || offset + length > reader.size) return false;
  const head = await readAt(reader.handle, offset, 3);
  return !!head && head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/**
 * Every JPEG the file's directories point at, largest first.
 *
 * Several is normal: a raw commonly holds a small thumbnail for a camera's
 * index view and a larger preview for its playback screen.
 */
export async function findEmbeddedJpegs(
  handle: FileHandle,
  size: number,
  _ext: string,
): Promise<PreviewCandidate[]> {
  const structured = await fromDirectories(handle, size);
  if (structured.length > 0) return structured;

  // The containers this does not parse — ISO-BMFF for HEIC and CR3, a maker
  // note for Olympus — still have a JPEG sitting inside them. Slower, so it
  // runs only once the cheap route has come up empty, and either answer is
  // cached.
  return scanForJpegs(handle, size);
}

async function fromDirectories(handle: FileHandle, size: number): Promise<PreviewCandidate[]> {
  const header = await readAt(handle, 0, 8);
  if (!header || header.length < 8) return [];

  const order = header.readUInt16BE(0);
  if (order !== TIFF_LITTLE && order !== TIFF_BIG) return [];
  const little = order === TIFF_LITTLE;

  // 42 is TIFF. Raw formats use their own magic here (ORF, RW2), but the
  // directory layout after it is the same, so an unknown value is not fatal.
  const reader: Reader = { handle, size, little };
  const first = u32(header, 4, little);

  const found: PreviewCandidate[] = [];
  const seen = new Set<number>();
  const queue: Array<{ at: number; name: string }> = [{ at: first, name: "ifd0" }];
  let walked = 0;

  while (queue.length > 0 && walked < MAX_DIRECTORIES) {
    const item = queue.shift() as { at: number; name: string };
    if (item.at <= 0 || item.at >= size || seen.has(item.at)) continue;
    seen.add(item.at);
    walked++;

    const dir = await readDirectory(reader, item.at);
    if (!dir) continue;

    // The preview pair, used by IFD1 thumbnails and by most raw previews.
    const offsetEntry = dir.entries.get(TAG_JPEG_OFFSET);
    const lengthEntry = dir.entries.get(TAG_JPEG_LENGTH);
    if (offsetEntry && lengthEntry) {
      const [offset] = await values(reader, offsetEntry);
      const [length] = await values(reader, lengthEntry);
      if (offset !== undefined && length !== undefined && (await isJpegAt(reader, offset, length))) {
        found.push({ offset, length, source: item.name });
      }
    }

    // Some formats store the preview as image data in a JPEG-compressed IFD
    // rather than through the pair above.
    const compression = dir.entries.get(TAG_COMPRESSION);
    if (compression) {
      const [scheme] = await values(reader, compression);
      if (scheme !== undefined && COMPRESSION_JPEG.has(scheme)) {
        const strips = dir.entries.get(TAG_STRIP_OFFSETS);
        const counts = dir.entries.get(TAG_STRIP_BYTE_COUNTS);
        if (strips && counts) {
          const [offset] = await values(reader, strips);
          const [length] = await values(reader, counts);
          if (offset !== undefined && length !== undefined && (await isJpegAt(reader, offset, length))) {
            found.push({ offset, length, source: `${item.name}/strip` });
          }
        }
      }
    }

    const subIfds = dir.entries.get(TAG_SUB_IFDS);
    if (subIfds) {
      const offsets = await values(reader, subIfds);
      for (const [i, at] of offsets.entries()) queue.push({ at, name: `${item.name}/sub${i}` });
    }

    const exif = dir.entries.get(TAG_EXIF_IFD);
    if (exif) {
      const [at] = await values(reader, exif);
      if (at !== undefined) queue.push({ at, name: `${item.name}/exif` });
    }

    if (dir.next > 0) queue.push({ at: dir.next, name: nextName(item.name) });
  }

  return found.sort((a, b) => b.length - a.length);
}

function nextName(name: string): string {
  const match = /^ifd(\d+)$/.exec(name);
  return match ? `ifd${Number(match[1]) + 1}` : `${name}/next`;
}

/**
 * Finds JPEGs by looking for where they start, then asking how long they are.
 *
 * A JPEG embedded in a container this cannot parse is still a JPEG sitting in
 * the file, and one always begins FF D8 FF. Finding the *end* by hunting for
 * FF D9 would be wrong, though: a preview carries its own EXIF, and that EXIF
 * can carry a thumbnail of its own, whose end would be found first and the
 * preview reported as a few hundred bytes. So the start is scanned for and the
 * length comes from walking the segments, which steps over EXIF wholesale.
 *
 * Bounded three ways: only the first SCAN_LIMIT bytes are searched, the search
 * stops once it has a preview worth showing, and a run has to be long enough
 * to be an image rather than a stray pair of bytes.
 */
async function scanForJpegs(handle: FileHandle, size: number): Promise<PreviewCandidate[]> {
  const limit = Math.min(size, SCAN_LIMIT);
  const found: PreviewCandidate[] = [];
  const starts: number[] = [];

  let at = 0;
  let carry = Buffer.alloc(0);

  while (at < limit) {
    const chunk = await readAt(handle, at, Math.min(SCAN_CHUNK, limit - at));
    if (!chunk || chunk.length === 0) break;

    // Two bytes of overlap, so a marker split across a chunk edge is not lost.
    const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const base = at - carry.length;

    for (let i = 0; i + 2 < buffer.length; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
        starts.push(base + i);
      }
    }

    carry = Buffer.from(buffer.subarray(Math.max(0, buffer.length - 2)));
    at += chunk.length;
    if (starts.length > 64) break;
  }

  for (const offset of starts) {
    // A nested thumbnail starts inside a preview already measured, so there is
    // nothing further to learn from it.
    if (found.some((f) => offset > f.offset && offset < f.offset + f.length)) continue;

    const length = await jpegExtent(handle, offset, size);
    if (length >= MIN_SCANNED_BYTES) found.push({ offset, length, source: 'scan' });
    if (found.some((f) => f.length >= GOOD_ENOUGH_BYTES)) break;
  }

  return found.sort((a, b) => b.length - a.length);
}

/**
 * How long the JPEG starting here is, by walking its segments.
 *
 * Each segment states its own length, so EXIF — and any thumbnail hiding in
 * it — is stepped over rather than searched through. Only after the start of
 * scan marker, where the compressed data begins and lengths stop being stated,
 * does finding the end mean looking for it; and by then FF D9 really is the
 * end, because a JPEG encoder escapes any FF in the data it writes.
 */
async function jpegExtent(handle: FileHandle, start: number, size: number): Promise<number> {
  let at = start + 2;

  for (let steps = 0; steps < MAX_SEGMENTS && at + 4 <= size; steps++) {
    const head = await readAt(handle, at, 4);
    if (!head || head.length < 4 || head[0] !== 0xff) return 0;

    const marker = head[1] as number;
    if (marker === 0xd9) return at + 2 - start;
    // Padding, restart markers and the standalone markers carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }

    const length = ((head[2] as number) << 8) | (head[3] as number);
    if (length < 2) return 0;

    if (marker === 0xda) {
      const end = await findEndOfImage(handle, at + 2 + length, size);
      return end === -1 ? 0 : end - start;
    }
    at += 2 + length;
  }
  return 0;
}

/** The EOI closing the compressed data that starts at `from`. */
async function findEndOfImage(handle: FileHandle, from: number, size: number): Promise<number> {
  let at = from;
  let carry = Buffer.alloc(0);

  while (at < size) {
    const chunk = await readAt(handle, at, Math.min(SCAN_CHUNK, size - at));
    if (!chunk || chunk.length === 0) return -1;

    const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const base = at - carry.length;

    for (let i = 0; i + 1 < buffer.length; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return base + i + 2;
    }

    carry = Buffer.from(buffer.subarray(Math.max(0, buffer.length - 1)));
    at += chunk.length;
  }
  return -1;
}
/**
 * The preview worth showing: the largest that is still small enough to send to
 * a browser to draw at a couple of hundred pixels. Raw files often carry a
 * full-resolution preview, and shipping several megabytes per tile would undo
 * the point of previewing at all.
 */
export function pickPreview(
  candidates: readonly PreviewCandidate[],
  maxBytes: number,
): PreviewCandidate | null {
  if (candidates.length === 0) return null;
  const affordable = candidates.filter((c) => c.length <= maxBytes);
  if (affordable.length > 0) return affordable[0] as PreviewCandidate;
  // All of them are large; the smallest is the least bad choice.
  return candidates[candidates.length - 1] as PreviewCandidate;
}
