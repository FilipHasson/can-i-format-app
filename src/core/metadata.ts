import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import exifr from "exifr";
import { hasReadableExif, isQuicktimeFamily } from "./media.ts";

/**
 * Capture identity for a media file.
 *
 * The point of this module is that a photo keeps its identity through the
 * things an import pipeline does to it: renaming, RAW->DNG conversion,
 * re-wrapping. Size and filename both break under those; capture timestamp plus
 * camera body does not.
 */
export interface CaptureMeta {
  /**
   * Wall-clock capture time as a timezone-free `YYYYMMDDHHMMSS` integer.
   *
   * EXIF timestamps carry no timezone, and neither does Lightroom's
   * `captureTime`. Converting them to an epoch would mean inventing an offset
   * and getting a different answer on a laptop that travelled — so we compare
   * the naive wall clock directly instead.
   */
  capturedAt: number | null;
  /** Sub-second digits, used only to break ties within the same second. */
  subSec: number | null;
  /** `make|model|serial`, normalized. Serial is what makes it near-unique. */
  cameraKey: string | null;
  /** DNG records the file it was converted from; that survives the rename. */
  origStem: string | null;
  width: number | null;
  height: number | null;
}

export const EMPTY_META: CaptureMeta = {
  capturedAt: null,
  subSec: null,
  cameraKey: null,
  origStem: null,
  width: null,
  height: null,
};

/** DNG tag 0xC68B — written by Adobe's converter and by Lightroom on import. */
const TAG_ORIGINAL_RAW_FILE_NAME = 50827;

export function naiveStamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  return (
    year * 1e10 + month * 1e8 + day * 1e6 + hour * 1e4 + minute * 100 + second
  );
}

/** Splits a `YYYYMMDDHHMMSS` stamp back out for display. */
export function formatStamp(stamp: number | null): string {
  if (stamp === null) return "";
  const s = String(stamp).padStart(14, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

/** Accepts `2024:05:01 14:23:45`, ISO, and the mixed forms cameras emit. */
export function parseExifDate(value: unknown): number | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return naiveStamp(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
    );
  }
  if (typeof value !== "string") return null;

  const m = value
    .trim()
    .match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m;
  const stamp = naiveStamp(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
  // Cameras with a dead clock battery emit 0000:00:00; treat that as unusable.
  return stamp < 19000101000000 ? null : stamp;
}

function cleanField(value: unknown): string {
  if (typeof value !== "string") {
    if (typeof value === "number") return String(value);
    return "";
  }
  return value.replace(/\0/g, "").trim().replace(/\s+/g, " ");
}

/**
 * `model|serial`, and deliberately *not* `make|model|serial`.
 *
 * A Lightroom catalog stores only the model, so any key including the make
 * could never match one derived from the catalog — EXIF says make
 * "NIKON CORPORATION" / model "NIKON Z 8" where the catalog says just
 * "NIKON Z 8". Model alone is already distinctive; the serial is what makes it
 * near-unique, and `sameCamera` treats a missing serial as a wildcard.
 */
export function buildCameraKey(
  make: unknown,
  model: unknown,
  serial: unknown,
): string | null {
  let md = cleanField(model).toLowerCase();
  const mk = cleanField(make).toLowerCase();
  const sn = cleanField(serial).toLowerCase();

  // Some bodies write the make into the model too; drop the redundant prefix.
  if (mk !== "" && md.startsWith(`${mk} `)) md = md.slice(mk.length + 1);
  if (md === "") md = mk;

  if (md === "" && sn === "") return null;
  return `${md}|${sn}`;
}

/**
 * True when two camera keys can refer to the same body. Models must agree; a
 * serial that is only known on one side does not disqualify the match, because
 * catalogs and some formats simply omit it.
 */
/**
 * Do two model strings name the same camera?
 *
 * EXIF gives make and model separately, so `buildCameraKey` drops a make that
 * the model repeats: Canon's "Canon EOS R5" becomes "eos r5". A Lightroom
 * catalog has only the one interned string and keeps it whole. Comparing them
 * strictly means a Canon body never matches its own catalog entry — the model
 * as written is the model with the maker's name still on the front.
 */
function modelsAgree(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "" || b === "") return false;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.endsWith(` ${shorter}`);
}

export function sameCamera(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [modelA = "", serialA = ""] = a.split("|");
  const [modelB = "", serialB = ""] = b.split("|");
  if (!modelsAgree(modelA, modelB)) return false;
  // A catalog often has the model but never harvested the serial. Absence on
  // either side is not disagreement.
  if (serialA === "" || serialB === "") return true;
  return serialA === serialB;
}

function stemOfName(name: string): string | null {
  const cleaned = cleanField(name);
  if (cleaned === "") return null;
  const base = cleaned.split(/[\\/]/).pop() as string;
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return stem === "" ? null : stem.toLowerCase();
}

/**
 * exifr's published types are narrower than what it actually accepts at
 * runtime (`ifd0: true` is documented and works, but typed as an object only),
 * so this is kept loose and cast at the call.
 */
