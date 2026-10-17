import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Db } from "../core/db.ts";
import type { AppConfig, ImportGroup, LibraryConfig } from "../core/config.ts";
import { IMPORT_GROUPS } from "../core/config.ts";
import { fullHash, quickHash } from "../core/hash.ts";
import { normPath, pathKey } from "../core/paths.ts";
import { pool } from "../core/pool.ts";
import type { RateUnit } from "../core/rate.ts";
import { atLeast, isTier } from "../core/tiers.ts";
import {
  disambiguate,
  expandFilename,
  expandTemplate,
  joinUnder,
  suggestToken,
  unknownTokens,
  type TemplateFacts,
} from "../core/template.ts";
import { indexLibrary, indexStage, indexStages } from "../index/library.ts";
import { PhaseTracker, type Phase } from "../core/phases.ts";
import type { LibraryMatch } from "./match.ts";
import { SCAN_STAGES, scanCard, type ScanResult } from "./card.ts";

/**
 * Copying the files a scan found missing into a library.
 *
 * This is the one part of the tool that writes anything, and it writes in
 * exactly one direction: from the card into a library folder. The card is
 * still never modified — not the files, not their timestamps, not the
 * directories. Formatting stays a deliberate act performed elsewhere, after a
 * fresh scan says it is safe.
 *
 * Three properties matter more than speed here:
 *
 * 1. **Nothing is ever overwritten.** A destination that already holds a
 *    different file takes a `_2` suffix. Bytes are written to a `.cif-part`
 *    file that is renamed into place only once it is complete and verified, so
 *    an interrupted run leaves no half-file for a later scan to mistake for an
 *    import.
 * 2. **Every copy is read back and hashed** before it counts. The whole point
 *    is to let someone erase the original afterwards; a copy nobody checked is
 *    not a backup.
 * 3. **A file already in the destination library is not copied again.** The
 *    scan recorded which libraries held it, so importing under a rule like
 *    `main and backup` fills the gap rather than duplicating the whole card.
 */

const COPY_CHUNK = 4 * 1024 * 1024;

/**
 * Four at a time. One stream leaves the device idle between reads and writes;
 * a dozen turns a sequential bulk copy into a seek storm, which on the spinning
 * disks these libraries tend to live on is markedly slower.
 */
const COPY_CONCURRENCY = 4;

/** The suffix an incomplete copy carries. Never renamed into place unverified. */
const PART_SUFFIX = ".cif-part";

export type ImportPhase = "planning" | "copying" | "indexing" | "rechecking" | "done";

/**
 * One bar for the whole import. Re-indexing and re-checking are each a whole
 * job of their own with stages inside; they fill one segment here, by their
 * own progress through those stages, rather than starting the bar again.
 * Either can be passed over — a catalog destination stops before both.
 */
export const IMPORT_STAGES = [
  { key: "copy", label: "Copy and verify" },
  { key: "index", label: "Update libraries" },
  { key: "recheck", label: "Check the card again" },
] as const satisfies readonly Phase[];

export type ImportStage = (typeof IMPORT_STAGES)[number]["key"];

export interface ImportProgress {
  phase: ImportPhase;
  stage?: ImportStage;
  /** How far through the stage, for one made of stages of its own. */
  within?: number;
  message: string;
  done: number;
  total: number;
  bytes?: number;
  totalBytes?: number;
  rateUnit?: RateUnit;
}

export interface ResolvedDestination {
  group: ImportGroup;
  base: string;
  libraryKey: string | null;
  libraryLabel: string | null;
  libraryKind: string | null;
  /** True when the base sits inside a configured library that is being indexed. */
  inLibrary: boolean;
}

export interface ImportItem {
  fileId: number;
  group: ImportGroup;
  relDir: string;
  name: string;
  ext: string;
  size: number;
  source: string;
  target: string;
  /** Where it lands, relative to the destination base. For the preview. */
  targetRel: string;
  /** True when the name had to change to avoid claiming another file's. */
  renamed: boolean;
  /** True when no capture time existed and the file's own date was used. */
  datedByFile: boolean;
}

export interface SkippedItem {
  relDir: string;
  name: string;
  kind: string;
  reason: string;
}

