import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normPath } from "../core/paths.ts";

const run = promisify(execFile);

/**
 * Finding the cards and drives worth auditing.
 *
 * Detection is a convenience, never a gate — a CFexpress reader may well
 * present as a fixed disk, and an "SSD I just shot to" is indistinguishable
 * from any other volume. Every code path here degrades to "let the user type a
 * path", which always works.
 */
export interface Volume {
  path: string;
  label: string;
  removable: boolean;
  totalBytes: number | null;
  freeBytes: number | null;
  /** Contains a directory cameras create — a strong hint this is shooting media. */
  looksLikeCard: boolean;
  /** Which marker directory was found, for display. */
  marker: string | null;
  /** Volume serial, where the platform reports one. Unique per card. */
  serial: string | null;
  /** The reader's model, which names the kind of card it takes. */
  model: string | null;
}

/** Directories that only appear on camera media. */
const CARD_MARKERS = [
  "DCIM",       // near-universal stills
  "PRIVATE",    // AVCHD, Sony
  "CLIP",       // Sony XAVC
  "XDROOT",     // Sony XDCAM
  "BDMV",       // AVCHD video
  "M4ROOT",     // Sony
  "PANA_GRP",   // Panasonic
  "CONTENTS",   // Blackmagic / ARRI
  "AVCHD",
  "MISC",
];

async function detectMarker(root: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const names = new Map(
      entries.filter((e) => e.isDirectory()).map((e) => [e.name.toUpperCase(), e.name]),
    );
    for (const marker of CARD_MARKERS) {
      const found = names.get(marker);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

async function sizes(root: string): Promise<{ total: number | null; free: number | null }> {
  try {
    const st = await fs.statfs(root);
    return { total: Number(st.blocks) * st.bsize, free: Number(st.bavail) * st.bsize };
  } catch {
    return { total: null, free: null };
  }
}

interface WindowsDisk {
  DeviceID: string;
  VolumeName: string | null;
  DriveType: number;
  Size: number | null;
  FreeSpace: number | null;
  VolumeSerialNumber: string | null;
  Model: string | null;
}

async function listWindows(): Promise<Volume[]> {
  const script =
    "$out = Get-CimInstance Win32_LogicalDisk | ForEach-Object { " +
    "  $ld = $_; $model = $null; " +
    "  try { " +
    "    $p = Get-CimAssociatedInstance -InputObject $ld -ResultClassName Win32_DiskPartition -ErrorAction Stop | Select-Object -First 1; " +
    "    if ($p) { $d = Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_DiskDrive -ErrorAction Stop | Select-Object -First 1; if ($d) { $model = $d.Model } } " +
    "  } catch {} " +
    "  [pscustomobject]@{ DeviceID = $ld.DeviceID; VolumeName = $ld.VolumeName; DriveType = $ld.DriveType; " +
    "    Size = $ld.Size; FreeSpace = $ld.FreeSpace; VolumeSerialNumber = $ld.VolumeSerialNumber; Model = $model } " +
    "}; ConvertTo-Json -InputObject @($out) -Compress";

  let parsed: WindowsDisk[];
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const json = JSON.parse(stdout.trim() || "[]");
    parsed = Array.isArray(json) ? json : [json];
  } catch {
    return [];
  }

  const systemDrive = (process.env.SystemDrive ?? "C:").toUpperCase();
  const volumes: Volume[] = [];

  for (const disk of parsed) {
    if (!disk?.DeviceID) continue;
    // 2 = removable, 3 = fixed. Fixed is included because plenty of card
    // readers and external SSDs enumerate that way; network drives are not.
    if (disk.DriveType !== 2 && disk.DriveType !== 3) continue;

    const root = `${disk.DeviceID}/`;
    const marker = await detectMarker(root);
    const isSystem = disk.DeviceID.toUpperCase() === systemDrive;
    if (isSystem && !marker) continue;

    volumes.push({
      path: normPath(root),
      label: disk.VolumeName || disk.DeviceID,
      removable: disk.DriveType === 2,
      totalBytes: disk.Size ?? null,
      freeBytes: disk.FreeSpace ?? null,
      looksLikeCard: marker !== null,
      marker,
      serial: disk.VolumeSerialNumber ?? null,
      model: disk.Model ?? null,
    });
  }

  return volumes;
}

async function listDarwin(): Promise<Volume[]> {
  const volumes: Volume[] = [];
  let entries;
  try {
    entries = await fs.readdir("/Volumes", { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = path.join("/Volumes", entry.name);

    // The boot volume is symlinked into /Volumes; skip it unless it somehow
    // looks like shooting media.
    const real = await fs.realpath(root).catch(() => root);
    const marker = await detectMarker(root);
    if (real === "/" && !marker) continue;

    const { total, free } = await sizes(root);
    volumes.push({
      path: normPath(root),
      label: entry.name,
      removable: true, // Anything mounted under /Volumes is ejectable in practice.
      totalBytes: total,
      freeBytes: free,
      looksLikeCard: marker !== null,
      marker,
      // Neither is available here; the card is described by what it holds.
      serial: null,
      model: null,
    });
  }

  return volumes;
}

async function listLinux(): Promise<Volume[]> {
  let mounts: string;
  try {
    mounts = await fs.readFile("/proc/mounts", "utf8");
  } catch {
    return [];
  }

  const user = os.userInfo().username;
  const prefixes = ["/media/", "/run/media/", "/mnt/", `/media/${user}/`, `/run/media/${user}/`];
  const volumes: Volume[] = [];
  const seen = new Set<string>();

  for (const line of mounts.split("\n")) {
    const [device, rawPoint] = line.split(/\s+/);
    if (!device || !rawPoint) continue;
    if (!device.startsWith("/dev/")) continue;

    // /proc/mounts octal-escapes spaces and friends.
    const point = rawPoint.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (!prefixes.some((p) => point.startsWith(p))) continue;
    if (seen.has(point)) continue;
    seen.add(point);

    const marker = await detectMarker(point);
    const { total, free } = await sizes(point);
    volumes.push({
      path: normPath(point),
      label: path.basename(point),
      removable: true,
      totalBytes: total,
      freeBytes: free,
      looksLikeCard: marker !== null,
      marker,
      // Neither is available here; the card is described by what it holds.
      serial: null,
      model: null,
    });
  }

  return volumes;
}

/** Best-effort list of mounted volumes that could plausibly hold shooting media. */
export async function listVolumes(): Promise<Volume[]> {
  const volumes =
    process.platform === "win32"
      ? await listWindows()
      : process.platform === "darwin"
        ? await listDarwin()
        : await listLinux();

  // Cards first, then removable, then everything else.
  return volumes.sort((a, b) => {
    if (a.looksLikeCard !== b.looksLikeCard) return a.looksLikeCard ? -1 : 1;
    if (a.removable !== b.removable) return a.removable ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** Describes an arbitrary path the user typed, for the same UI treatment. */
export async function describePath(target: string): Promise<Volume | null> {
  const root = normPath(target);
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }

  const marker = await detectMarker(root);
  const { total, free } = await sizes(root);
  return {
    path: root,
    label: path.basename(root) || root,
    removable: false,
    totalBytes: total,
    freeBytes: free,
    looksLikeCard: marker !== null,
    marker,
    serial: null,
    model: null,
  };
}
