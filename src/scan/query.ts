import type { Db } from "../core/db.ts";
import type { LibraryMatch } from "./match.ts";
import { buildRollup, type CardVerdict, type DirNode, type ScanFileRecord } from "./verdict.ts";

/** Reading finished scans back out — used by both the API and the tests. */

export interface ScanRow {
  id: number;
  root: string;
  label: string | null;
  rule: string;
  min_tier: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  error: string | null;
  stats: string | null;
}

export interface ScanFileRow {
  id: number;
  rel_dir: string;
  name: string;
  ext: string;
  kind: string;
  required: number;
  size: number;
  mtime_ms: number;
  captured_at: number | null;
  camera_key: string | null;
  satisfied: number;
  gap: string | null;
  matches: string;
}

export interface ScanFile {
  id: number;
  relDir: string;
  name: string;
  ext: string;
  kind: string;
  required: boolean;
  size: number;
  /** Naive YYYYMMDDHHMMSS, or null when nothing could date the file. */
  capturedAt: number | null;
  /** Filesystem mtime — the fallback date when there is no capture time. */
  mtimeMs: number;
  cameraKey: string | null;
  satisfied: boolean;
  gap: string;
  matches: Record<string, LibraryMatch>;
}

function toScanFile(row: ScanFileRow): ScanFile {
  let matches: Record<string, LibraryMatch> = {};
  try {
    matches = JSON.parse(row.matches) as Record<string, LibraryMatch>;
  } catch {
    // A malformed blob should degrade to "no detail", not break the listing.
  }
  return {
    id: row.id,
    relDir: row.rel_dir,
    name: row.name,
    ext: row.ext,
    kind: row.kind,
    required: row.required === 1,
    size: row.size,
    capturedAt: row.captured_at,
    mtimeMs: row.mtime_ms,
    cameraKey: row.camera_key,
    satisfied: row.satisfied === 1,
    gap: row.gap ?? "",
    matches,
  };
}

export function listScans(db: Db, limit = 25): ScanRow[] {
  return db.allAs<ScanRow>("SELECT * FROM scan ORDER BY started_at DESC LIMIT ?", limit);
}

/**
 * One file from a scan, looked up by both ids.
 *
 * Scoping to the scan is the point: the only thing a caller supplies is a
 * number, and it can only ever name a file that scan actually recorded.
 */
export function getScanFileRow(db: Db, scanId: number, fileId: number): ScanFileRow | undefined {
  return db.getAs<ScanFileRow>(
    "SELECT * FROM scan_file WHERE id = ? AND scan_id = ?",
    fileId,
    scanId,
  );
}

export function getScanRow(db: Db, id: number): ScanRow | undefined {
  return db.getAs<ScanRow>("SELECT * FROM scan WHERE id = ?", id);
}

/** Rebuilds the directory rollup for a stored scan. */
export function getScanTree(db: Db, id: number): { tree: DirNode; verdict: CardVerdict } {
  const records = db.allAs<{
    rel_dir: string;
    name: string;
    required: number;
    size: number;
    satisfied: number;
    gap: string | null;
  }>(
    "SELECT rel_dir, name, required, size, satisfied, gap FROM scan_file WHERE scan_id = ?",
    id,
  );

  const mapped: ScanFileRecord[] = records.map((r) => ({
    relDir: r.rel_dir,
    name: r.name,
    required: r.required === 1,
    size: r.size,
    satisfied: r.satisfied === 1,
    gap: r.gap ?? "",
  }));

  return buildRollup(mapped);
}

export interface ScanFileQuery {
  /** Limit to one directory. Use `recursive` to include its subdirectories. */
  dir?: string;
  recursive?: boolean;
  onlyBlocked?: boolean;
  limit?: number;
  offset?: number;
}

export function getScanFiles(
  db: Db,
  id: number,
  query: ScanFileQuery = {},
): { files: ScanFile[]; total: number } {
  const where: string[] = ["scan_id = ?"];
  const params: Array<string | number> = [id];

  if (query.dir !== undefined) {
    if (query.recursive && query.dir !== "") {
      where.push("(rel_dir = ? OR rel_dir LIKE ?)");
      params.push(query.dir, `${query.dir}/%`);
    } else if (!query.recursive) {
      where.push("rel_dir = ?");
      params.push(query.dir);
    }
  }
  if (query.onlyBlocked) where.push("satisfied = 0 AND required = 1");

  const clause = where.join(" AND ");
  const total =
    db.getAs<{ n: number }>(`SELECT COUNT(*) AS n FROM scan_file WHERE ${clause}`, ...params)?.n ?? 0;

  const rows = db.allAs<ScanFileRow>(
    `SELECT * FROM scan_file WHERE ${clause} ORDER BY rel_dir, name LIMIT ? OFFSET ?`,
    ...params,
    query.limit ?? 500,
    query.offset ?? 0,
  );

  return { files: rows.map(toScanFile), total };
}

/**
 * Forgets a scan.
 *
 * Only the report goes: the card and the libraries are never touched by this
 * tool, and a deleted scan can be produced again by scanning the card again.
 * `scan_file` rows follow through the foreign key.
 */
export function deleteScan(db: Db, id: number): void {
  db.prep("DELETE FROM scan WHERE id = ?").run(id);
}

/** Forgets every scan. Returns how many there were. */
export function deleteAllScans(db: Db): number {
  const before = db.getAs<{ n: number }>("SELECT COUNT(*) AS n FROM scan")?.n ?? 0;
  db.prep("DELETE FROM scan").run();
  return before;
}
