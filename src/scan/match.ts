import type { Db } from "../core/db.ts";
import { ruleFor, type AppConfig, type LibraryConfig } from "../core/config.ts";
import type { CaptureMeta, MetaState } from "../core/metadata.ts";
import { sameCamera } from "../core/metadata.ts";
import { atLeast, bestTier, type MatchTier } from "../core/tiers.ts";
import { describeGap, evaluateRule, parseRule, ruleKeys, type RuleNode } from "../core/rules.ts";
import {
  enrichEntries,
  enrichLibrary,
  ensureCatalogSizes,
  ensureFullHashes,
  ensureQuickHashes,
} from "../index/enrich.ts";
import { tryFullHash, tryQuickHash } from "../core/hash.ts";
import { joinPath, stemOf } from "../core/paths.ts";
import fs from "node:fs/promises";
import { pool, IO_CONCURRENCY } from "../core/pool.ts";
import { Heartbeat } from "../core/heartbeat.ts";

/**
 * Deciding whether a card file already lives in a library.
 *
 * Camera filenames repeat constantly (every card eventually has its own
 * IMG_0001), and an import may rename the file, convert it to DNG, or both. So
 * no single signal is trusted. Instead the matcher escalates: cheap indexed
 * lookups first, file reads only for the files still in doubt.
 *
 *   size + name      cheap, indexed, settles the overwhelming majority
 *   capture identity survives renames and RAW->DNG conversion
 *   content hash     the tiebreaker, and the proof for a strict run
 *
 * The passes run across the whole card rather than per file, so every round of
 * file reads is batched into one concurrent sweep instead of thousands of
 * scattered ones.
 */

export interface CardFile {
  /** Path relative to the card root, using forward slashes. "" at the root. */
  relDir: string;
  name: string;
  ext: string;
  kind: string;
  /** False for sidecars/junk that should never block a format decision. */
  required: boolean;
  size: number;
  mtimeMs: number;
  absPath: string;
  meta: CaptureMeta;
  /**
   * How reading `meta` went. "error" is not "no capture time": a file whose
   * header could not be read may well have one, and a name-and-size match
   * cannot be checked against a time nobody managed to read.
   */
  metaState?: MetaState;
  quickHash: string | null;
  fullHash: string | null;
}

export interface LibraryMatch {
  tier: MatchTier;
  /** Short human explanation, shown in the UI next to the match. */
  reason: string;
  entryId: number | null;
  path: string | null;
  /**
   * The catalog says this file was imported, and the copy it points at is no
   * longer there. The tier is forced to "none" — a record of an import is not
   * a copy — but the path is kept, because "you imported this and then it went
   * away" is worth more to someone than "not found".
   */
  deleted?: boolean;
}

export interface FileVerdict {
  file: CardFile;
  matches: Record<string, LibraryMatch>;
  satisfied: boolean;
  /** What is still missing, e.g. `offsite` or `(main or backup)`. */
  gap: string;
}

interface CandidateRow {
  id: number;
  library_id: number;
  name: string;
  stem: string;
  ext: string;
  size: number;
  present: number;
  meta_state: string;
  captured_at: number | null;
  camera_key: string | null;
  orig_stem: string | null;
  quick_hash: string | null;
  full_hash: string | null;
  catalog_md5: string | null;
  dir_path: string;
}

const CANDIDATE_COLUMNS = `
  e.id, e.library_id, e.name, e.stem, e.ext, e.size, e.present, e.meta_state,
  e.captured_at, e.camera_key, e.orig_stem, e.quick_hash, e.full_hash,
  e.catalog_md5, d.path AS dir_path
`;

/**
 * No cap applies to any question whose answer decides a verdict.
 *
 * "Is this file in the library?" is asked as a targeted, indexed question with
 * a definite answer — by capture identity, by name and size, and finally by
 * content hash — so the answer never depends on how many rows a broader query
 * would have returned. An index that cannot say yes or no is not worth having.
 *
 * The one capped lookup left picks which library files are worth *opening* to
 * read their capture times. That is a question about effort, not about truth:
 * whatever it misses, #escalate reads in full anyway.
 */
const MAX_STEM_CANDIDATES = 64;
/** What a quick hash actually reads: the head and tail of the file. */
const HASH_SAMPLE_BYTES = 128 * 1024;
const MAX_CAPTURE_CANDIDATES = 64;

