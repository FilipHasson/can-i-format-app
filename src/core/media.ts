/**
 * Which files matter for a "can I format this?" decision.
 *
 * The distinction that actually drives the verdict is `required` vs everything
 * else: a leftover .THM thumbnail or DJI .LRV proxy should never be the reason
 * a card is held hostage, because no sane import pipeline copies them.
 */

export type MediaKind = "photo" | "raw" | "video" | "audio" | "sidecar" | "junk" | "other";

/** Rendered stills. */
const PHOTO = new Set([
  "jpg", "jpeg", "jpe", "png", "heic", "heif", "avif", "webp",
  "tif", "tiff", "bmp", "gif",
]);

/** Camera raw. DNG is here too — note it is also what Lightroom converts *to*. */
const RAW = new Set([
  "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2",
  "raf", "orf", "rw2", "raw", "pef", "ptx", "srw", "x3f", "erf",
  "kdc", "dcr", "mrw", "3fr", "fff", "iiq", "mef", "mos", "gpr",
  "rwl", "dxo",
]);

const VIDEO = new Set([
  "mp4", "mov", "m4v", "avi", "mts", "m2ts", "mt2s", "mxf", "mpg",
  "mpeg", "mkv", "wmv", "braw", "r3d", "ari", "arri", "insv", "360",
  "webm", "avchd", "m2t", "ts",
]);

const AUDIO = new Set(["wav", "mp3", "aac", "m4a", "flac", "aif", "aiff", "wma", "ogg", "opus"]);

/**
 * Generated alongside the real file. Present on the card, never worth copying,
 * and frequently absent from the library even for fully-imported footage.
 */
const SIDECAR = new Set([
  "xmp", "thm", "aae", "lrv", "ctg", "sec", "modd", "moff", "bim",
  "cpi", "mpl", "pmr", "ind", "inp", "ins", "bdm", "xml", "idx",
  "dat", "log", "wpl", "gis", "insp",
]);

/** OS bookkeeping that lives on every removable volume. */
const JUNK_FILES = new Set(["ds_store", "thumbs.db", "desktop.ini", "spotlight-v100", ".dropbox"]);

/** Directories skipped wholesale during a walk. Compared lowercased. */
export const JUNK_DIRS = new Set([
  "system volume information",
  "$recycle.bin",
  "recycler",
  ".trashes",
  ".trash",
  ".spotlight-v100",
  ".fseventsd",
  ".temporaryitems",
  ".documentrevisions-v100",
  "found.000",
  "lost+found",
  "misc",
  ".picasaoriginals",
  "@eadir",
]);

/**
 * Folders a camera fills with material it generated itself: proxies, the
 * thumbnails its own playback screen uses, clip index files.
 *
 * None of it is footage. Sony writes M4ROOT/THMBNL full of JPEGs beside the
 * clips, and treating those as photographs means a card reports thousands of
 * files needing import that no one would ever import — while the clips they
 * belong to are checked properly on their own.
 */
const CAMERA_SUPPORT_DIRS = new Set([
  "thmbnl",
  "sub",
  "clipinf",
  "playlist",
  "backup",
  "avf_info",
  "canonthm",
  "general",
  "iisvpl",
  "ivpl",
  "proxy",
  "acliip",
]);

/**
 * Where those names mean what we think they mean.
 *
 * Several of them — "sub", "backup", "general" — are words someone might well
 * name a real folder of photographs. They only count as camera scaffolding
 * inside a camera's own directory structure, so a library folder called Backup
 * keeps being indexed like any other.
 */
const CAMERA_ROOTS = new Set([
  "dcim",
  "private",
  "m4root",
  "avchd",
  "bdmv",
  "contents",
  "xdroot",
  "clip",
  "misc",
  "bpav",
]);

export function isCameraSupportDir(name: string, parentPath: string): boolean {
  if (!CAMERA_SUPPORT_DIRS.has(name.toLowerCase())) return false;
  return parentPath
    .toLowerCase()
    .split("/")
    .some((part) => CAMERA_ROOTS.has(part));
}

export function classify(name: string, ext: string): MediaKind {
  if (JUNK_FILES.has(name.toLowerCase())) return "junk";
  if (name.startsWith("._")) return "junk"; // macOS AppleDouble resource forks
  if (PHOTO.has(ext)) return "photo";
  if (RAW.has(ext)) return "raw";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (SIDECAR.has(ext)) return "sidecar";
  return "other";
}

/** True for the kinds a library is expected to contain. */
export function isLibraryMedia(kind: MediaKind): boolean {
  return kind === "photo" || kind === "raw" || kind === "video" || kind === "audio";
}

/**
 * True when failing to find this card file in the library should block a format.
 * `ignoreSidecars` is user-configurable because a few workflows really do
 * archive .XMP files.
 */
export function isRequired(kind: MediaKind, ignoreSidecars: boolean): boolean {
  if (kind === "junk") return false;
  if (kind === "sidecar") return !ignoreSidecars;
  if (kind === "other") return false;
  return true;
}

/** Formats exifr can pull capture metadata out of without a full decode. */
export function hasReadableExif(ext: string): boolean {
  return PHOTO.has(ext) || RAW.has(ext);
}

/** Video capture time comes from an mp4/mov atom parse, not exifr. */
export function isQuicktimeFamily(ext: string): boolean {
  return ext === "mp4" || ext === "mov" || ext === "m4v" || ext === "360" || ext === "insv";
}