export interface GroupPlan {
  group: ImportGroup;
  label: string;
  files: number;
  bytes: number;
  destination: ResolvedDestination | null;
  /** Files in this group the destination library already holds. */
  alreadyHeld: number;
}

export interface SpaceCheck {
  base: string;
  needed: number;
  free: number;
  ok: boolean;
}

export interface ImportPlan {
  scanId: number;
  root: string;
  label: string;
  folderTemplate: string;
  filenameTemplate: string;
  groups: GroupPlan[];
  items: ImportItem[];
  skipped: SkippedItem[];
  files: number;
  bytes: number;
  /** A handful of real source → target pairs, so the layout can be seen. */
  examples: Array<{ source: string; target: string }>;
  datedByFile: number;
  renamed: number;
  space: SpaceCheck[];
  warnings: string[];
  /** Anything in here means the import cannot run. */
  problems: string[];
  /** Catalogs that will need Lightroom to synchronize before they see the files. */
  needsSync: Array<{ key: string; label: string; folders: string[] }>;
  /** Folder libraries that can simply be re-indexed afterwards. */
  reindex: string[];
}

const GROUP_LABEL: Record<ImportGroup, string> = {
  photos: "Photos",
  video: "Video",
  audio: "Audio",
};

/** Which destination a card file belongs to, or null when it is not media. */
export function groupOf(kind: string): ImportGroup | null {
  if (kind === "photo" || kind === "raw") return "photos";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  return null;
}

interface BlockedRow {
  id: number;
  rel_dir: string;
  name: string;
  ext: string;
  kind: string;
  size: number;
  mtime_ms: number;
  captured_at: number | null;
  camera_key: string | null;
  matches: string;
}

/**
 * Where a library's files actually live on disk.
 *
 * A folder library is its own root. A catalog is not a place — it is a database
 * describing files somewhere else — so the root comes from what the catalog
 * said when it was indexed, falling back to the deepest folder every indexed
 * file sits under. That fallback is what makes this work without re-indexing
 * first, and it is exact for the single-root catalogs almost everyone has.
 */
export function libraryRoots(db: Db, lib: LibraryConfig): string[] {
  if (lib.kind !== "lightroom") return [normPath(lib.path)];

  const row = db.getLibrary(lib.key);
  if (!row) return [];

  if (row.stats) {
    try {
      const stats = JSON.parse(row.stats) as { roots?: unknown };
      if (Array.isArray(stats.roots)) {
        const roots = stats.roots.filter((r): r is string => typeof r === "string" && r !== "");
        if (roots.length > 0) return roots.map(normPath);
      }
    } catch {
      // A stats blob we cannot read costs us the authoritative answer, not the
      // fallback below.
    }
  }

  const dirs = db
    .allAs<{ path: string }>("SELECT path FROM directory WHERE library_id = ?", row.id)
    .map((d) => d.path);
  if (dirs.length === 0) return [];

  let parts = (dirs[0] as string).split("/");
  for (const dir of dirs) {
    const other = dir.split("/");
    let i = 0;
    while (
      i < parts.length &&
      i < other.length &&
      pathKey(parts[i] as string) === pathKey(other[i] as string)
    ) {
      i++;
    }
    parts = parts.slice(0, i);
    // Only the drive letter in common means the catalog spans places; there is
    // no single sensible folder to offer and the user picks one.
    if (parts.length <= 1) return [];
  }
  return parts.length > 1 ? [parts.join("/")] : [];
}