/**
 * What a same-name, same-size library row is worth.
 *
 * Cameras restart their counters, and a body's raws sit in a narrow band of
 * sizes, so the pair recurs by coincidence across a large library: one card
 * in testing had 8,784 of them. Capture time is what tells a re-shot frame
 * from the imported copy, so the pair only counts where that question was
 * asked and answered:
 *
 * - both times known: they must agree
 * - neither known, and the card file *was* read: there is nothing to ask
 * - anything else — the library has a time the card file cannot be held to,
 *   or reading the card file failed — is weak, and content hashing, which
 *   compares this file against every same-size library file, decides
 *
 * A file the card has no readable time for is never cleared by its name.
 */
function nameAndSizeMatch(
  named: CandidateRow,
  file: CardFile,
  stem: string,
): { tier: MatchTier; reason: string } {
  const sameName = named.stem === stem ? "same filename" : "same original filename";
  const cardTime = file.meta.capturedAt;

  if (cardTime !== null && named.captured_at !== null) {
    return named.captured_at === cardTime
      ? { tier: "probable", reason: `${sameName} and byte size` }
      : { tier: "weak", reason: `${sameName} and byte size, but a different capture time` };
  }
  if (file.metaState === "error") {
    return { tier: "weak", reason: `${sameName} and byte size, but the card file's capture time could not be read` };
  }
  if (cardTime === null && named.captured_at !== null) {
    return { tier: "weak", reason: `${sameName} and byte size, but the card file has no capture time to compare` };
  }
  return { tier: "probable", reason: `${sameName} and byte size` };
}

export interface MatchProgress {
  phase: "lookup" | "capture" | "metadata" | "collecting" | "hashing" | "done";
  done: number;
  total: number;
  /** Media covered by the phases that open files. Zero for indexed lookups. */
  bytes?: number;
  totalBytes?: number;
}

export interface MatchOptions {
  signal?: AbortSignal;
  onProgress?: (p: MatchProgress) => void;
  /**
   * Allow a full metadata read of a library when lazy indexing leaves files
   * unresolved. Disabling it makes scans faster but lets renamed-on-import
   * files be reported missing when they are not — only turn it off if you
   * know your imports preserve filenames.
   */
  escalate?: boolean;
}

export interface MatchSummary {
  verdicts: FileVerdict[];
  /** Card files a catalog imported and no longer has a copy of. */
  deletedSinceImport: number;
  /** Libraries referenced by the rule that hold no indexed files. */
  emptyLibraries: string[];
/**
   * Times the enrichment-target lookup hit its cap. Diagnostic only: it selects
   * which files to open, never what the verdict is.
   */
  truncated: number;
  metadataReads: number;
  hashReads: number;
  /** Libraries that needed a one-time full metadata read during this scan. */
  escalatedLibraries: string[];
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

/** A configured, enabled library paired with its row id. */
type ActiveLibrary = LibraryConfig & { id: number };

interface KindPlan {
  rule: RuleNode;
  /**
   * Every enabled library. Where a file is, is worth reporting even when the
   * rule does not ask — that is how someone decides whether to add a library
   * to it, and a library the rule leaves out reporting no matches for
   * everything reads as the tool being broken.
   */
  libs: ActiveLibrary[];
  /**
   * The subset the verdict actually depends on. Only these justify the passes
   * that open files: reading a whole library's metadata to enrich a column
   * nobody is judged by would be work for a footnote.
   */
  required: ActiveLibrary[];
}

export class Matcher {
  #db: Db;
  #config: AppConfig;
  #libs: ActiveLibrary[] = [];
  #plans = new Map<string, KindPlan>();

  constructor(db: Db, config: AppConfig) {
    this.#db = db;
    this.#config = config;

    for (const lib of config.libraries) {
      if (!lib.enabled) continue;
      const row = db.getLibrary(lib.key);
      if (row) this.#libs.push({ ...lib, id: row.id });
    }
  }

  /**
   * The rule a file of this kind is judged by, and which libraries to ask.
   *
   * A kind can be given its own rule — footage usually lives somewhere other
   * than a photo library — or none at all, in which case it is not judged.
   */
  #planFor(kind: string): KindPlan | null {
    const cached = this.#plans.get(kind);
    if (cached) return cached;

    const expression = ruleFor(this.#config, kind);
    if (expression === null) return null;

    const rule = parseRule(expression);
    const named = new Set(ruleKeys(rule));
    const plan: KindPlan = {
      rule,
      libs: this.#libs,
      required: this.#libs.filter((l) => named.has(l.key)),
    };
    this.#plans.set(kind, plan);
    return plan;
  }

