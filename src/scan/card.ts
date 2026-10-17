import path from "node:path";
import type { Db } from "../core/db.ts";
import type { AppConfig } from "../core/config.ts";
import { classify, isRequired } from "../core/media.ts";
import { EMPTY_META, readCaptureMeta } from "../core/metadata.ts";
import type { RateUnit } from "../core/rate.ts";
import type { Phase } from "../core/phases.ts";
import { extOf, joinPath, normPath } from "../core/paths.ts";
import { pool, IO_CONCURRENCY } from "../core/pool.ts";
import { walk } from "../index/walk.ts";
import { Matcher, type CardFile, type FileVerdict, type MatchProgress } from "./match.ts";
import { buildRollup, type CardVerdict, type DirNode, type ScanFileRecord } from "./verdict.ts";

/**
 * Scanning a card end to end.
 *
 * Cards are the small side of the comparison — a few thousand files at most —
 * so this reads capture metadata for every one of them up front. That is what
 * lets the matcher start from strong signals and keeps expensive work off the
 * library side, which is where the millions of files live.
 *
 * Nothing here ever writes to, deletes from, or unmounts the card. The tool
 * reports; formatting stays a deliberate act performed elsewhere.
 */

export type ScanPhase = "walking" | "reading" | "matching" | "saving" | "done";

/**
 * The stages a person sees: one segment of the progress bar each. They are
 * coarser than the steps that report — the matcher alone runs several passes —
 * and the last two are only reached when cheaper evidence ran out, so most
 * scans finish with them marked as not needed.
 */
export const SCAN_STAGES = [
  { key: "card", label: "Find files" },
  { key: "capture", label: "Read capture times" },
  { key: "compare", label: "Compare" },
  { key: "library", label: "Check library files" },
  { key: "verify", label: "Verify contents" },
] as const satisfies readonly Phase[];

export type ScanStage = (typeof SCAN_STAGES)[number]["key"];

/**
 * Where each of the matcher's passes falls. Finding which files need hashing
 * counts the whole card, which says nothing about how much hashing is left, so
 * it moves the bar into "verify" without filling it. The closing report
 * belongs to no stage: saving is not verifying.
 */
const MATCH_STAGES: Record<MatchProgress["phase"], { stage?: ScanStage; counts?: boolean }> = {
  capture: { stage: "compare" },
  lookup: { stage: "compare" },
  metadata: { stage: "library" },
  collecting: { stage: "verify", counts: false },
  hashing: { stage: "verify" },
  done: { counts: false },
};

export interface ScanProgress {
  phase: ScanPhase;
  /** Which segment of the bar this belongs to. Absent: no change of stage. */
  stage?: ScanStage;
  /** False when done/total count something other than the stage's own work. */
  counts?: boolean;
  message: string;
  done: number;
  total: number;
  /** Media covered by the phases that open files, for throughput and an ETA. */
  bytes?: number;
  totalBytes?: number;
  rateUnit?: RateUnit;
}

export interface ScanOptions {
  label?: string;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
}

export interface ScanResult {
  scanId: number;
  root: string;
  label: string;
  rule: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  verdict: CardVerdict;
  tree: DirNode;
  warnings: string[];
  stats: {
    metadataReads: number;
    hashReads: number;
    /** Card files a catalog imported and no longer holds a copy of. */
    deletedSinceImport: number;
    /**
     * Times the enrichment-target lookup hit its cap. Diagnostic: it selects
     * which library files to open, never what a verdict is.
     */
    truncated: number;
    /** Libraries that needed a one-time full metadata read during this scan. */
    escalatedLibraries: string[];
  };
}

/** Path relative to the card root, forward slashes, "" at the root. */
function relativeTo(root: string, absolute: string): string {
  const base = root.replace(/\/+$/, "");
  const rest = absolute.startsWith(base) ? absolute.slice(base.length) : absolute;
  return rest.replace(/^\/+/, "");
}