function resolveDestination(
  db: Db,
  config: AppConfig,
  group: ImportGroup,
): { destination: ResolvedDestination | null; problem: string | null } {
  const setting = config.import?.destinations?.[group];
  if (!setting || setting.mode === "skip") return { destination: null, problem: null };

  if (setting.mode === "library") {
    const library = config.libraries.find((l) => l.key === setting.libraryKey);
    if (!library) {
      return {
        destination: null,
        problem: `${GROUP_LABEL[group]} are set to go to a library that no longer exists.`,
      };
    }
    const roots = libraryRoots(db, library);
    const base = roots[0];
    if (base === undefined) {
      return {
        destination: null,
        problem:
          `${GROUP_LABEL[group]} are set to go to "${library.label}", but where its files live on ` +
          `disk could not be worked out. Index it, or choose a folder instead.`,
      };
    }
    return {
      destination: {
        group,
        base,
        libraryKey: library.key,
        libraryLabel: library.label,
        libraryKind: library.kind,
        inLibrary: true,
      },
      problem: null,
    };
  }

  const base = setting.path === "" ? "" : normPath(setting.path);
  if (base === "") {
    return { destination: null, problem: `${GROUP_LABEL[group]} have no destination folder set.` };
  }

  // A folder inside a configured library is still that library, which is what
  // decides whether a re-index and re-scan can happen without help.
  const owner = config.libraries.find((l) => {
    if (!l.enabled) return false;
    for (const root of libraryRoots(db, l)) {
      const key = pathKey(root);
      const here = pathKey(base);
      if (here === key || here.startsWith(`${key}/`)) return true;
    }
    return false;
  });

  return {
    destination: {
      group,
      base,
      libraryKey: owner?.key ?? null,
      libraryLabel: owner?.label ?? null,
      libraryKind: owner?.kind ?? null,
      inLibrary: owner !== undefined,
    },
    problem: null,
  };
}

/** Sidecars follow the file they describe: IMG_0001.xmp and IMG_0001.CR2.xmp both. */
function sidecarStem(name: string, mediaExts: ReadonlySet<string>): string {
  const withoutSidecar = name.slice(0, name.lastIndexOf("."));
  const dot = withoutSidecar.lastIndexOf(".");
  if (dot > 0 && mediaExts.has(withoutSidecar.slice(dot + 1).toLowerCase())) {
    return withoutSidecar.slice(0, dot).toLowerCase();
  }
  return withoutSidecar.toLowerCase();
}

function parseMatches(raw: string): Record<string, LibraryMatch> {
  try {
    return JSON.parse(raw) as Record<string, LibraryMatch>;
  } catch {
    return {};
  }
}

/**
 * What an import would do, without doing any of it.
 *
 * Nothing is created, nothing is written. The result is the thing shown for
 * confirmation — including the exact paths files would land at, because
 * "3,412 files" is not enough information to agree to reorganising someone's
 * archive.
 */
