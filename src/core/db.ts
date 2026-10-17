import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dbFile } from "./paths.ts";

/**
 * The index is one SQLite file holding every library's file list plus scan
 * history. Directories are interned into their own table because a million-file
 * library repeats the same long path prefixes constantly — that alone is worth
 * a hundred-odd megabytes.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library (
  id              INTEGER PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  root            TEXT NOT NULL,
  run             INTEGER NOT NULL DEFAULT 0,
  last_indexed_at INTEGER,
  stats           TEXT
);

CREATE TABLE IF NOT EXISTS directory (
  id          INTEGER PRIMARY KEY,
  library_id  INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  path_key    TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  seen_run    INTEGER NOT NULL DEFAULT 0,
  created_run INTEGER NOT NULL DEFAULT 0,
  UNIQUE (library_id, path_key)
);

CREATE TABLE IF NOT EXISTS entry (
  id          INTEGER PRIMARY KEY,
  library_id  INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  dir_id      INTEGER NOT NULL REFERENCES directory(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  stem        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  present     INTEGER NOT NULL DEFAULT 1,
  seen_run    INTEGER NOT NULL,
  -- Set on insert and never updated, so an index run can tell new files from
  -- ones it merely re-confirmed.
  created_run INTEGER NOT NULL DEFAULT 0,
  meta_state  TEXT NOT NULL DEFAULT 'pending',
  captured_at INTEGER,
  camera_key  TEXT,
  orig_stem   TEXT,
  quick_hash  TEXT,
  full_hash   TEXT,
  -- Lightroom stores its own MD5 of the imported original. Free to read from
  -- the catalog, and the only content signal available for catalog rows.
  catalog_md5 TEXT,
  UNIQUE (dir_id, name_key)
);

-- The workhorse lookup: "does this library hold a file of exactly this size?"
CREATE INDEX IF NOT EXISTS idx_entry_size    ON entry (library_id, size);
-- Narrows candidates when a card file's size is absent (DNG conversion) .
CREATE INDEX IF NOT EXISTS idx_entry_stem    ON entry (library_id, stem);
CREATE INDEX IF NOT EXISTS idx_entry_sweep   ON entry (library_id, seen_run);
-- Partial, so they stay near-empty while metadata is still lazy.
-- Keyed on capture time alone: a wall-clock second is already selective enough
-- that only a handful of rows come back, and the camera is compared in code so
-- that a serial known on one side only still matches (see sameCamera).
CREATE INDEX IF NOT EXISTS idx_entry_capture ON entry (library_id, captured_at) WHERE captured_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entry_origin  ON entry (library_id, orig_stem)   WHERE orig_stem IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entry_quick   ON entry (quick_hash)              WHERE quick_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entry_full    ON entry (full_hash)               WHERE full_hash IS NOT NULL;

-- One row per card ever seen, so a drive letter reused by the next card in
-- the reader does not merge two shoots into one history.
CREATE TABLE IF NOT EXISTS card (
  id          INTEGER PRIMARY KEY,
  -- Volume serial. Absent on cards whose formatter did not set one, and those
  -- are not registered at all rather than being merged together.
  fingerprint TEXT NOT NULL UNIQUE,
  descriptor  TEXT NOT NULL,
  -- Position among cards of the same descriptor, assigned once and kept.
  seq         INTEGER NOT NULL,
  -- Once a name set by hand. No longer read or written; kept so existing
  -- indexes open without a migration.
  name        TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_descriptor ON card (descriptor);

CREATE TABLE IF NOT EXISTS scan (
  id          INTEGER PRIMARY KEY,
  root        TEXT NOT NULL,
  label       TEXT,
  rule        TEXT NOT NULL,
  min_tier    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,
  error       TEXT,
  stats       TEXT
);

CREATE TABLE IF NOT EXISTS scan_file (
  id          INTEGER PRIMARY KEY,
  scan_id     INTEGER NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  rel_dir     TEXT NOT NULL,
  name        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  required    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  captured_at INTEGER,
  camera_key  TEXT,
  satisfied   INTEGER NOT NULL DEFAULT 0,
  gap         TEXT,
  matches     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_scanfile_scan ON scan_file (scan_id, rel_dir);
CREATE INDEX IF NOT EXISTS idx_scanfile_open ON scan_file (scan_id, satisfied);
`;

export interface LibraryRow {
  id: number;
  key: string;
  label: string;
  kind: string;
  root: string;
  run: number;
  last_indexed_at: number | null;
  stats: string | null;
}

export interface EntryRow {
  id: number;
  library_id: number;
  dir_id: number;
  name: string;
  stem: string;
  ext: string;
  size: number;
  mtime_ms: number;
  present: number;
  meta_state: string;
  captured_at: number | null;
  camera_key: string | null;
  orig_stem: string | null;
  quick_hash: string | null;
  full_hash: string | null;
  dir_path?: string;
}

/** What SQLite will accept as a bound parameter. */
export type Param = null | number | bigint | string | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  #stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.raw = new DatabaseSync(file);

    // WAL keeps the UI readable while a long index run writes.
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA temp_store = MEMORY");
    this.raw.exec("PRAGMA cache_size = -65536"); // ~64 MiB
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec(SCHEMA);
  }

  /** Prepared statements are cached — index runs reuse the same few thousands of times. */
  prep(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Typed row access. `node:sqlite` returns `Record<string, SQLOutputValue>`,
   * which TypeScript will not narrow to a row interface directly — these two
   * keep that cast in one place instead of at every call site.
   */
  allAs<T>(sql: string, ...params: Param[]): T[] {
    return this.prep(sql).all(...(params as never[])) as unknown as T[];
  }

  getAs<T>(sql: string, ...params: Param[]): T | undefined {
    return this.prep(sql).get(...(params as never[])) as unknown as T | undefined;
  }

  /** Runs `fn` inside a transaction, rolling back if it throws. */
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // A failed rollback means the tx already ended; the original error wins.
      }
      throw err;
    }
  }

  getMeta(key: string): string | null {
    return this.getAs<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.prep(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  /** Creates the library row if needed, keeping label/root in sync with config. */
  upsertLibrary(key: string, label: string, kind: string, root: string): LibraryRow {
    this.prep(
      `INSERT INTO library (key, label, kind, root) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET label = excluded.label, kind = excluded.kind, root = excluded.root`,
    ).run(key, label, kind, root);
    return this.getLibrary(key) as LibraryRow;
  }

  getLibrary(key: string): LibraryRow | undefined {
    return this.getAs<LibraryRow>("SELECT * FROM library WHERE key = ?", key);
  }

  listLibraries(): LibraryRow[] {
    return this.allAs<LibraryRow>("SELECT * FROM library ORDER BY key");
  }

  /** Drops a library and, by cascade, every directory and entry under it. */
  deleteLibrary(key: string): void {
    this.prep("DELETE FROM library WHERE key = ?").run(key);
  }

  countEntries(libraryId: number): number {
    return (
      this.getAs<{ n: number }>(
        "SELECT COUNT(*) AS n FROM entry WHERE library_id = ? AND present = 1",
        libraryId,
      )?.n ?? 0
    );
  }

  close(): void {
    this.#stmts.clear();
    this.raw.close();
  }
}

let shared: Db | null = null;

export function openDb(file = dbFile()): Db {
  if (!shared) shared = new Db(file);
  return shared;
}

export function closeDb(): void {
  shared?.close();
  shared = null;
}
