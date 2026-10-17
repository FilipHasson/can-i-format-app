import fs from "node:fs/promises";
import type { Dirent } from "node:fs";

/**
 * What a directory entry really is.
 *
 * `readdir` reports a type taken straight from the directory entry, and on
 * Windows anything carrying a reparse point comes back as a symlink whether or
 * not it is one. OneDrive's Files On-Demand root is exactly that: `readdir`
 * calls it a link, `stat` calls it a directory, and `lstat` confirms it is not
 * a link at all. Trusting the first answer makes a OneDrive folder invisible
 * to the picker and unwalkable by the indexer — a library kept there indexes
 * as empty, with nothing to say why.
 *
 * So the unusual cases get a second look. Plain directories and plain files —
 * which is nearly everything — are answered without another syscall.
 */

export type EntryKind = "directory" | "file" | "symlink" | "other";

export async function resolveDirent(dirPath: string, dirent: Dirent): Promise<EntryKind> {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (!dirent.isSymbolicLink()) return "other";

  const full = `${dirPath.replace(/\/+$/, "")}/${dirent.name}`;

  // A genuine symlink is a genuine symlink, and the caller decides what to do
  // about the cycles those can form. A reparse point that lstat does not call
  // a link is not one, and should be treated as whatever it actually is.
  const link = await fs.lstat(full).catch(() => null);
  if (!link) return "other";
  if (link.isSymbolicLink()) return "symlink";
  if (link.isDirectory()) return "directory";
  if (link.isFile()) return "file";
  return "other";
}

/** True where the entry is a directory, however the directory entry described it. */
export async function isRealDirectory(dirPath: string, dirent: Dirent): Promise<boolean> {
  return (await resolveDirent(dirPath, dirent)) === "directory";
}