  get libraryKeys(): string[] {
    return this.#libs.map((l) => l.key);
  }

/**
   * Does a library file exist with this exact size *and* this exact name — the
   * current one, or the original recorded at import?
   *
   * Both halves are in the WHERE clause, so the index answers the question
   * outright. Nothing is enumerated and nothing is capped: a library with
   * twenty thousand files of this size answers as reliably as one with two.
   */
  #byNameAndSize(
    libraryId: number,
    size: number,
    stem: string,
    ext: string,
    capturedAt: number | null,
  ): CandidateRow | undefined {
    if (size < 0) return undefined;
    return this.#db.getAs<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM entry e JOIN directory d ON d.id = e.dir_id
        WHERE e.library_id = ? AND e.size = ? AND e.present = 1
          AND (e.stem = ? OR e.orig_stem = ?)
        ORDER BY CASE WHEN e.captured_at IS NULL OR ? IS NULL OR e.captured_at = ?
                      THEN 1 ELSE 0 END DESC,
                 CASE WHEN e.ext = ? THEN 1 ELSE 0 END DESC,
                 e.id
        LIMIT 1`,
      libraryId,
      size,
      stem,
      stem,
      capturedAt,
      capturedAt,
      ext,
    );
  }

  /** Does anything at all share this byte size? Existence only — one row. */
  #anySameSize(libraryId: number, size: number): CandidateRow | undefined {
    if (size < 0) return undefined;
    return this.#db.getAs<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM entry e JOIN directory d ON d.id = e.dir_id
        WHERE e.library_id = ? AND e.size = ? AND e.present = 1 LIMIT 1`,
      libraryId,
      size,
    );
  }

  /**
   * Every id sharing this byte size — the complete set a content hash has to
   * rule out. Uncapped on purpose: this is the last question asked before a
   * file is declared missing, and a partial answer to it is worthless.
   */
  #sameSizeIds(libraryId: number, size: number): number[] {
    if (size < 0) return [];
    return this.#db
      .allAs<{ id: number }>(
        "SELECT id FROM entry WHERE library_id = ? AND size = ? AND present = 1",
        libraryId,
        size,
      )
      .map((r) => r.id);
  }

  /** The library file with this content hash, if the library holds one. */
  #byHash(libraryId: number, column: "quick_hash" | "full_hash", hash: string): CandidateRow | undefined {
    return this.#db.getAs<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM entry e JOIN directory d ON d.id = e.dir_id
        WHERE e.library_id = ? AND e.${column} = ? AND e.present = 1 LIMIT 1`,
      libraryId,
      hash,
    );
  }

  /**
   * Matches the card file's stem against both the library filename and the
   * original filename recorded at import — the latter is what survives a
   * Lightroom rename or a convert-to-DNG import.
   *
   * This list exists to pick the handful of files worth opening, so unread
   * rows rank first: anything already read has been through the capture pass
   * and lost, which is why this lookup is running at all. That matters exactly
   * in the case where a stem collides in bulk — several bodies, hundreds of
   * thousands of frames — where the budget would otherwise fill with rows
   * already known not to match.
   *
   * When the cap does bite here it is not load-bearing: the capture pass looks
   * files up by capture time on a different index and never consults this list.
   */
  #byStem(libraryId: number, stem: string, size: number, ext: string): CandidateRow[] {
    return this.#db.allAs<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM entry e JOIN directory d ON d.id = e.dir_id
        WHERE e.library_id = ? AND (e.stem = ? OR e.orig_stem = ?) AND e.present = 1
        ORDER BY CASE WHEN e.captured_at IS NULL THEN 1 ELSE 0 END DESC,
                 CASE WHEN e.size = ? THEN 1 ELSE 0 END DESC,
                 CASE WHEN e.ext = ? THEN 1 ELSE 0 END DESC,
                 e.id
        LIMIT ?`,
      libraryId,
      stem,
      stem,
      size,
      ext,
      MAX_STEM_CANDIDATES + 1,
    );
  }

  #byCapture(libraryId: number, capturedAt: number, stem: string, ext: string): CandidateRow[] {
    return this.#db.allAs<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM entry e JOIN directory d ON d.id = e.dir_id
        WHERE e.library_id = ? AND e.captured_at = ? AND e.present = 1
        ORDER BY CASE WHEN e.stem = ? OR e.orig_stem = ? THEN 1 ELSE 0 END DESC,
                 CASE WHEN e.ext = ? THEN 1 ELSE 0 END DESC,
                 e.id
        LIMIT ?`,
      libraryId,
      capturedAt,
      stem,
      stem,
      ext,
      MAX_CAPTURE_CANDIDATES + 1,
    );
  }

  async run(files: CardFile[], options: MatchOptions = {}): Promise<MatchSummary> {
    const verdicts: FileVerdict[] = files.map((file) => ({
      file,
      matches: {},
      satisfied: false,
      gap: "",
    }));

    const summary: MatchSummary = {
      verdicts,
      deletedSinceImport: 0,
      emptyLibraries: [],
      truncated: 0,
      metadataReads: 0,
      hashReads: 0,
      escalatedLibraries: [],
    };

    for (const lib of this.#libs) {
      if (this.#db.countEntries(lib.id) === 0) summary.emptyLibraries.push(lib.key);
    }

    // ---- Pass 0: capture identity, wherever it is already known ----------
    // Capture time plus filename is the sharpest key the tool has: a body has
    // to shoot ten thousand frames before it repeats a name, so the two
    // together are effectively unique. It runs first, for free, against
    // whatever metadata is already on hand — always the case for a Lightroom
    // catalog, and for any folder library that a previous scan has read.
    //
    // It cannot run first on the *first* scan of a lazily indexed folder
    // library, because nothing has opened those files yet and there is no
    // capture time to look up. That scan falls through to the name and size
    // lookups below and then pays for a metadata read once (see #escalate);
    // every scan after it starts here and stops here.
    await this.#capturePass(verdicts, options);

    // ---- Pass 1: indexed lookups only. No file is opened. ----------------
    const toEnrich = new Set<number>();
    // Catalog rows a card file could plausibly be. They arrive without a size,
    // which is the one thing that would let them match on name.
    const toSize = new Set<number>();

    // Name-and-size matches on a library row whose capture time has not been
    // read yet. They are believed for now, but "safe to format" must not rest
    // on a filename coincidence that one file read could have refuted, so
    // pass 2 reads them and checks.
    const provisional: Array<{ verdict: FileVerdict; libKey: string; entryId: number }> = [];


    const heartbeat = new Heartbeat();

    for (const [i, verdict] of verdicts.entries()) {
      if (options.signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
      const file = verdict.file;
      if (!file.required) continue;

      const stem = stemOf(file.name);
      const plan = this.#planFor(file.kind);
      if (!plan) continue;

      for (const lib of plan.libs) {
        // Capture identity already answered this one, and nothing below can
        // beat it. Skipping is the point: these are the lookups that collide
        // in bulk on a large library, and this is how they stop being reached.
        if (atLeast(verdict.matches[lib.key]?.tier ?? "none", "strong")) continue;

        let best: LibraryMatch = { tier: "none", reason: "", entryId: null, path: null };
        const consider = (tier: MatchTier, reason: string, c: CandidateRow) => {
          if (tier === bestTier(tier, best.tier) && tier !== best.tier) {
            best = { tier, reason, entryId: c.id, path: joinPath(c.dir_path, c.name) };
          }
        };

        // Same name and same size, asked as one indexed question with a
        // definite answer. This settles the ordinary case — a straight copy
        // that kept its filename — and no cap can affect it.
        const named = this.#byNameAndSize(lib.id, file.size, stem, file.ext, file.meta.capturedAt);
        if (named) {
          // Cameras restart their counters, so a repeated filename is weak on
          // its own and a same-size collision on top of it proves nothing
          // until capture time has had its say — see nameAndSizeMatch.
          const { tier, reason } = nameAndSizeMatch(named, file, stem);
          consider(tier, reason, named);
          if (tier === "probable" && named.meta_state === "pending" && file.meta.capturedAt !== null) {
            toEnrich.add(named.id);
            provisional.push({ verdict, libKey: lib.key, entryId: named.id });
          }
        } else {
          // Something of this size exists under another name. Only a content
          // hash can say whether it is the same file; pass 4 does that against
          // the complete set, so this is a placeholder for the display.
          const sized = this.#anySameSize(lib.id, file.size);
          if (sized) consider("weak", "same byte size, different filename", sized);
        }

        // Stem candidates are the cheap route to the capture-identity check —
        // they are the handful of files worth opening later. This is the one
        // capped lookup left, and it decides effort rather than truth:
        // whatever it misses, #escalate reads in full.
        const stemmed = this.#byStem(lib.id, stem, file.size, file.ext);
        if (stemmed.length > MAX_STEM_CANDIDATES) summary.truncated++;
        for (const c of stemmed.slice(0, MAX_STEM_CANDIDATES)) {
          if (c.meta_state === "pending") toEnrich.add(c.id);
          if (c.size < 0) {
            toSize.add(c.id);
            // Saying "different size" would be a claim; the size is unknown.
            consider("weak", "same filename, recorded in a catalog", c);
          } else {
            consider("weak", "same filename, different size", c);
          }
        }

        verdict.matches[lib.key] = best;
      }

      await heartbeat.beat(() =>
        options.onProgress?.({ phase: "lookup", done: i + 1, total: verdicts.length }),
      );
    }
    options.onProgress?.({ phase: "lookup", done: verdicts.length, total: verdicts.length });

    this.#settle(verdicts);

    // ---- Pass 1b: give catalog candidates a size, and ask again ----------
    // A catalog knows a file was imported but not how big it is, so pass 1
    // could not compare sizes and the only route left was capture identity.
    // One stat per candidate — no file opened — restores the ordinary route.
    if (toSize.size > 0 && verdicts.some((v) => v.file.required && !v.satisfied)) {
      const filled = await ensureCatalogSizes(this.#db, [...toSize], options.signal);
      if (filled > 0) {
        await this.#nameAndSizePass(verdicts, options);
        this.#settle(verdicts);
      }
    }

    // ---- Pass 1c: is the copy a catalog points at still there? ----------
    await this.#verifyCatalogCopies(verdicts, summary, options);
    this.#settle(verdicts);

    // ---- Pass 2: read metadata for the few plausible counterparts --------
    const unresolved = verdicts.some((v) => v.file.required && !v.satisfied);
    if (toEnrich.size > 0 && (unresolved || provisional.length > 0)) {
      options.onProgress?.({ phase: "metadata", done: 0, total: toEnrich.size });
      summary.metadataReads += await enrichEntries(this.#db, [...toEnrich], {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (p) =>
          options.onProgress?.({
            phase: "metadata",
            done: p.done,
            total: p.total,
            bytes: p.bytes,
            totalBytes: p.totalBytes,
          }),
      });

      this.#recheckProvisional(provisional);
      this.#settle(verdicts);

      await this.#capturePass(verdicts, options);
      this.#settle(verdicts);
    }

    // ---- Pass 3: escalate to a full metadata read where still needed -----
    if (options.escalate !== false) {
      summary.metadataReads += await this.#escalate(verdicts, summary, options);
    }

    // ---- Pass 4: settle the rest on content, exhaustively ----------------
    // The last question before a file is called missing, so it is asked of the
    // *complete* set of library files that share its byte size — not a sample.
    // A same-size file is the only thing a copy can hide behind once name and
    // capture time have both come up empty, and hashing every one of them is
    // bounded work that is cached against (size, mtime) forever.
    const strict = this.#config.hashMode === "full";
    const column = strict ? "full_hash" : "quick_hash";
    const pending: Array<{ verdict: FileVerdict; lib: ActiveLibrary }> = [];
    const libraryIds = new Set<number>();

    const collecting = new Heartbeat();
    let considered = 0;

    for (const verdict of verdicts) {
      considered++;
      if (!verdict.file.required || verdict.satisfied) continue;
      for (const lib of this.#planFor(verdict.file.kind)?.required ?? []) {
        if (atLeast(verdict.matches[lib.key]?.tier ?? "none", this.#config.minTier)) continue;
        const ids = this.#sameSizeIds(lib.id, verdict.file.size);
        if (ids.length === 0) continue;
        for (const id of ids) libraryIds.add(id);
        pending.push({ verdict, lib });
      }
      // Another indexed pass with no file reads in it, and the same trap.
      await collecting.beat(() =>
        options.onProgress?.({ phase: "collecting", done: considered, total: verdicts.length }),
      );
    }

    if (pending.length > 0) {
      const cards = [...new Set(pending.map((p) => p.verdict))];
      const total = libraryIds.size + cards.length;
      // Quick hashing reads a bounded sample, so the honest byte figure for it
      // is the sample, not the file. A full run does read every byte.
      const cardBytes = cards.reduce(
        (sum, v) => sum + (strict ? v.file.size : Math.min(v.file.size, HASH_SAMPLE_BYTES)),
        0,
      );
      // Totals stay 0 until the library side reports its own, so the bar is
      // honestly indeterminate rather than briefly wrong.
      options.onProgress?.({ phase: "hashing", done: 0, total, bytes: 0, totalBytes: 0 });

      // Hashing the library side used to be a silent stretch with the bar
      // frozen; it is the bulk of the work here, so it reports like the rest.
      // Its byte count carries into the card pass so the figures only ever go
      // up — a counter that goes backwards restarts the rate estimate.
      let libraryBytes = 0;
      let libraryTotalBytes = 0;
      const onLibraryHash = (p: { done: number; total: number; bytes: number; totalBytes: number }) => {
        libraryBytes = p.bytes;
        libraryTotalBytes = p.totalBytes;
        options.onProgress?.({
          phase: "hashing",
          done: p.done,
          total,
          bytes: p.bytes,
          totalBytes: p.totalBytes + cardBytes,
        });
      };

      if (strict) await ensureFullHashes(this.#db, [...libraryIds], options.signal, onLibraryHash);
      else await ensureQuickHashes(this.#db, [...libraryIds], options.signal, onLibraryHash);

      let done = libraryIds.size;
      let bytes = 0;
      await pool(cards, strict ? 4 : IO_CONCURRENCY, async (verdict) => {
        if (options.signal?.aborted) return;
        const file = verdict.file;
        if (strict) file.fullHash ??= await tryFullHash(file.absPath);
        else file.quickHash ??= await tryQuickHash(file.absPath, file.size);
        done++;
        bytes += strict ? file.size : Math.min(file.size, HASH_SAMPLE_BYTES);
        options.onProgress?.({
          phase: "hashing",
          done,
          total,
          bytes: libraryBytes + bytes,
          totalBytes: libraryTotalBytes + cardBytes,
        });
      });
      summary.hashReads = cards.length;

      for (const { verdict, lib } of pending) {
        const hash = strict ? verdict.file.fullHash : verdict.file.quickHash;
        if (!hash) continue;
        const row = this.#byHash(lib.id, column, hash);
        if (!row) continue;

        verdict.matches[lib.key] = strict
          ? { tier: "exact", reason: "identical file contents", entryId: row.id, path: joinPath(row.dir_path, row.name) }
          : {
              tier: "strong",
              reason: "identical size and content sample",
              entryId: row.id,
              path: joinPath(row.dir_path, row.name),
            };
      }

      this.#settle(verdicts);
    }

    options.onProgress?.({ phase: "done", done: verdicts.length, total: verdicts.length });
    return summary;
  }

  /**
   * Does the candidate plausibly come from the same body as the card file?
   *
   * When one side records no camera at all — common for video, and for
   * catalogs that never harvested EXIF — a bare timestamp match is too weak on
   * its own, so filename agreement has to carry it.
   */
  #cameraAgrees(candidate: CandidateRow, file: CardFile): boolean {
    if (sameCamera(candidate.camera_key, file.meta.cameraKey)) return true;
    if (candidate.camera_key === null || file.meta.cameraKey === null) {
      const stem = stemOf(file.name);
      return candidate.stem === stem || candidate.orig_stem === stem;
    }
    return false;
  }

  /**
   * Checks that a catalog match is backed by a file that still exists.
   *
   * A folder library is walked, so a deleted file simply stops being indexed.
   * A catalog is not: it records that a file was imported and goes on saying
   * so after the file is culled, moved out, or deleted outside Lightroom. Left
   * alone, that is the one mistake this tool must never make — reporting a card
   * safe to erase on the strength of a copy that is not there.
   *
   * What keeps it from crying wolf is that a missing file only counts as
   * deleted when its folder is still standing. An unplugged drive, a changed
   * drive letter, a library moved wholesale — in all of those the folder is
   * gone too, and a vanished tree cannot be told apart from a mass deletion.
   * A folder still there with one file missing from it can.
   */
  async #verifyCatalogCopies(
    verdicts: FileVerdict[],
    summary: MatchSummary,
    options: MatchOptions,
  ): Promise<void> {
    const catalogs = this.#libs.filter((l) => l.kind === "lightroom");
    if (catalogs.length === 0) return;

    type Candidate = { verdict: FileVerdict; key: string; path: string };
    const candidates: Candidate[] = [];

    for (const verdict of verdicts) {
      if (!verdict.file.required) continue;
      for (const lib of catalogs) {
        const match = verdict.matches[lib.key];
        if (!match || match.tier === "none" || !match.path) continue;
        candidates.push({ verdict, key: lib.key, path: match.path });
      }
    }
    if (candidates.length === 0) return;

    options.onProgress?.({ phase: "lookup", done: 0, total: candidates.length });
    const heartbeat = new Heartbeat();
    let done = 0;
    const gone: Candidate[] = [];
    const folderExists = new Map<string, boolean>();

    for (const candidate of candidates) {
      if (options.signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
      done++;
      await heartbeat.beat(() =>
        options.onProgress?.({ phase: "lookup", done, total: candidates.length }),
      );

      if (await exists(candidate.path)) continue;

      const folder = candidate.path.slice(0, candidate.path.lastIndexOf("/"));
      let hasFolder = folderExists.get(folder);
      if (hasFolder === undefined) {
        hasFolder = await exists(folder);
        folderExists.set(folder, hasFolder);
      }
      // The folder being gone too means the library moved or the drive is
      // out. A whole tree that has vanished cannot be told apart from a mass
      // deletion, and calling it one would bury the cases where a single
      // file really did go. A folder still standing with the file missing
      // from it is unambiguous, which is the case worth reporting.
      if (hasFolder) gone.push(candidate);
    }

    for (const candidate of gone) {
      const current = candidate.verdict.matches[candidate.key];
      if (!current) continue;
      candidate.verdict.matches[candidate.key] = {
        ...current,
        tier: "none",
        reason: "imported, but the copy is no longer there",
        deleted: true,
      };
    }
    summary.deletedSinceImport = new Set(gone.map((g) => g.verdict)).size;
  }

  /**
   * Re-asks the name-and-size question for files still unresolved.
   *
   * Only worth running once something has changed the sizes it depends on,
   * which is why it is not simply part of pass 1.
   */
  async #nameAndSizePass(verdicts: FileVerdict[], options: MatchOptions): Promise<void> {
    const heartbeat = new Heartbeat();
    let done = 0;

    for (const verdict of verdicts) {
      if (options.signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
      done++;
      await heartbeat.beat(() =>
        options.onProgress?.({ phase: "lookup", done, total: verdicts.length }),
      );

      const file = verdict.file;
      if (!file.required || verdict.satisfied) continue;
      const stem = stemOf(file.name);

      for (const lib of this.#planFor(file.kind)?.libs ?? []) {
        if (atLeast(verdict.matches[lib.key]?.tier ?? "none", "probable")) continue;

        const named = this.#byNameAndSize(lib.id, file.size, stem, file.ext, file.meta.capturedAt);
        if (!named) continue;

        const { tier, reason } = nameAndSizeMatch(named, file, stem);
        if (tier !== "probable") continue;

        verdict.matches[lib.key] = {
          tier,
          reason,
          entryId: named.id,
          path: joinPath(named.dir_path, named.name),
        };
      }
    }
  }

  /**
   * Matches unresolved files on capture identity — the signal that survives
   * renaming and RAW->DNG conversion. Pure index lookups; the file reads that
   * make this possible happened in the preceding pass.
   */
  async #capturePass(verdicts: FileVerdict[], options: MatchOptions = {}): Promise<void> {
    const heartbeat = new Heartbeat();
    let done = 0;

    for (const verdict of verdicts) {
      if (options.signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
      done++;
      await heartbeat.beat(() =>
        options.onProgress?.({ phase: "capture", done, total: verdicts.length }),
      );

      if (!verdict.file.required || verdict.satisfied) continue;
      const captured = verdict.file.meta.capturedAt;
      if (captured === null) continue;

      const stem = stemOf(verdict.file.name);
      const plan = this.#planFor(verdict.file.kind);
      if (!plan) continue;

      for (const lib of plan.libs) {
        const current = verdict.matches[lib.key];
        if (current && atLeast(current.tier, "strong")) continue;

        const candidates = this.#byCapture(
          lib.id,
          captured,
          stem,
          verdict.file.ext,
        ).filter((c) => this.#cameraAgrees(c, verdict.file));
        if (candidates.length === 0) continue;

        // A burst can put several frames in the same second on the same body,
        // so prefer the candidate that also agrees on name, then on format.
        const score = (c: CandidateRow): number =>
          (c.stem === stem || c.orig_stem === stem ? 2 : 0) +
          (c.ext === verdict.file.ext ? 1 : 0);
        const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));

        verdict.matches[lib.key] = {
          tier: "strong",
          reason:
            best.ext === verdict.file.ext
              ? "same capture time and camera"
              : `same capture time and camera, stored as .${best.ext}`,
          entryId: best.id,
          path: joinPath(best.dir_path, best.name),
        };
      }
    }
  }

  /**
   * Reads capture metadata for everything still unread in the libraries that
   * are blocking files, then retries the capture pass.
   *
   * This exists because lazy indexing has a blind spot it cannot close on its
   * own: a file renamed *and* re-encoded on import shares no filename, size, or
   * content with the card original, so nothing points at it and there is
   * nothing to look up until the library side has been read. Reporting such
   * files as missing would be wrong in the most dangerous direction, so the
   * cost is paid once — cached against (size, mtime) — and every later scan of
   * that library is free again.
   */
  async #escalate(
    verdicts: FileVerdict[],
    summary: MatchSummary,
    options: MatchOptions,
  ): Promise<number> {
    const min = this.#config.minTier;
    let read = 0;

    for (const lib of this.#libs) {
      const blocking = verdicts.some(
        (v) =>
          v.file.required &&
          !v.satisfied &&
          (this.#planFor(v.file.kind)?.required.includes(lib) ?? false) &&
          !atLeast(v.matches[lib.key]?.tier ?? "none", min),
      );
      if (!blocking) continue;

      const pending =
        this.#db.getAs<{ n: number }>(
          "SELECT COUNT(*) AS n FROM entry WHERE library_id = ? AND meta_state = 'pending'",
          lib.id,
        )?.n ?? 0;
      if (pending === 0) continue;

      options.onProgress?.({ phase: "metadata", done: 0, total: pending });
      read += await enrichLibrary(this.#db, lib.id, {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (p) =>
          options.onProgress?.({
            phase: "metadata",
            done: p.done,
            total: p.total,
            bytes: p.bytes,
            totalBytes: p.totalBytes,
          }),
      });
      summary.escalatedLibraries.push(lib.key);
    }

    if (read > 0) {
      await this.#capturePass(verdicts, options);
      this.#settle(verdicts);
    }
    return read;
  }

  /**
   * Withdraws a name-and-size match once the library file's capture time turns
   * out to disagree with the card's.
   *
   * Cameras restart their filename counters, so IMG_0001 recurs every few
   * thousand frames; combined with a byte-size collision that is enough to
   * clear a file for deletion on a coincidence. A capture time settles it, and
   * reading one file to find out is worth it when the alternative is telling
   * someone it is safe to format a card that still holds the only copy.
   */
  #recheckProvisional(
    provisional: ReadonlyArray<{ verdict: FileVerdict; libKey: string; entryId: number }>,
  ): void {
    for (const { verdict, libKey, entryId } of provisional) {
      const current = verdict.matches[libKey];
      if (!current || current.entryId !== entryId) continue;

      const row = this.#db.getAs<{ captured_at: number | null }>(
        "SELECT captured_at FROM entry WHERE id = ?",
        entryId,
      );
      const captured = verdict.file.meta.capturedAt;
      if (!row || row.captured_at === null || captured === null) continue;
      if (row.captured_at === captured) continue;

      verdict.matches[libKey] = {
        ...current,
        tier: "weak",
        reason: "same filename and byte size, but a different capture time",
      };
    }
  }

  /** Applies the rule to each file's current match set. */
  #settle(verdicts: FileVerdict[]): void {
    const min = this.#config.minTier;
    for (const verdict of verdicts) {
      const plan = this.#planFor(verdict.file.kind);
      // No rule for this kind means it is not judged: an ignored kind never
      // blocks a format, the same way a sidecar does not.
      if (!verdict.file.required || !plan) {
        verdict.satisfied = true;
        verdict.gap = "";
        continue;
      }
      const matched = new Set<string>();
      for (const [key, match] of Object.entries(verdict.matches)) {
        if (atLeast(match.tier, min)) matched.add(key);
      }
      verdict.satisfied = evaluateRule(plan.rule, matched);
      verdict.gap = verdict.satisfied ? "" : describeGap(plan.rule, matched);
    }
  }
}
