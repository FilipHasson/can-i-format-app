import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../core/db.ts";
import type { LibraryConfig } from "../core/config.ts";
import { classify } from "../core/media.ts";
import { buildCameraKey, parseExifDate } from "../core/metadata.ts";
import { cacheDir, extOf, normPath, pathKey, stemOf } from "../core/paths.ts";
import { Heartbeat, letProgressOut } from "../core/heartbeat.ts";
import { emptyStats, type IndexOptions, type IndexStats } from "./types.ts";

/**
 * Reads a Lightroom Classic catalog directly.
 *
 * This is worth the trouble for one reason: the catalog knows a photo was
 * imported even when the file on disk was later renamed, converted to DNG,
 * moved, or deleted. A folder scan cannot tell you any of that. It also hands
 * us capture time and camera body for free — the exact fields that make
 * matching survive an import pipeline — with no image headers to read.
 *
 * Catalog schemas drift between Lightroom versions, so every optional table and
 * column is probed before use and simply contributes less signal when absent.
 */

const BATCH_ROWS = 2000;

interface CatalogRow {
  rootPath: string | null;
  subPath: string | null;
  baseName: string | null;
  extension: string | null;
  originalFilename?: string | null;
  md5?: string | null;
  captureTime?: string | null;
  cameraModel?: string | null;
  cameraSerial?: string | null;
}

function isSafeIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function tableExists(cat: DatabaseSync, name: string): boolean {
  const row = cat
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function tableColumns(cat: DatabaseSync, name: string): Set<string> {
  if (!isSafeIdent(name)) return new Set();
  try {
    const rows = cat.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/**
 * Lightroom keeps the catalog open and locked while running. Work on a copy —
 * including the WAL, or we would silently read a stale snapshot.
 */
async function copyCatalog(source: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = path.join(cacheDir(), "lrcat");
  await fs.mkdir(dir, { recursive: true });

  const target = path.join(dir, `${path.basename(source)}.${process.pid}.copy`);
  await fs.copyFile(source, target);

  const sidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await fs.copyFile(`${source}${suffix}`, `${target}${suffix}`);
      sidecars.push(`${target}${suffix}`);
    } catch {
      // Absent when the catalog is not in WAL mode or is cleanly closed.
    }
  }

  return {
    file: target,
    cleanup: async () => {
      for (const f of [target, ...sidecars]) {
        await fs.rm(f, { force: true }).catch(() => {});
      }
    },
  };
}

function openCatalog(file: string): DatabaseSync {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    // A WAL catalog copied without a usable -shm cannot open read-only. It is
    // our own throwaway copy, so opening it writable is harmless.
    return new DatabaseSync(file);
  }
}

function buildQuery(cat: DatabaseSync): string {
  const fileCols = tableColumns(cat, "AgLibraryFile");
  const select: string[] = [
    "rf.absolutePath AS rootPath",
    "fo.pathFromRoot AS subPath",
    "fi.baseName AS baseName",
    "fi.extension AS extension",
  ];
  const joins: string[] = [
    "JOIN AgLibraryFolder fo ON fo.id_local = fi.folder",
    "JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder",
  ];

  if (fileCols.has("originalFilename")) select.push("fi.originalFilename AS originalFilename");
  if (fileCols.has("md5")) select.push("fi.md5 AS md5");

  const hasImages = tableExists(cat, "Adobe_images");
  if (hasImages) {
    const imageCols = tableColumns(cat, "Adobe_images");
    if (imageCols.has("captureTime")) select.push("im.captureTime AS captureTime");
    joins.push("LEFT JOIN Adobe_images im ON im.rootFile = fi.id_local");

    if (tableExists(cat, "AgHarvestedExifMetadata")) {
      const exifCols = tableColumns(cat, "AgHarvestedExifMetadata");
      joins.push("LEFT JOIN AgHarvestedExifMetadata hm ON hm.image = im.id_local");

      if (exifCols.has("cameraModelRef") && tableExists(cat, "AgInternedExifCameraModel")) {
        select.push("cm.value AS cameraModel");
        joins.push("LEFT JOIN AgInternedExifCameraModel cm ON cm.id_local = hm.cameraModelRef");
      }
      if (exifCols.has("cameraSNRef") && tableExists(cat, "AgInternedExifCameraSN")) {
        select.push("sn.value AS cameraSerial");
        joins.push("LEFT JOIN AgInternedExifCameraSN sn ON sn.id_local = hm.cameraSNRef");
      }
    }
  }

  // GROUP BY collapses virtual copies, which share a rootFile and would
  // otherwise each produce a duplicate entry for the same file on disk.
  return `SELECT ${select.join(", ")} FROM AgLibraryFile fi ${joins.join(" ")} GROUP BY fi.id_local`;
}

/** Joins root + relative folder + basename, tolerating stray slashes. */
function buildPath(root: string, sub: string, name: string): string {
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  const trimmedSub = sub.replace(/^[\\/]+|[\\/]+$/g, "");
  const dir = trimmedSub === "" ? trimmedRoot : `${trimmedRoot}/${trimmedSub}`;
  return `${dir}/${name}`;
}

