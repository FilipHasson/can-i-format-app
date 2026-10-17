import fs from "node:fs/promises";
import type { Db } from "../core/db.ts";
import { readCaptureMeta } from "../core/metadata.ts";
import { tryFullHash, tryQuickHash } from "../core/hash.ts";
import { pool, IO_CONCURRENCY } from "../core/pool.ts";
import { joinPath } from "../core/paths.ts";

/**
 * Fills in the expensive per-file signals — capture metadata and content
 * hashes — for a specific set of library entries.
 *
 * This is the other half of the efficiency story. Indexing records only what
 * `readdir`/`lstat` give us; nothing here runs until a card scan finds a file
 * whose fate is genuinely uncertain, and results are cached against (size,
 * mtime) so the work is never repeated. A library can serve hundreds of scans
 * having had metadata read for only the few thousand files that mattered.
 */

/** SQLite's default limit is 999 bound parameters. */
const CHUNK = 400;
/** What tryQuickHash reads per file: 64KB from each end. */
const QUICK_HASH_SAMPLE = 128 * 1024;

export interface EnrichProgress {
  done: number;
  total: number;
  /** Bytes of media covered, and the total to cover. Sizes come from the
   *  index, so a catalog row with no size yet contributes nothing. */
  bytes: number;
  totalBytes: number;
}

interface EnrichRow {
  id: number;
  dir_path: string;
  name: string;
  ext: string;
  size: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fetchRows(db: Db, ids: readonly number[], onlyPending: boolean): EnrichRow[] {
  const rows: EnrichRow[] = [];
  for (const group of chunk(ids, CHUNK)) {
    const placeholders = group.map(() => "?").join(",");
    rows.push(
      ...db.allAs<EnrichRow>(
        `SELECT e.id, d.path AS dir_path, e.name, e.ext, e.size
           FROM entry e
           JOIN directory d ON d.id = e.dir_id
          WHERE e.id IN (${placeholders})
            ${onlyPending ? "AND e.meta_state = 'pending'" : ""}`,
        ...group,
      ),
    );
  }
  return rows;
}

/**
 * Reads capture metadata for the given entries.
 *
 * Also opportunistically repairs two things: a Lightroom catalog row has no
 * size until we stat the real file, and an entry whose file has vanished gets
 * marked absent rather than silently continuing to satisfy rules.
 */
export async function enrichEntries(
  db: Db,
  ids: readonly number[],
  options: { signal?: AbortSignal; onProgress?: (p: EnrichProgress) => void } = {},
): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = fetchRows(db, ids, true);
  if (rows.length === 0) return 0;

  const update = db.prep(`
    UPDATE entry
       SET meta_state = ?, captured_at = ?, camera_key = ?, orig_stem = ?,
           size = ?, mtime_ms = ?, present = ?
     WHERE id = ?
  `);

  // Both figures come from the index, so they stay consistent with each
  // other. A catalog row with no size yet contributes nothing to either and
  // the estimate falls back to counting files.
  const totalBytes = rows.reduce((sum, r) => sum + Math.max(0, r.size), 0);
  let done = 0;
  let bytes = 0;

  const results = await pool(rows, IO_CONCURRENCY, async (row) => {
    if (options.signal?.aborted) return null;

    const file = joinPath(row.dir_path, row.name);
    let size = row.size;
    let mtimeMs = 0;
    let present = 1;

    try {
      const st = await fs.stat(file);
      size = st.size;
      mtimeMs = Math.round(st.mtimeMs);
    } catch {
      // The catalog knows about a file that is no longer on disk, or a folder
      // entry disappeared between the index run and now.
      present = 0;
    }

    const meta = present === 1 ? await readCaptureMeta(file, row.ext) : null;
    done++;
    bytes += Math.max(0, row.size);
    options.onProgress?.({ done, total: rows.length, bytes, totalBytes });

    return { row, meta, size, mtimeMs, present };
  });

  db.tx(() => {
    for (const r of results) {
      if (!r) continue;
      if (r.present === 0) {
        update.run("error", null, null, null, r.row.size, 0, 0, r.row.id);
        continue;
      }
      const meta = r.meta;
      update.run(
        meta?.state ?? "none",
        meta?.meta.capturedAt ?? null,
        meta?.meta.cameraKey ?? null,
        meta?.meta.origStem ?? null,
        r.size,
        r.mtimeMs,
        1,
        r.row.id,
      );
    }
  });

  return results.filter(Boolean).length;
}

/**
 * Reads metadata for every not-yet-read file in a library.
 *
 * Only worth running when imports rename files, since filename narrowing is
 * then unavailable and the matcher has to fall back on capture time alone.
 * Exposed as the `full` metadata mode on a library.
 */
export async function enrichLibrary(
  db: Db,
  libraryId: number,
  options: { signal?: AbortSignal; onProgress?: (p: EnrichProgress) => void } = {},
): Promise<number> {
  const pending = db.allAs<{ id: number }>(
    "SELECT id FROM entry WHERE library_id = ? AND meta_state = 'pending'",
    libraryId,
  );
  if (pending.length === 0) return 0;

  const ids = pending.map((p) => p.id);
  const totalBytes =
    db.getAs<{ n: number }>(
      "SELECT COALESCE(SUM(MAX(size, 0)), 0) AS n FROM entry WHERE library_id = ? AND meta_state = 'pending'",
      libraryId,
    )?.n ?? 0;

  let processed = 0;
  let coveredBytes = 0;

  // Chunked so progress is reported steadily and a cancel takes effect
  // promptly, rather than after one enormous batch.
  for (const group of chunk(ids, 500)) {
    if (options.signal?.aborted) break;
    let inGroup = 0;
    await enrichEntries(db, group, {
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (p) => {
        inGroup = p.bytes;
        options.onProgress?.({
          done: processed + p.done,
          total: ids.length,
          bytes: coveredBytes + p.bytes,
          totalBytes,
        });
      },
    });
    processed += group.length;
    coveredBytes += inGroup;
  }

  return processed;
}

