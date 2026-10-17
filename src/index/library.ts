import type { Db } from "../core/db.ts";
import { keyProblem, type AppConfig, type LibraryConfig } from "../core/config.ts";
import { renameInRule } from "../core/rules.ts";
import { indexFolderLibrary } from "./folder.ts";
import { indexLightroomLibrary } from "./lightroom.ts";
import { enrichLibrary } from "./enrich.ts";
import type { IndexOptions, IndexPhase, IndexStats } from "./types.ts";
import type { Phase } from "../core/phases.ts";

/**
 * The stages of indexing one library, as segments of one bar. Reading capture
 * times only happens for a library set to read them all up front; for the
 * rest there is one stage, and the bar is simply a bar.
 */
export function indexStages(lib: LibraryConfig): Phase[] {
  const list = lib.kind === "lightroom"
    ? { key: "list", label: "Read catalog" }
    : { key: "list", label: "Find files" };
  return lib.metadata === "full" ? [list, { key: "metadata", label: "Read capture times" }] : [list];
}

/** Which stage an indexer's report belongs to. "done" belongs to none. */
export function indexStage(phase: IndexPhase): string | undefined {
  if (phase === "metadata") return "metadata";
  if (phase === "done") return undefined;
  return "list";
}

/** Routes a library to its indexer, then runs a metadata pass if configured. */
export async function indexLibrary(
  db: Db,
  lib: LibraryConfig,
  options: IndexOptions = {},
): Promise<IndexStats> {
  const stats =
    lib.kind === "lightroom"
      ? await indexLightroomLibrary(db, lib, options)
      : await indexFolderLibrary(db, lib, options);

  if (lib.metadata === "full") {
    const row = db.getLibrary(lib.key);
    if (row) {
      options.onProgress?.({
        phase: "metadata",
        directories: stats.directories,
        files: stats.files,
        skippedDirectories: stats.skippedDirectories,
        message: "Reading capture times for every file",
      });

      await enrichLibrary(db, row.id, {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (p) =>
          options.onProgress?.({
            phase: "metadata",
            directories: stats.directories,
            files: stats.files,
            skippedDirectories: stats.skippedDirectories,
            message: `Reading capture times — ${p.done.toLocaleString()} of ${p.total.toLocaleString()} files`,
            done: p.done,
            total: p.total,
            bytes: p.bytes,
            totalBytes: p.totalBytes,
          }),
      });

      stats.withMetadata =
        db.getAs<{ n: number }>(
          "SELECT COUNT(*) AS n FROM entry WHERE library_id = ? AND meta_state = 'ok'",
          row.id,
        )?.n ?? 0;

      db.prep("UPDATE library SET stats = ? WHERE id = ?").run(JSON.stringify(stats), row.id);
    }
  }

  return stats;
}

export interface LibrarySummary {
  key: string;
  label: string;
  kind: string;
  root: string;
  files: number;
  withMetadata: number;
  lastIndexedAt: number | null;
  stats: IndexStats | null;
}

export function summarizeLibraries(db: Db): LibrarySummary[] {
  return db.listLibraries().map((row) => ({
    key: row.key,
    label: row.label,
    kind: row.kind,
    root: row.root,
    files: db.countEntries(row.id),
    withMetadata:
      db.getAs<{ n: number }>(
        "SELECT COUNT(*) AS n FROM entry WHERE library_id = ? AND meta_state = 'ok'",
        row.id,
      )?.n ?? 0,
    lastIndexedAt: row.last_indexed_at,
    stats: row.stats ? (JSON.parse(row.stats) as IndexStats) : null,
  }));
}

/**
 * Gives a library a new key, everywhere the old one was written down.
 *
 * A key is not just a label. Rules name it, import destinations point at it,
 * the index's library row is found by it, and every past scan records its
 * matches under it — and the import reads those matches to decide what a
 * destination already holds. Change it in the config alone and the next
 * import from an old scan finds no matches under the new name, so it treats
 * files the library already has as missing.
 *
 * So the index is updated in one transaction, and the config to save is
 * returned for the caller to write. If that write fails, call this again with
 * the keys swapped to put the index back.
 *
 * Throws with a message fit to show when the key cannot be used.
 */
export function renameLibraryKey(db: Db, config: AppConfig, from: string, to: string): AppConfig {
  if (!config.libraries.some((l) => l.key === from)) throw new Error(`No library called "${from}".`);
  if (to === from) return config;
  const problem = keyProblem(
    to,
    config.libraries.map((l) => l.key).filter((k) => k !== from),
  );
  if (problem) throw new Error(problem);

  const rename = (rule: string) => renameInRule(rule, from, to);

  db.tx(() => {
    db.prep("UPDATE library SET key = ? WHERE key = ?").run(to, from);

    // Each scanned file's matches are keyed by library. The value is moved
    // with json() so it stays an object rather than becoming a string.
    const fromPath = `$."${from}"`;
    const toPath = `$."${to}"`;
    db.prep(
      `UPDATE scan_file
          SET matches = json_set(json_remove(matches, ?), ?, json(json_extract(matches, ?)))
        WHERE json_extract(matches, ?) IS NOT NULL`,
    ).run(fromPath, toPath, fromPath, fromPath);

    // What a file still needs is a piece of the rule, so it renames the same
    // way. There are only ever a handful of distinct ones.
    const gaps = db.allAs<{ gap: string }>(
      "SELECT DISTINCT gap FROM scan_file WHERE gap IS NOT NULL AND gap <> ''",
    );
    const setGap = db.prep("UPDATE scan_file SET gap = ? WHERE gap = ?");
    for (const { gap } of gaps) {
      const renamed = rename(gap);
      if (renamed !== gap) setGap.run(renamed, gap);
    }

    const scans = db.allAs<{ id: number; rule: string; stats: string | null }>(
      "SELECT id, rule, stats FROM scan",
    );
    const setScan = db.prep("UPDATE scan SET rule = ?, stats = ? WHERE id = ?");
    for (const scan of scans) {
      let stats = scan.stats;
      if (stats) {
        const parsed = JSON.parse(stats) as { gaps?: Array<{ requirement: string }> };
        for (const gap of parsed.gaps ?? []) gap.requirement = rename(gap.requirement);
        stats = JSON.stringify(parsed);
      }
      setScan.run(rename(scan.rule), stats, scan.id);
    }
  });

  const kinds: AppConfig["kinds"] = {};
  for (const [kind, handling] of Object.entries(config.kinds)) {
    kinds[kind as keyof typeof kinds] =
      handling.mode === "rule" ? { ...handling, rule: rename(handling.rule) } : handling;
  }

  const destinations: AppConfig["import"]["destinations"] = {};
  for (const [group, destination] of Object.entries(config.import.destinations)) {
    destinations[group as keyof typeof destinations] =
      destination?.mode === "library" && destination.libraryKey === from
        ? { ...destination, libraryKey: to }
        : destination;
  }

  return {
    ...config,
    rule: rename(config.rule),
    kinds,
    libraries: config.libraries.map((l) => (l.key === from ? { ...l, key: to } : l)),
    import: { ...config.import, destinations },
  };
}