const EXIF_OPTIONS: Record<string, unknown> = {
  // Header-only read; exifr stops after the metadata chunk rather than
  // pulling a 60 MB raw file through memory.
  chunked: true,
  firstChunkSize: 65536,
  tiff: true,
  ifd0: true,
  exif: true,
  gps: false,
  interop: false,
  thumbnail: false,
  // Keep dates as raw strings — we want the naive wall clock, not a Date that
  // silently picks up this machine's timezone.
  reviveValues: false,
  translateKeys: true,
  translateValues: false,
  mergeOutput: true,
  sanitize: true,
};

async function readExifMeta(file: string): Promise<CaptureMeta | null> {
  const tags = (await exifr.parse(file, EXIF_OPTIONS as never)) as
    | Record<string, unknown>
    | undefined;
  if (!tags) return null;

  const capturedAt =
    parseExifDate(tags.DateTimeOriginal) ??
    parseExifDate(tags.CreateDate) ??
    parseExifDate(tags.DateTimeDigitized) ??
    parseExifDate(tags.ModifyDate);

  const subSecRaw = cleanField(tags.SubSecTimeOriginal ?? tags.SubSecTime ?? "");
  const subSec = subSecRaw === "" ? null : Number.parseInt(subSecRaw.padEnd(3, "0").slice(0, 3), 10);

  const origStem =
    stemOfName(String(tags.OriginalRawFileName ?? "")) ??
    stemOfName(String(tags[TAG_ORIGINAL_RAW_FILE_NAME] ?? "")) ??
    stemOfName(String(tags.RawFileName ?? ""));

  return {
    capturedAt,
    subSec: Number.isFinite(subSec) ? subSec : null,
    cameraKey: buildCameraKey(
      tags.Make,
      tags.Model,
      tags.BodySerialNumber ?? tags.SerialNumber ?? tags.InternalSerialNumber ?? tags.CameraSerialNumber,
    ),
    origStem,
    width: numberOrNull(tags.ExifImageWidth ?? tags.ImageWidth),
    height: numberOrNull(tags.ExifImageHeight ?? tags.ImageHeight),
  };
}

function numberOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch. */
const QT_EPOCH_OFFSET = 2082844800;

/**
 * Pulls creation time out of an mp4/mov `mvhd` atom.
 *
 * exifr does not handle these, and video is most of what fills a CFexpress
 * card. We walk the top-level box list seeking past `mdat` rather than reading
 * it, so this costs a handful of small reads even on a 200 GB clip.
 */
async function readQuicktimeMeta(file: string): Promise<CaptureMeta | null> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const header = Buffer.alloc(16);
    let offset = 0;

    while (offset < size) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) return null;

      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerSize = 8;

      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        boxSize = Number(large);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset; // Box extends to end of file.
      }
      if (boxSize < headerSize) return null;

      if (type === "moov") {
        const found = await readMvhd(fh, offset + headerSize, offset + boxSize);
        if (found !== null) return found;
        return null;
      }

      offset += boxSize;
    }
    return null;
  } finally {
    await fh.close();
  }
}

async function readMvhd(
  fh: FileHandle,
  start: number,
  end: number,
): Promise<CaptureMeta | null> {
  const header = Buffer.alloc(16);
  let offset = start;

  while (offset < end) {
    const { bytesRead } = await fh.read(header, 0, 16, offset);
    if (bytesRead < 8) return null;

    let boxSize = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;

    if (boxSize === 1) {
      if (bytesRead < 16) return null;
      boxSize = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize) return null;

    if (type === "mvhd") {
      const body = Buffer.alloc(Math.min(32, boxSize - headerSize));
      await fh.read(body, 0, body.length, offset + headerSize);
      const version = body.readUInt8(0);

      let created: number;
      if (version === 1) {
        if (body.length < 12) return null;
        created = Number(body.readBigUInt64BE(4));
      } else {
        if (body.length < 8) return null;
        created = body.readUInt32BE(4);
      }
      if (created === 0) return null;

      // QuickTime nominally stores UTC. Read it in UTC on both sides of a
      // comparison and any camera that actually wrote local time still matches.
      const d = new Date((created - QT_EPOCH_OFFSET) * 1000);
      if (Number.isNaN(d.getTime())) return null;

      return {
        ...EMPTY_META,
        capturedAt: naiveStamp(
          d.getUTCFullYear(),
          d.getUTCMonth() + 1,
          d.getUTCDate(),
          d.getUTCHours(),
          d.getUTCMinutes(),
          d.getUTCSeconds(),
        ),
      };
    }

    offset += boxSize;
  }
  return null;
}

export type MetaState = "ok" | "none" | "error";

export interface MetaResult {
  state: MetaState;
  meta: CaptureMeta;
}

/**
 * Best-effort capture metadata. Never throws — an unreadable header is a
 * matching signal we simply don't get, not a reason to fail a scan.
 */
export async function readCaptureMeta(file: string, ext: string): Promise<MetaResult> {
  try {
    let meta: CaptureMeta | null = null;

    if (hasReadableExif(ext)) {
      meta = await readExifMeta(file);
    } else if (isQuicktimeFamily(ext)) {
      meta = await readQuicktimeMeta(file);
    }

    if (!meta) return { state: "none", meta: EMPTY_META };
    if (meta.capturedAt === null && meta.cameraKey === null && meta.origStem === null) {
      return { state: "none", meta };
    }
    return { state: "ok", meta };
  } catch {
    return { state: "error", meta: EMPTY_META };
  }
}
