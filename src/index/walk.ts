import fs from "node:fs/promises";
import { JUNK_DIRS, isCameraSupportDir } from "../core/media.ts";
import { resolveDirent } from "../core/dirent.ts";
import { extOf, joinPath, normPath } from "../core/paths.ts";
import { pool, IO_CONCURRENCY } from "../core/pool.ts";

/**
 * Directory walking, tuned for libraries in the millions of files.
 *
 * Three things keep this cheap:
 *
 *  1. Extension filtering happens on the *name*, before any `stat`. A library
 *     folder full of sidecars, previews and `.lrdata` bundles costs nothing.
 *  2. `stat` is the only per-file syscall, and it is skipped entirely for
 *     directories whose mtime is unchanged since the last index.
 *  3. The walk is an explicit stack, so a pathological tree depth can't blow
 *     the call stack.
 */

export interface WalkedEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface WalkedDirectory {
  path: string;
  mtimeMs: number;
  /** Directory mtime matched the cache — caller should reuse its stored rows. */
  unchanged: boolean;
  /** Empty when `unchanged` is true. */
  files: WalkedEntry[];
  fileCount: number;
}

export interface WalkOptions {
  /** Extra directory names to skip, matched case-insensitively. */
  excludeDirs?: readonly string[];
  /** Return false to skip a file before it is ever stat-ed. */
  keepFile?: (name: string, ext: string) => boolean;
  /**
   * Return true when a directory's contents are known-unchanged. Returning
   * false (the default) forces a full stat pass, which is what `full` mode does.
   */
  isUnchanged?: (path: string, mtimeMs: number) => boolean;
  followSymlinks?: boolean;
  signal?: AbortSignal;
  onProgress?: (dirsSeen: number, filesSeen: number) => void;
}

export interface WalkResult {
  directories: number;
  files: number;
  skippedDirectories: number;
  errors: Array<{ path: string; message: string }>;
}

export async function walk(
  root: string,
  options: WalkOptions,
  onDirectory: (dir: WalkedDirectory) => Promise<void> | void,
): Promise<WalkResult> {
  const excluded = new Set([
    ...JUNK_DIRS,
    ...(options.excludeDirs ?? []).map((d) => d.toLowerCase()),
  ]);
  const keepFile = options.keepFile ?? (() => true);
  const isUnchanged = options.isUnchanged ?? (() => false);
  const followSymlinks = options.followSymlinks ?? false;

  const result: WalkResult = { directories: 0, files: 0, skippedDirectories: 0, errors: [] };
  const stack: string[] = [normPath(root)];
  const visited = new Set<string>();

  while (stack.length > 0) {
    if (options.signal?.aborted) throw new DOMException("Walk aborted", "AbortError");

    const dirPath = stack.pop() as string;

    let dirStat;
    try {
      dirStat = await fs.stat(dirPath);
    } catch (err) {
      result.errors.push({ path: dirPath, message: (err as Error).message });
      continue;
    }

    // Symlinked directories can form cycles; only follow each real path once.
    if (followSymlinks) {
      const real = await fs.realpath(dirPath).catch(() => dirPath);
      if (visited.has(real)) continue;
      visited.add(real);
    }

    let dirents;
    try {
      dirents = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      result.errors.push({ path: dirPath, message: (err as Error).message });
      continue;
    }

    const candidates: string[] = [];
    for (const dirent of dirents) {
      const name = dirent.name;

      // Not `dirent.isDirectory()`: on Windows anything with a reparse point on
      // it — a OneDrive folder, most obviously — is reported as a link here,
      // and a library kept in one would index as empty.
      const kind = dirent.isDirectory() ? "directory" : await resolveDirent(dirPath, dirent);

      if (kind === "directory") {
        if (excluded.has(name.toLowerCase())) continue;
        if (isCameraSupportDir(name, dirPath)) continue;
        stack.push(joinPath(dirPath, name));
        continue;
      }

      if (kind === "symlink") {
        // A real link, which can point back up the tree it came from.
        if (!followSymlinks) continue;
        const target = joinPath(dirPath, name);
        const st = await fs.stat(target).catch(() => null);
        if (st?.isDirectory()) {
          stack.push(target);
          continue;
        }
        if (!st?.isFile()) continue;
      } else if (kind !== "file") {
        continue;
      }

      if (!keepFile(name, extOf(name))) continue;
      candidates.push(name);
    }

    result.directories++;

    const mtimeMs = Math.round(dirStat.mtimeMs);
    if (isUnchanged(dirPath, mtimeMs)) {
      result.skippedDirectories++;
      result.files += candidates.length;
      await onDirectory({
        path: dirPath,
        mtimeMs,
        unchanged: true,
        files: [],
        fileCount: candidates.length,
      });
      options.onProgress?.(result.directories, result.files);
      continue;
    }

    // `lstat` rather than `stat`: we already resolved symlinks above, and it
    // avoids a second resolution per file.
    const stats = await pool(candidates, IO_CONCURRENCY, async (name) => {
      try {
        const st = await fs.lstat(joinPath(dirPath, name));
        return { name, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
      } catch {
        return null;
      }
    });

    const files = stats.filter((s): s is WalkedEntry => s !== null);
    result.files += files.length;

    await onDirectory({
      path: dirPath,
      mtimeMs,
      unchanged: false,
      files,
      fileCount: files.length,
    });
    options.onProgress?.(result.directories, result.files);
  }

  return result;
}