export async function indexLightroomLibrary(
  db: Db,
  lib: LibraryConfig,
  options: IndexOptions = {},
): Promise<IndexStats> {
  const started = performance.now();
  const stats = emptyStats();

  const source = normPath(lib.path);
  const row = db.upsertLibrary(lib.key, lib.label, "lightroom", source);
  const run = row.run + 1;

  // A catalog runs to gigabytes, and copying it is most of a re-index that
  // finds nothing new. Said, so the banner is not left on "Starting".
  options.onProgress?.({ phase: "copying-catalog", directories: 0, files: 0, skippedDirectories: 0 });

  const copy = await copyCatalog(source);
  let cat: DatabaseSync;
  try {
    cat = openCatalog(copy.file);
  } catch (err) {
    await copy.cleanup();
    throw new Error(`Could not open Lightroom catalog ${source}: ${(err as Error).message}`);
  }

  if (!tableExists(cat, "AgLibraryFile")) {
    cat.close();
    await copy.cleanup();
    throw new Error(
      `${path.basename(source)} does not look like a Lightroom Classic catalog (no AgLibraryFile table).`,
    );
  }

  const upsertDir = db.prep(`
    INSERT INTO directory (library_id, path, path_key, mtime_ms, entry_count, seen_run, created_run)
    VALUES (?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(library_id, path_key) DO UPDATE SET path = excluded.path, seen_run = excluded.seen_run
    RETURNING id
  `);

  const upsertEntry = db.prep(`
    INSERT INTO entry (
      library_id, dir_id, name, name_key, stem, ext, kind, size, mtime_ms,
      present, seen_run, created_run, meta_state, captured_at, camera_key, orig_stem, catalog_md5
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, -1, 0, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dir_id, name_key) DO UPDATE SET
      name        = excluded.name,
      seen_run    = excluded.seen_run,
      meta_state  = excluded.meta_state,
      captured_at = excluded.captured_at,
      camera_key  = excluded.camera_key,
      orig_stem   = excluded.orig_stem,
      catalog_md5 = excluded.catalog_md5
    RETURNING created_run
  `);

  const dirIds = new Map<string, number>();
  // The catalog's own answer to "where do my files live", which an import
  // needs in order to put a new file somewhere Lightroom will accept it.
  const roots = new Set<string>();
  let pending: CatalogRow[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const work = pending;
    pending = [];

    db.tx(() => {
      for (const r of work) {
        if (!r.rootPath || !r.baseName) continue;
        roots.add(normPath(r.rootPath.replace(/[\\/]+$/, "")));

        const ext = (r.extension ?? "").toLowerCase();
        const name = ext === "" ? r.baseName : `${r.baseName}.${ext}`;
        const fullPath = buildPath(r.rootPath, r.subPath ?? "", name);
        const dirPath = fullPath.slice(0, fullPath.lastIndexOf("/"));
        const dirKey = pathKey(dirPath);

        let dirId = dirIds.get(dirKey);
        if (dirId === undefined) {
          dirId = (upsertDir.get(row.id, dirPath, dirKey, run, run) as { id: number }).id;
          dirIds.set(dirKey, dirId);
        }

        const capturedAt = parseExifDate(r.captureTime ?? null);
        const cameraKey = buildCameraKey(null, r.cameraModel ?? null, r.cameraSerial ?? null);
        // `originalFilename` is the name at import time, which for a
        // convert-to-DNG import is still the camera's original .CR3/.NEF name.
        const origStem = r.originalFilename ? stemOf(r.originalFilename) : null;
        const hasMeta = capturedAt !== null || cameraKey !== null || origStem !== null;

        const result = upsertEntry.get(
          row.id,
          dirId,
          name,
          name.toLowerCase(),
          stemOf(name),
          extOf(name),
          classify(name, extOf(name)),
          run,
          run,
          hasMeta ? "ok" : "none",
          capturedAt,
          cameraKey,
          origStem && origStem !== stemOf(name) ? origStem : null,
          r.md5 ? r.md5.toLowerCase() : null,
        ) as { created_run: number } | undefined;

        if (result && result.created_run === run) stats.added++;
        stats.files++;
      }
    });
  };

  try {
    const query = buildQuery(cat);
    // Counted first so the bar fills toward something. Reading the catalog
    // never awaits, so without the heartbeat below not one of these reports
    // would leave the process before the job had already finished.
    const total = (cat.prepare(`SELECT COUNT(*) AS n FROM (${query})`).get() as { n: number }).n;
    const report = () =>
      options.onProgress?.({
        phase: "reading-catalog",
        directories: dirIds.size,
        files: stats.files,
        skippedDirectories: 0,
        done: stats.files,
        total,
      });
    report();
    const heartbeat = new Heartbeat();

    for (const raw of cat.prepare(query).iterate() as Iterable<CatalogRow>) {
      if (options.signal?.aborted) throw new DOMException("Index aborted", "AbortError");

      pending.push(raw);
      if (pending.length >= BATCH_ROWS) {
        flush();
        await heartbeat.beat(report);
      }
    }
    flush();
    report();
  } finally {
    cat.close();
    await copy.cleanup();
  }

  options.onProgress?.({
    phase: "sweeping",
    directories: dirIds.size,
    files: stats.files,
    skippedDirectories: 0,
  });
  await letProgressOut();

  db.tx(() => {
    const removed = db.prep("DELETE FROM entry WHERE library_id = ? AND seen_run < ?").run(row.id, run);
    stats.removed = Number(removed.changes);
    db.prep("DELETE FROM directory WHERE library_id = ? AND seen_run < ?").run(row.id, run);
  });

  stats.directories = dirIds.size;
  stats.roots = [...roots];
  stats.files = db.countEntries(row.id);
  stats.withMetadata = (
    db.prep("SELECT COUNT(*) AS n FROM entry WHERE library_id = ? AND meta_state = 'ok'").get(row.id) as {
      n: number;
    }
  ).n;
  stats.durationMs = Math.round(performance.now() - started);

  db.prep("UPDATE library SET run = ?, last_indexed_at = ?, stats = ? WHERE id = ?").run(
    run,
    Date.now(),
    JSON.stringify(stats),
    row.id,
  );

  options.onProgress?.({
    phase: "done",
    directories: stats.directories,
    files: stats.files,
    skippedDirectories: 0,
  });

  return stats;
}