export async function planImport(db: Db, config: AppConfig, scanId: number): Promise<ImportPlan> {
  const scan = db.getAs<{ root: string; label: string | null }>(
    "SELECT root, label FROM scan WHERE id = ?",
    scanId,
  );
  if (!scan) throw new Error("No such scan.");

  const settings = config.import;
  const cardRoot = normPath(scan.root).replace(/\/+$/, "");
  const cardLabel = scan.label ?? cardRoot;

  const warnings: string[] = [];
  const problems: string[] = [];

  for (const [field, template] of [
    ["Folder layout", settings.folderTemplate],
    ["File name", settings.filenameTemplate],
  ] as const) {
    for (const unknown of unknownTokens(template)) {
      const meant = suggestToken(unknown);
      problems.push(
        meant === null
          ? `${field}: {${unknown}} is not a token.`
          : `${field}: {${unknown}} is not a token — did you mean {${meant}}?`,
      );
    }
  }

  const destinations = new Map<ImportGroup, ResolvedDestination | null>();
  for (const group of IMPORT_GROUPS) {
    const { destination, problem } = resolveDestination(db, config, group);
    destinations.set(group, destination);
    if (problem) problems.push(problem);
  }

  const rows = db.allAs<BlockedRow>(
    `SELECT id, rel_dir, name, ext, kind, size, mtime_ms, captured_at, camera_key, matches
       FROM scan_file
      WHERE scan_id = ? AND required = 1 AND satisfied = 0
      ORDER BY rel_dir, name`,
    scanId,
  );

  const items: ImportItem[] = [];
  const skipped: SkippedItem[] = [];
  const alreadyHeld: Record<ImportGroup, number> = { photos: 0, video: 0, audio: 0 };
  const groupFiles: Record<ImportGroup, number> = { photos: 0, video: 0, audio: 0 };
  const groupBytes: Record<ImportGroup, number> = { photos: 0, video: 0, audio: 0 };

  // Claimed target paths, so two card files never plan to become one library
  // file. Case-folded, because that is the question the filesystem answers.
  const claimed = new Set<string>();
  // Where a media file landed, so a sidecar beside it can follow.
  const placed = new Map<string, { dir: string; base: string }>();
  const mediaExts = new Set(rows.map((r) => r.ext.toLowerCase()));

  const sidecars: BlockedRow[] = [];

  for (const row of rows) {
    const group = groupOf(row.kind);
    if (group === null) {
      sidecars.push(row);
      continue;
    }

    const destination = destinations.get(group) ?? null;
    if (!destination) {
      skipped.push({
        relDir: row.rel_dir,
        name: row.name,
        kind: row.kind,
        reason: `${GROUP_LABEL[group]} are not being imported`,
      });
      continue;
    }

    // The scan already asked every library whether it held this file. A copy
    // into a library that answered yes is a duplicate, not an import.
    //
    // Every library gets an entry in `matches`, including the ones that found
    // nothing, so the tier is what carries the answer — and the threshold is
    // the same `minTier` the verdict uses. A match good enough to let someone
    // erase the card is good enough not to copy the file again.
    const matches = parseMatches(row.matches);
    if (destination.libraryKey) {
      const held = matches[destination.libraryKey];
      if (held && isTier(held.tier) && atLeast(held.tier, config.minTier) && held.deleted !== true) {
        alreadyHeld[group]++;
        skipped.push({
          relDir: row.rel_dir,
          name: row.name,
          kind: row.kind,
          reason: `Already in ${destination.libraryLabel ?? destination.libraryKey}`,
        });
        continue;
      }
    }

    const facts: TemplateFacts = {
      capturedAt: row.captured_at,
      mtimeMs: row.mtime_ms,
      name: row.name,
      ext: row.ext,
      kind: row.kind,
      group,
      camera: row.camera_key === null ? null : (row.camera_key.split("|")[0] ?? null),
      card: cardLabel,
      cardDir: row.rel_dir,
    };

    const { path: folder, datedByFile } = expandTemplate(settings.folderTemplate, facts);
    const wanted = expandFilename(settings.filenameTemplate, facts);

    const dir = joinUnder(destination.base, folder);
    if (dir === null) {
      // Unreachable through the sanitiser, which is why it is a hard error
      // rather than a fallback: if it ever fires, something is badly wrong.
      problems.push(`"${row.name}" would land outside ${destination.base}.`);
      continue;
    }

    let name = wanted;
    let n = 1;
    while (claimed.has(pathKey(`${dir}/${name}`))) {
      n++;
      name = disambiguate(wanted, n);
    }
    claimed.add(pathKey(`${dir}/${name}`));

    const item: ImportItem = {
      fileId: row.id,
      group,
      relDir: row.rel_dir,
      name: row.name,
      ext: row.ext,
      size: row.size,
      source: row.rel_dir === "" ? `${cardRoot}/${row.name}` : `${cardRoot}/${row.rel_dir}/${row.name}`,
      target: `${dir}/${name}`,
      targetRel: folder === "" ? name : `${folder}/${name}`,
      renamed: name !== row.name,
      datedByFile,
    };
    items.push(item);
    placed.set(`${row.rel_dir} ${stemKey(row.name)}`, { dir, base: destination.base });
    groupFiles[group]++;
    groupBytes[group] += Math.max(0, row.size);
  }

  // Sidecars last, so the file each one describes has already been placed.
  for (const row of sidecars) {
    const home = placed.get(`${row.rel_dir} ${sidecarStem(row.name, mediaExts)}`);
    if (!home) {
      skipped.push({
        relDir: row.rel_dir,
        name: row.name,
        kind: row.kind,
        reason: "Nothing it belongs to is being imported",
      });
      continue;
    }

    let name = row.name;
    let n = 1;
    while (claimed.has(pathKey(`${home.dir}/${name}`))) {
      n++;
      name = disambiguate(row.name, n);
    }
    claimed.add(pathKey(`${home.dir}/${name}`));

    items.push({
      fileId: row.id,
      group: "photos",
      relDir: row.rel_dir,
      name: row.name,
      ext: row.ext,
      size: row.size,
      source: row.rel_dir === "" ? `${cardRoot}/${row.name}` : `${cardRoot}/${row.rel_dir}/${row.name}`,
      target: `${home.dir}/${name}`,
      targetRel: `${home.dir.slice(home.base.length + 1)}/${name}`,
      renamed: name !== row.name,
      datedByFile: false,
    });
  }

  const groups: GroupPlan[] = IMPORT_GROUPS.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    files: groupFiles[group],
    bytes: groupBytes[group],
    destination: destinations.get(group) ?? null,
    alreadyHeld: alreadyHeld[group],
  }));

  // ---- what happens afterwards -----------------------------------------
  const needsSync = new Map<string, { key: string; label: string; folders: Set<string> }>();
  const reindex = new Set<string>();

  for (const item of items) {
    const destination = destinations.get(item.group);
    if (!destination) continue;
    if (destination.libraryKind === "lightroom" && destination.libraryKey) {
      const entry = needsSync.get(destination.libraryKey) ?? {
        key: destination.libraryKey,
        label: destination.libraryLabel ?? destination.libraryKey,
        folders: new Set<string>(),
      };
      entry.folders.add(destination.base);
      needsSync.set(destination.libraryKey, entry);
    } else if (destination.libraryKey) {
      reindex.add(destination.libraryKey);
    }
  }

  // ---- room to land ------------------------------------------------------
  const needed = new Map<string, number>();
  for (const item of items) {
    const destination = destinations.get(item.group);
    if (!destination) continue;
    needed.set(destination.base, (needed.get(destination.base) ?? 0) + Math.max(0, item.size));
  }

  const space: SpaceCheck[] = [];
  for (const [base, bytes] of needed) {
    const stats = await fs.statfs(base).catch(() => null);
    const free = stats ? Number(stats.bsize) * Number(stats.bavail) : -1;
    space.push({ base, needed: bytes, free, ok: free < 0 || free > bytes });

    const stat = await fs.stat(base).catch(() => null);
    if (!stat?.isDirectory()) problems.push(`${base} is not a folder that exists.`);
    else if (free >= 0 && free <= bytes) {
      problems.push(
        `${base} has ${formatBytesShort(free)} free but needs ${formatBytesShort(bytes)}.`,
      );
    }
  }

  // ---- things worth saying out loud --------------------------------------
  const datedByFile = items.filter((i) => i.datedByFile).length;
  if (datedByFile > 0 && /\{(YYYY|YY|MM|DD|HH|mm|ss)\}/.test(settings.folderTemplate)) {
    warnings.push(
      datedByFile === 1
        ? "1 file carries no capture time, so the date it was last written decides its folder."
        : `${datedByFile.toLocaleString()} files carry no capture time, so the date each was last written decides its folder.`,
    );
  }

  if (!settings.filenameTemplate.includes("{name}")) {
    warnings.push(
      "Files are being renamed on import. Matching them on a later scan then rests on capture time " +
        "alone, so set the destination library to read capture times for every file.",
    );
  }

  const withoutDestination = skipped.filter((s) => s.reason.startsWith("Photos") || s.reason.startsWith("Video") || s.reason.startsWith("Audio"));
  if (withoutDestination.length > 0) {
    warnings.push(
      `${withoutDestination.length.toLocaleString()} files have no destination and stay on the card.`,
    );
  }

  if (items.length === 0 && problems.length === 0) {
    problems.push("Nothing to import — every missing file is either skipped or already in its library.");
  }

  return {
    scanId,
    root: cardRoot,
    label: cardLabel,
    folderTemplate: settings.folderTemplate,
    filenameTemplate: settings.filenameTemplate,
    groups,
    items,
    skipped,
    files: items.length,
    bytes: items.reduce((sum, i) => sum + Math.max(0, i.size), 0),
    examples: items.slice(0, 8).map((i) => ({ source: i.source, target: i.target })),
    datedByFile,
    renamed: items.filter((i) => i.renamed).length,
    space,
    warnings,
    problems,
    needsSync: [...needsSync.values()].map((n) => ({
      key: n.key,
      label: n.label,
      folders: [...n.folders],
    })),
    reindex: [...reindex],
  };
}

