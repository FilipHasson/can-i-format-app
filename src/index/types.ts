import type { RateUnit } from "../core/rate.ts";

export interface IndexError {
  path: string;
  message: string;
}

export type IndexPhase =
  | "starting"
  | "copying-catalog"
  | "walking"
  | "reading-catalog"
  | "sweeping"
  | "metadata"
  | "done";

export interface IndexProgress {
  phase: IndexPhase;
  directories: number;
  files: number;
  skippedDirectories: number;
  message?: string;
  /** Set only where the total is genuinely known, so a bar can fill. */
  done?: number;
  total?: number;
  /** Media covered, for throughput and a time estimate. */
  bytes?: number;
  totalBytes?: number;
  rateUnit?: RateUnit;
}

export interface IndexStats {
  directories: number;
  files: number;
  added: number;
  removed: number;
  skippedDirectories: number;
  /** Files whose capture metadata is already cached. */
  withMetadata: number;
  /**
   * Where this library's files live on disk.
   *
   * A folder library is its own root, so this is only interesting for a
   * catalog, which is a database describing files somewhere else entirely.
   * Recorded at index time because an import needs somewhere to put a file
   * that the catalog will later recognise as belonging to it.
   */
  roots?: string[];
  durationMs: number;
  errors: IndexError[];
}

export interface IndexOptions {
  /**
   * `incremental` trusts directory mtimes and skips stat-ing files in folders
   * that have not changed. `full` re-stats everything — use it after moving
   * files around with tools that preserve directory timestamps.
   */
  mode?: "incremental" | "full";
  /** Decides which filenames are worth indexing, before any stat happens. */
  keepFile?: (name: string, ext: string) => boolean;
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
}

export function emptyStats(): IndexStats {
  return {
    directories: 0,
    files: 0,
    added: 0,
    removed: 0,
    skippedDirectories: 0,
    withMetadata: 0,
    durationMs: 0,
    errors: [],
  };
}