/**
 * Fills in the file size for catalog rows, which arrive without one.
 *
 * A Lightroom catalog records what was imported, not how big it is, so those
 * rows carry `size = -1` and can never match a card file on name and size —
 * leaving capture identity as the only route in. When that route is closed
 * too, because a catalog harvested the camera model but the card's EXIF spells
 * it differently, nothing matches at all.
 *
 * A stat is cheap and opens nothing. Crucially it does *not* mark a row absent
 * when the file cannot be reached: a catalog is worth having precisely because
 * it still knows what was imported when the drive holding it is unplugged.
 */
export async function ensureCatalogSizes(
  db: Db,
  ids: readonly number[],
  signal?: AbortSignal,
): Promise<number> {
  if (ids.length === 0) return 0;

  const rows: EnrichRow[] = [];
  for (const group of chunk([...ids], CHUNK)) {
    const placeholders = group.map(() => "?").join(",");
    rows.push(
      ...db.allAs<EnrichRow>(
        `SELECT e.id, d.path AS dir_path, e.name, e.ext, e.size
           FROM entry e JOIN directory d ON d.id = e.dir_id
          WHERE e.id IN (${placeholders}) AND e.size < 0`,
        ...group,
      ),
    );
  }
  if (rows.length === 0) return 0;

  const sized = await pool(rows, IO_CONCURRENCY, async (row) => {
    if (signal?.aborted) return null;
    const st = await fs.stat(joinPath(row.dir_path, row.name)).catch(() => null);
    return st ? { id: row.id, size: st.size, mtimeMs: Math.round(st.mtimeMs) } : null;
  });

  const update = db.prep("UPDATE entry SET size = ?, mtime_ms = ? WHERE id = ?");
  let filled = 0;
  db.tx(() => {
    for (const r of sized) {
      if (!r) continue;
      update.run(r.size, r.mtimeMs, r.id);
      filled++;
    }
  });
  return filled;
}

/** Computes and stores quick hashes for entries that lack one. */
export async function ensureQuickHashes(
  db: Db,
  ids: readonly number[],
  signal?: AbortSignal,
  onProgress?: (p: EnrichProgress) => void,
): Promise<void> {
  if (ids.length === 0) return;

  const rows: EnrichRow[] = [];
  for (const group of chunk([...ids], CHUNK)) {
    const placeholders = group.map(() => "?").join(",");
    rows.push(
      ...db.allAs<EnrichRow>(
        `SELECT e.id, d.path AS dir_path, e.name, e.ext, e.size
           FROM entry e JOIN directory d ON d.id = e.dir_id
          WHERE e.id IN (${placeholders}) AND e.quick_hash IS NULL AND e.present = 1 AND e.size >= 0`,
        ...group,
      ),
    );
  }
  if (rows.length === 0) return;

  // A quick hash reads the head and tail of a file, not the whole of it, so
  // that — not the file size — is what the throughput figure counts.
  const sampled = (size: number) => Math.min(Math.max(0, size), QUICK_HASH_SAMPLE);
  const totalBytes = rows.reduce((sum, r) => sum + sampled(r.size), 0);
  let done = 0;
  let bytes = 0;

  const hashes = await pool(rows, IO_CONCURRENCY, async (row) => {
    if (signal?.aborted) return null;
    const hash = await tryQuickHash(joinPath(row.dir_path, row.name), row.size);
    done++;
    bytes += sampled(row.size);
    onProgress?.({ done, total: rows.length, bytes, totalBytes });
    return hash;
  });

  const update = db.prep("UPDATE entry SET quick_hash = ? WHERE id = ?");
  db.tx(() => {
    for (const [i, hash] of hashes.entries()) {
      const row = rows[i];
      if (hash && row) update.run(hash, row.id);
    }
  });
}

/** Computes and stores full-file hashes. Reserved for the strict path. */
export async function ensureFullHashes(
  db: Db,
  ids: readonly number[],
  signal?: AbortSignal,
  onProgress?: (p: EnrichProgress) => void,
): Promise<void> {
  if (ids.length === 0) return;

  const rows: EnrichRow[] = [];
  for (const group of chunk([...ids], CHUNK)) {
    const placeholders = group.map(() => "?").join(",");
    rows.push(
      ...db.allAs<EnrichRow>(
        `SELECT e.id, d.path AS dir_path, e.name, e.ext, e.size
           FROM entry e JOIN directory d ON d.id = e.dir_id
          WHERE e.id IN (${placeholders}) AND e.full_hash IS NULL AND e.present = 1`,
        ...group,
      ),
    );
  }
  if (rows.length === 0) return;

  const totalBytes = rows.reduce((sum, r) => sum + Math.max(0, r.size), 0);
  let done = 0;
  let bytes = 0;

  // Lower concurrency: these are whole-file reads, and queueing a dozen 60 MB
  // raws at once just thrashes the disk.
  const hashes = await pool(rows, 4, async (row) => {
    if (signal?.aborted) return null;
    const hash = await tryFullHash(joinPath(row.dir_path, row.name));
    done++;
    bytes += Math.max(0, row.size);
    onProgress?.({ done, total: rows.length, bytes, totalBytes });
    return hash;
  });

  const update = db.prep("UPDATE entry SET full_hash = ? WHERE id = ?");
  db.tx(() => {
    for (const [i, hash] of hashes.entries()) {
      const row = rows[i];
      if (hash && row) update.run(hash, row.id);
    }
  });
}