export interface TemplateExample {
  source: string;
  /** Where it would land, relative to whatever destination is chosen. */
  target: string;
  datedByFile: boolean;
  /** Unknown tokens, with the token they were probably meant to be. */
  problems: string[];
}

/**
 * What a template does to a real file from this scan, without choosing a
 * destination or writing anything.
 *
 * Its whole reason for existing is that a template is unreadable until you see
 * what it produces. Typing one and hoping is how someone ends up with a year of
 * photographs under a folder called `{yyyy}`. It runs on the server so there is
 * exactly one implementation of the expansion — a copy of this logic in the
 * browser would drift, and the two would disagree precisely when it mattered.
 */
export function exampleFor(
  db: Db,
  scanId: number,
  folderTemplate: string,
  filenameTemplate: string,
): TemplateExample | null {
  const problems: string[] = [];
  for (const [field, template] of [
    ["Folder layout", folderTemplate],
    ["File name", filenameTemplate],
  ] as const) {
    for (const unknown of unknownTokens(template)) {
      const meant = suggestToken(unknown);
      problems.push(
        meant === null
          ? `${field}: {${unknown}} is not a token.`
          : `${field}: {${unknown}} is not a token — did you mean {${meant}}?`,
      );
    }
  }

  // The first blocked file, so the example is a photograph actually on the card
  // rather than an invented one whose date happens to look tidy.
  const row = db.getAs<BlockedRow>(
    `SELECT id, rel_dir, name, ext, kind, size, mtime_ms, captured_at, camera_key, matches
       FROM scan_file
      WHERE scan_id = ? AND required = 1 AND satisfied = 0
      ORDER BY rel_dir, name
      LIMIT 1`,
    scanId,
  );
  if (!row) return problems.length > 0 ? { source: "", target: "", datedByFile: false, problems } : null;

  const scan = db.getAs<{ label: string | null }>("SELECT label FROM scan WHERE id = ?", scanId);
  const facts: TemplateFacts = {
    capturedAt: row.captured_at,
    mtimeMs: row.mtime_ms,
    name: row.name,
    ext: row.ext,
    kind: row.kind,
    group: groupOf(row.kind) ?? "photos",
    camera: row.camera_key === null ? null : (row.camera_key.split("|")[0] ?? null),
    card: scan?.label ?? "card",
    cardDir: row.rel_dir,
  };

  if (problems.length > 0) return { source: row.name, target: "", datedByFile: false, problems };

  const { path: folder, datedByFile } = expandTemplate(folderTemplate, facts);
  const name = expandFilename(filenameTemplate, facts);

  return {
    source: row.rel_dir === "" ? row.name : `${row.rel_dir}/${row.name}`,
    target: folder === "" ? name : `${folder}/${name}`,
    datedByFile,
    problems,
  };
}

