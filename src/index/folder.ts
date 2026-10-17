import type { Db } from "../core/db.ts";
import type { LibraryConfig } from "../core/config.ts";
import { classify, isLibraryMedia } from "../core/media.ts";
import { normPath, pathKey, stemOf, extOf } from "../core/paths.ts";
import { letProgressOut } from "../core/heartbeat.ts";
import { walk } from "./walk.ts";
import { emptyStats, type IndexOptions, type IndexStats } from "./types.ts";

/** Directories per write transaction. Large enough to amortise fsync, small
 *  enough that a cancelled run doesn't lose much work. */
const BATCH_DIRECTORIES = 256;

interface CachedDir {
  id: number;
  mtimeMs: number;
  entryCount: number;
}

/**
 * Indexes a folder tree into the entry table.
 *
 * Deliberately records only what `readdir` + `lstat` provide — name, size,
 * mtime. No file is opened, so a first index of a million-file library is
 * bounded by syscalls rather than by reading image headers. Capture metadata is
 * filled in later, and only for files that a card scan actually asks about.
 */
export async function indexFolderLibrary(
  db: Db,
  lib: LibraryConfig,
  options: IndexOptions = {},
): Promise<IndexStats> {
  const started = performance.now();
  const stats = emptyStats();
  const mode = options.mode ?? "incremental";
  const keepFile =
    options.keepFile ?? ((name: string, ext: string) => isLibraryMedia(classify(name, ext)));

  const row = db.upsertLibrary(lib.key, lib.label, "folder", normPath(lib.path));
  const run = row.run + 1;

  options.onProgress?.({ phase: "starting", directories: 0, files: 0, skippedDirectories: 0 });

  // Preload directory state so the walk can test "unchanged?" without a query
  // per folder. Even 100k directories is only a few MB here.
  const cache = new Map<string, CachedDir>();
  for (const d of db
    .prep("SELECT id, path_key, mtime_ms, entry_count FROM directory WHERE library_id = ?")
    .all(row.id) as Array<{ id: number; path_key: string; mtime_ms: number; entry_count: number }>) {
    cache.set(d.path_key, { id: d.id, mtimeMs: d.mtime_ms, entryCount: d.entry_count });
  }

  const upsertDir = db.prep(`
    INSERT INTO directory (library_id, path, path_key, mtime_ms, entry_count, seen_run, created_run)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(library_id, path_key) DO UPDATE SET
      path        = excluded.path,
      mtime_ms    = excluded.mtime_ms,
      entry_count = excluded.entry_count,
      seen_run    = excluded.seen_run
    RETURNING id
  `);

  const touchDir = db.prep("UPDATE directory SET seen_run = ? WHERE id = ?");
  const touchEntries = db.prep("UPDATE entry SET seen_run = ? WHERE dir_id = ?");

  const upsertEntry = db.prep(`
    INSERT INTO entry (
      library_id, dir_id, name, name_key, stem, ext, kind, size, mtime_ms,
      present, seen_run, created_run
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(dir_id, name_key) DO UPDATE SET
      name      = excluded.name,
      size      = excluded.size,
      mtime_ms  = excluded.mtime_ms,
      present   = 1,
      seen_run  = excluded.seen_run,
      -- Cached metadata and hashes stay valid only while size and mtime hold.
      meta_state  = CASE WHEN entry.size = excluded.size AND entry.mtime_ms = excluded.mtime_ms
                         THEN entry.meta_state ELSE 'pending' END,
      captured_at = CASE WHEN entry.size = excluded.size AND entry.mtime_ms = excluded.mtime_ms
                         THEN entry.captured_at ELSE NULL END,
      camera_key  = CASE WHEN entry.size = excluded.size AND entry.mtime_ms = excluded.mtime_ms
                         THEN entry.camera_key ELSE NULL END,
      orig_stem   = CASE WHEN entry.size = excluded.size AND entry.mtime_ms = excluded.mtime_ms
                         THEN entry.orig_stem ELSE NULL END,
      quick_hash  = CASE WHEN entry.size = excluded.size AND entry.mtime_ms = excluded.mtime_ms
                         THEN entry.quick_hash ELSE NULL END,
      full_hash   = CASE WHEN entry.size = excluded.size AND entry.mtime_ms = excluded.mtime_ms
                         THEN entry.full_hash ELSE NULL END
    RETURNING created_run
  `);

  type PendingDir = {
    path: string;
    mtimeMs: number;
    unchanged: boolean;
    files: Array<{ name: string; size: number; mtimeMs: number }>;
    fileCount: number;
  };
  let batch: PendingDir[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    const work = batch;
    batch = [];

    db.tx(() => {
      for (const dir of work) {
        const key = pathKey(dir.path);
        const cached = cache.get(key);

        if (dir.unchanged && cached) {
          touchDir.run(run, cached.id);
          touchEntries.run(run, cached.id);
          continue;
        }

        const inserted = upsertDir.get(
          row.id,
          dir.path,
          key,
          dir.mtimeMs,
          dir.fileCount,
          run,
          run,
        ) as { id: number };
        cache.set(key, { id: inserted.id, mtimeMs: dir.mtimeMs, entryCount: dir.fileCount });

        for (const file of dir.files) {
          const ext = extOf(file.name);
          const kind = classify(file.name, ext);
          const result = upsertEntry.get(
            row.id,
            inserted.id,
            file.name,
            file.name.toLowerCase(),
            stemOf(file.name),
            ext,
            kind,
            file.size,
            file.mtimeMs,
            run,
            run,
          ) as { created_run: number } | undefined;

          if (result && result.created_run === run) stats.added++;
        }
      }
    });
  };

  const walkResult = await walk(
    normPath(lib.path),
    {
      excludeDirs: lib.excludes,
      keepFile,
      isUnchanged: (dirPath, mtimeMs) => {
        if (mode === "full") return false;
        const cached = cache.get(pathKey(dirPath));
        return cached !== undefined && cached.mtimeMs === mtimeMs;
      },
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (directories, files) => {
        options.onProgress?.({
          phase: "walking",
          directories,
          files,
          skippedDirectories: stats.skippedDirectories,
        });
      },
    },
    (dir) => {
      batch.push(dir);
      if (batch.length >= BATCH_DIRECTORIES) flush();
    },
  );

  flush();

  stats.directories = walkResult.directories;
  stats.files = walkResult.files;
  stats.skippedDirectories = walkResult.skippedDirectories;
  stats.errors = walkResult.errors;

  options.onProgress?.({
    phase: "sweeping",
    directories: stats.directories,
    files: stats.files,
    skippedDirectories: stats.skippedDirectories,
  });
  await letProgressOut();

  // Anything not re-marked during this run is gone from disk.
  db.tx(() => {
    const removed = db.prep("DELETE FROM entry WHERE library_id = ? AND seen_run < ?").run(row.id, run);
    stats.removed = Number(removed.changes);
    db.prep("DELETE FROM directory WHERE library_id = ? AND seen_run < ?").run(row.id, run);
  });

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
    skippedDirectories: stats.skippedDirectories,
  });

  return stats;
}
