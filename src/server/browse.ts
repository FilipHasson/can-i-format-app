import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normPath } from "../core/paths.ts";
import { resolveDirent } from "../core/dirent.ts";

const run = promisify(execFile);

/**
 * A server-side directory picker.
 *
 * The UI runs in a browser, which by design cannot tell the server about a
 * path on disk — a file input hands over file contents, not locations. So the
 * server does the browsing and the page just renders it.
 */

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** A Lightroom catalog, which can be picked as a library directly. */
  isCatalog: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  /** Handy starting points, shown when nothing is selected yet. */
  shortcuts: Array<{ label: string; path: string }>;
}

async function windowsDrives(): Promise<string[]> {
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID",
      ],
      { windowsHide: true, timeout: 15000 },
    );
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((d) => `${d}/`);
  } catch {
    return ["C:/"];
  }
}

async function shortcuts(): Promise<Array<{ label: string; path: string }>> {
  const home = os.homedir();
  const candidates: Array<{ label: string; path: string }> = [
    { label: "Home", path: home },
    { label: "Pictures", path: path.join(home, "Pictures") },
    { label: "Movies", path: path.join(home, process.platform === "darwin" ? "Movies" : "Videos") },
    { label: "Desktop", path: path.join(home, "Desktop") },
  ];

  if (process.platform === "win32") {
    // Cloud folders are a common home for a library, and are otherwise several
    // clicks down from Home.
    for (const name of await fs.readdir(home).catch(() => [])) {
      if (/^(onedrive|dropbox|google drive|icloud)/i.test(name)) {
        candidates.push({ label: name, path: path.join(home, name) });
      }
    }
    for (const drive of await windowsDrives()) candidates.push({ label: drive, path: drive });
  } else if (process.platform === "darwin") {
    candidates.push({ label: "Volumes", path: "/Volumes" });
  } else {
    candidates.push({ label: "Filesystem", path: "/" });
    candidates.push({ label: "Media", path: "/media" });
  }

  const usable = await Promise.all(
    candidates.map(async (c) => {
      try {
        const st = await fs.stat(c.path);
        return st.isDirectory() ? { label: c.label, path: normPath(c.path) } : null;
      } catch {
        return null;
      }
    }),
  );

  return usable.filter((c): c is { label: string; path: string } => c !== null);
}

export async function browse(target?: string): Promise<BrowseResult> {
  const links = await shortcuts();
  const start = target && target.trim() !== "" ? normPath(target) : normPath(os.homedir());

  const entries: BrowseEntry[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(start, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot open ${start}: ${(err as NodeJS.ErrnoException).message}`);
  }

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".") && dirent.name !== "..") continue;

    // A OneDrive folder is reported here as a link rather than a directory,
    // so asking the dirent alone would hide it from the picker entirely.
    const kind = dirent.isDirectory()
      ? "directory"
      : await resolveDirent(start, dirent);

    const isCatalog = kind === "file" && dirent.name.toLowerCase().endsWith(".lrcat");
    // Only directories and catalogs are selectable, so nothing else is noise.
    if (kind !== "directory" && !isCatalog) continue;

    entries.push({
      name: dirent.name,
      path: `${start.replace(/\/+$/, "")}/${dirent.name}`,
      isDirectory: kind === "directory",
      isCatalog,
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const parentPath = path.dirname(start);
  const parent = normPath(parentPath) === start ? null : normPath(parentPath);

  return { path: start, parent, entries, shortcuts: links };
}