function stemKey(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot <= 0 ? name : name.slice(0, dot)).toLowerCase();
}

function formatBytesShort(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export interface ImportFailure {
  name: string;
  source: string;
  error: string;
}

export interface ImportRunResult {
  copied: number;
  copiedBytes: number;
  /** Already at the destination, byte for byte. Counted, not copied again. */
  identical: number;
  failed: ImportFailure[];
}

/**
 * One file, copied and proved.
 *
 * The bytes go to a `.cif-part` file first and are renamed into place only
 * after being read back and hashed. An interrupted run therefore leaves either
 * the finished file or nothing that looks like one — never a truncated raw that
 * the next index would happily record as an imported copy.
 *
 * Reading back may be served from the page cache rather than the platter, so
 * this proves the copy logic and the write path rather than the disk itself.
 * That is still the difference between a verified copy and a hopeful one.
 */
async function copyVerified(
  item: ImportItem,
  hashMode: "quick" | "full",
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<"copied" | "identical"> {
  let target = item.target;

  // Something already there is either this file, in which case there is
  // nothing to do, or a different one, which keeps its name.
  for (let n = 1; ; n++) {
    const existing = await fs.stat(target).catch(() => null);
    if (!existing) break;

    if (existing.isFile() && existing.size === item.size && (await same(item.source, target, item.size, hashMode))) {
      onBytes(Math.max(0, item.size));
      return "identical";
    }
    target = withSuffix(item.target, n + 1);
    if (n > 200) throw new Error(`Too many files already named like ${item.name}.`);
  }

  const part = `${target}${PART_SUFFIX}`;
  await fs.rm(part, { force: true });

  const src = await fs.open(item.source, "r");
  let dst: Awaited<ReturnType<typeof fs.open>> | null = null;
  const hash = createHash("sha256");
  let copied = 0;

  try {
    dst = await fs.open(part, "wx");
    const buf = Buffer.allocUnsafe(COPY_CHUNK);

    for (;;) {
      if (signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
      const { bytesRead } = await src.read(buf, 0, buf.length, copied);
      if (bytesRead === 0) break;

      const slice = buf.subarray(0, bytesRead);
      hash.update(slice);
      await dst.write(slice, 0, bytesRead);
      copied += bytesRead;
      onBytes(bytesRead);
    }

    // Flush before claiming the copy is real; a rename is cheap to reorder
    // and a crash after it would leave a named file with no contents.
    await dst.sync();
    await dst.close();
    dst = null;

    const written = await fs.stat(part);
    if (written.size !== copied) {
      throw new Error(`copy is ${written.size} bytes, expected ${copied}`);
    }
    const readBack = await fullHash(part);
    if (readBack !== hash.digest("hex")) {
      throw new Error("the copy did not read back the same as the original");
    }

    // The name may have been taken while this was copying — only ever by
    // another of our own workers, but the check costs nothing next to
    // silently replacing a photograph.
    let finalTarget = target;
    for (let n = 1; ; n++) {
      if (!(await fs.stat(finalTarget).catch(() => null))) break;
      finalTarget = withSuffix(target, n + 1);
    }
    await fs.rename(part, finalTarget);
    return "copied";
  } finally {
    await src.close().catch(() => {});
    if (dst) {
      await dst.close().catch(() => {});
      await fs.rm(part, { force: true }).catch(() => {});
    }
  }
}

function withSuffix(target: string, n: number): string {
  const slash = target.lastIndexOf("/");
  const dir = target.slice(0, slash);
  const name = target.slice(slash + 1);
  return `${dir}/${disambiguate(name, n)}`;
}

async function same(
  a: string,
  b: string,
  size: number,
  mode: "quick" | "full",
): Promise<boolean> {
  try {
    if (mode === "full") return (await fullHash(a)) === (await fullHash(b));
    return (await quickHash(a, size)) === (await quickHash(b, size));
  } catch {
    return false;
  }
}

export interface ImportOptions {
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
}

/** Copies a plan. Creates destination folders; touches nothing on the card. */
export async function runImport(
  db: Db,
  config: AppConfig,
  plan: ImportPlan,
  options: ImportOptions = {},
): Promise<ImportRunResult> {
  // `db` is unused: copying reads its work entirely from the plan, which is
  // the point — the index is consulted when deciding, not while writing. Kept
  // in the signature so all three entry points here take the same shape.
  void db;
  if (plan.problems.length > 0) throw new Error(plan.problems.join(" "));

  const madeDirs = new Set<string>();
  for (const item of plan.items) {
    const dir = item.target.slice(0, item.target.lastIndexOf("/"));
    if (madeDirs.has(dir)) continue;
    await fs.mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  }

  const failed: ImportFailure[] = [];
  let copied = 0;
  let identical = 0;
  let done = 0;
  let bytes = 0;

  const report = () =>
    options.onProgress?.({
      phase: "copying",
      stage: "copy",
      message: `Copying into your library — ${done.toLocaleString()} / ${plan.items.length.toLocaleString()}`,
      done,
      total: plan.items.length,
      bytes,
      totalBytes: plan.bytes,
      // Every counted byte really is read — twice, in fact, since each copy is
      // read back to verify. So this is the rate files land in the library at,
      // which is what an estimate should be built on, rather than the rate the
      // device is moving bytes at.
      rateUnit: "bytes",
    });

  report();

  await pool(plan.items, COPY_CONCURRENCY, async (item) => {
    if (options.signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
    try {
      const outcome = await copyVerified(
        item,
        config.hashMode,
        (n) => {
          bytes += n;
        },
        options.signal,
      );
      if (outcome === "copied") copied++;
      else identical++;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      failed.push({
        name: item.name,
        source: item.source,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      done++;
      if (done % 5 === 0 || done === plan.items.length) report();
    }
  });

  report();
  return { copied, copiedBytes: bytes, identical, failed };
}

export interface ImportOutcome extends ImportRunResult {
  plan: ImportPlan;
  /** Libraries re-indexed so the new files are known. */
  reindexed: string[];
  /** Catalogs that cannot see the files until Lightroom is told to look. */
  needsSync: ImportPlan["needsSync"];
  /** The re-scan, when one could be run without waiting for a person. */
  rescan: { scanId: number; status: string } | null;
}

/**
 * Import, then put the answer back in front of the user.
 *
 * A folder library can be re-indexed and the card re-checked immediately, which
 * closes the loop: the same screen that said "312 files are missing" says the
 * card is safe. A Lightroom catalog cannot — the files are on disk but the
 * catalog has not been told, and a scan run now would report every one of them
 * still missing and undo the trust the copy just earned. So that case stops
 * here and says what to do in Lightroom, with a re-scan a click away.
 */
export async function importFromScan(
  db: Db,
  config: AppConfig,
  scanId: number,
  options: ImportOptions = {},
): Promise<ImportOutcome> {
  options.onProgress?.({ phase: "planning", stage: "copy", message: "Working out what to copy", done: 0, total: 0 });

  const plan = await planImport(db, config, scanId);
  const result = await runImport(db, config, plan, options);

  const reindexed: string[] = [];
  for (const [position, key] of plan.reindex.entries()) {
    const library = config.libraries.find((l) => l.key === key);
    if (!library) continue;

    // Each library is an equal share of the stage, filled by how far its own
    // indexing has got.
    const stages = new PhaseTracker(indexStages(library));
    const share = (overall: number) => (position + overall) / plan.reindex.length;

    options.onProgress?.({
      phase: "indexing",
      stage: "index",
      within: share(0),
      message: `Adding the new files to ${library.label}`,
      done: 0,
      total: 0,
    });
    await indexLibrary(db, library, {
      mode: "incremental",
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (p) => {
        const stage = indexStage(p.phase);
        const state = stage
          ? stages.update({ phase: stage, ...(p.done === undefined ? {} : { done: p.done }), ...(p.total === undefined ? {} : { total: p.total }) })
          : stages.state();
        options.onProgress?.({
          phase: "indexing",
          stage: "index",
          within: share(state.overall),
          message: `Adding the new files to ${library.label} — ${p.files.toLocaleString()} files`,
          done: p.done ?? p.files,
          total: p.total ?? 0,
        });
      },
    });
    reindexed.push(key);
  }

  // Copies that failed leave the card genuinely not safe, and a green verdict
  // straight afterwards would be the worst possible thing to show.
  const canRecheck = plan.needsSync.length === 0 && result.failed.length === 0;
  let rescan: ImportOutcome["rescan"] = null;

  if (canRecheck) {
    // A whole scan, filling this one segment by its own stages.
    const stages = new PhaseTracker([...SCAN_STAGES]);
    options.onProgress?.({
      phase: "rechecking",
      stage: "recheck",
      within: 0,
      message: "Checking the card again",
      done: 0,
      total: 0,
    });
    const scan: ScanResult = await scanCard(db, config, plan.root, {
      label: plan.label,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (p) =>
        options.onProgress?.({
          phase: "rechecking",
          stage: "recheck",
          within: (p.stage
            ? stages.update({ phase: p.stage, ...(p.counts === false ? {} : { done: p.done, total: p.total }) })
            : stages.state()
          ).overall,
          message: p.message,
          done: p.done,
          total: p.total,
          ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
          ...(p.totalBytes === undefined ? {} : { totalBytes: p.totalBytes }),
          ...(p.rateUnit ? { rateUnit: p.rateUnit } : {}),
        }),
    });
    rescan = { scanId: scan.scanId, status: scan.verdict.status };
  }

  options.onProgress?.({ phase: "done", message: "Done", done: plan.items.length, total: plan.items.length });

  return { ...result, plan, reindexed, needsSync: plan.needsSync, rescan };
}