export async function scanCard(
  db: Db,
  config: AppConfig,
  root: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const startedAt = Date.now();
  const started = performance.now();
  const cardRoot = normPath(root);
  const warnings: string[] = [];

  if (config.rule.trim() === "") {
    throw new Error("No rule configured — set up at least one library first.");
  }

  // ---- Walk the card ----------------------------------------------------
  options.onProgress?.({ phase: "walking", stage: "card", message: "Reading card", done: 0, total: 0 });

  const ignoreExt = new Set(config.ignoreExtensions);
  const files: CardFile[] = [];

  const walkResult = await walk(
    cardRoot,
    {
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (dirs, count) =>
        options.onProgress?.({
          phase: "walking",
          stage: "card",
          message: `Reading card — ${count.toLocaleString()} files in ${dirs.toLocaleString()} folders`,
          done: count,
          total: 0,
        }),
    },
    (dir) => {
      const relDir = relativeTo(cardRoot, dir.path);
      for (const entry of dir.files) {
        const ext = extOf(entry.name);
        const kind = classify(entry.name, ext);
        const required = !ignoreExt.has(ext) && isRequired(kind, config.ignoreSidecars);

        files.push({
          relDir,
          name: entry.name,
          ext,
          kind,
          required,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          absPath: joinPath(dir.path, entry.name),
          meta: EMPTY_META,
          quickHash: null,
          fullHash: null,
        });
      }
    },
  );

  for (const err of walkResult.errors) {
    warnings.push(`Could not read ${err.path}: ${err.message}`);
  }

  // ---- Read capture metadata for every file that must be matched --------
  const needMeta = files.filter((f) => f.required);
  let metaDone = 0;
  let metaFailed = 0;

  await pool(needMeta, IO_CONCURRENCY, async (file) => {
    if (options.signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
    const result = await readCaptureMeta(file.absPath, file.ext);
    file.meta = result.meta;
    file.metaState = result.state;
    if (result.state === "error") metaFailed++;
    metaDone++;
    if (metaDone % 25 === 0 || metaDone === needMeta.length) {
      options.onProgress?.({
        phase: "reading",
        stage: "capture",
        message: `Reading capture metadata — ${metaDone.toLocaleString()} / ${needMeta.length.toLocaleString()}`,
        done: metaDone,
        total: needMeta.length,
      });
    }
  });

  // ---- Match against the libraries --------------------------------------
  const matcher = new Matcher(db, config);
  if (matcher.libraryKeys.length === 0) {
    throw new Error("No enabled libraries have been indexed yet.");
  }

  const summary = await matcher.run(files, {
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (p) =>
      options.onProgress?.({
        phase: "matching",
        ...MATCH_STAGES[p.phase],
        message:
          p.phase === "capture"
            ? `Matching capture times — ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
            : p.phase === "lookup"
            ? `Comparing against libraries — ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
            : p.phase === "metadata"
              ? `Checking library capture metadata — ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
              : p.phase === "collecting"
                ? `Finding files to verify — ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
              : p.phase === "hashing"
                ? `Verifying contents — ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
                : "Comparing against libraries",
        done: p.done,
        total: p.total,
        ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
        ...(p.totalBytes === undefined ? {} : { totalBytes: p.totalBytes }),
        // Hashing reads every byte it counts; reading capture times does not.
        rateUnit: p.phase === "hashing" ? "bytes" : "files",
      }),
  });

  for (const key of summary.emptyLibraries) {
    warnings.push(
      `Library "${key}" has no indexed files — everything will look missing from it until you index it.`,
    );
  }

  // A catalog goes on saying a file was imported long after the copy is
  // culled, moved out, or deleted outside Lightroom. Reading that as
  // "backed up" is the one mistake that loses work, so it is said out loud
  // rather than folded into the blocked count.
  if (summary.deletedSinceImport > 0) {
    const n = summary.deletedSinceImport;
    warnings.push(
      n === 1
        ? "1 file was imported into a catalog, but the copy it points at is no longer there. It is counted as still needing import."
        : `${n.toLocaleString()} files were imported into a catalog, but the copies they point at are no longer there. They are counted as still needing import.`,
    );
  }

  // Silence here once hid a whole card's worth of failed reads, and the
  // name-and-size matches they should have challenged cleared it instead.
  if (metaFailed > 0) {
    warnings.push(
      metaFailed === 1
        ? "The capture time of 1 file could not be read. It was checked by its contents instead of its filename."
        : `The capture times of ${metaFailed.toLocaleString()} files could not be read. They were checked by their contents instead of their filenames.`,
    );
  }

  // ---- Persist ----------------------------------------------------------
  options.onProgress?.({ phase: "saving", message: "Saving results", done: 0, total: 0 });

  const label = options.label ?? path.basename(cardRoot.replace(/\/+$/, "")) ?? cardRoot;
  const scanId = persist(db, cardRoot, label, config, summary.verdicts, startedAt);

  const records: ScanFileRecord[] = summary.verdicts.map((v) => ({
    relDir: v.file.relDir,
    name: v.file.name,
    required: v.file.required,
    size: v.file.size,
    satisfied: v.satisfied,
    gap: v.gap,
  }));

  const { tree, verdict } = buildRollup(records);
  const finishedAt = Date.now();

  // Warnings ride along in the stats blob so reopening an old scan still
  // explains, for instance, that a library had never been indexed.
  db.prep("UPDATE scan SET finished_at = ?, status = 'done', stats = ? WHERE id = ?").run(
    finishedAt,
    JSON.stringify({ ...verdict, warnings }),
    scanId,
  );

  options.onProgress?.({ phase: "done", message: "Done", done: files.length, total: files.length });

  return {
    scanId,
    root: cardRoot,
    label,
    rule: config.rule,
    startedAt,
    finishedAt,
    durationMs: Math.round(performance.now() - started),
    verdict,
    tree,
    warnings,
    stats: {
      metadataReads: summary.metadataReads,
      hashReads: summary.hashReads,
      deletedSinceImport: summary.deletedSinceImport,
      truncated: summary.truncated,
      escalatedLibraries: summary.escalatedLibraries,
    },
  };
}

function persist(
  db: Db,
  root: string,
  label: string,
  config: AppConfig,
  verdicts: FileVerdict[],
  startedAt: number,
): number {
  const scan = db.prep(
    `INSERT INTO scan (root, label, rule, min_tier, started_at, status)
     VALUES (?, ?, ?, ?, ?, 'running') RETURNING id`,
  );
  const scanId = (
    scan.get(root, label, config.rule, config.minTier, startedAt) as { id: number }
  ).id;

  const insert = db.prep(`
    INSERT INTO scan_file (
      scan_id, rel_dir, name, ext, kind, required, size, mtime_ms,
      captured_at, camera_key, satisfied, gap, matches
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.tx(() => {
    for (const v of verdicts) {
      insert.run(
        scanId,
        v.file.relDir,
        v.file.name,
        v.file.ext,
        v.file.kind,
        v.file.required ? 1 : 0,
        v.file.size,
        v.file.mtimeMs,
        v.file.meta.capturedAt,
        v.file.meta.cameraKey,
        v.satisfied ? 1 : 0,
        v.gap,
        JSON.stringify(v.matches),
      );
    }
  });

  return scanId;
}
