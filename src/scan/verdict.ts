/**
 * Rolling per-file results up into an answer a person can act on.
 *
 * "1,438 of 1,502 files are backed up" is not actionable. "DCIM/104GOPRO is the
 * only folder holding you back, 64 clips" is. So the rollup keeps per-directory
 * state and surfaces the directories that directly contain blocked files.
 */

export type DirStatus = "clear" | "partial" | "blocked" | "empty";

export interface DirNode {
  /** Path relative to the card root. "" is the root itself. */
  path: string;
  name: string;
  status: DirStatus;
  /** Counts include everything beneath this directory. */
  totalFiles: number;
  requiredFiles: number;
  satisfied: number;
  blocked: number;
  bytes: number;
  blockedBytes: number;
  /** Blocked files sitting directly in this directory, not in a subdirectory. */
  ownBlocked: number;
  ownBlockedBytes: number;
  children: DirNode[];
}

export interface CardVerdict {
  status: "safe" | "unsafe" | "empty";
  totalFiles: number;
  /** Files that must be matched — excludes sidecars and OS junk. */
  requiredFiles: number;
  satisfied: number;
  blocked: number;
  bytes: number;
  blockedBytes: number;
  /** Directories that directly hold blocked files, worst first. */
  blockedDirs: Array<{ path: string; count: number; bytes: number }>;
  /** How many files are blocked by each distinct unmet requirement. */
  gaps: Array<{ requirement: string; count: number }>;
}

export interface ScanFileRecord {
  relDir: string;
  name: string;
  required: boolean;
  size: number;
  satisfied: boolean;
  gap: string;
}

function emptyNode(dirPath: string): DirNode {
  const name = dirPath === "" ? "" : (dirPath.split("/").pop() as string);
  return {
    path: dirPath,
    name,
    status: "empty",
    totalFiles: 0,
    requiredFiles: 0,
    satisfied: 0,
    blocked: 0,
    bytes: 0,
    blockedBytes: 0,
    ownBlocked: 0,
    ownBlockedBytes: 0,
    children: [],
  };
}

/** The directory containing `dirPath`, or null once we are past the root. */
function parentOf(dirPath: string): string | null {
  if (dirPath === "") return null;
  const slash = dirPath.lastIndexOf("/");
  return slash === -1 ? "" : dirPath.slice(0, slash);
}

function statusOf(node: DirNode): DirStatus {
  if (node.requiredFiles === 0) return "empty";
  if (node.blocked === 0) return "clear";
  if (node.satisfied === 0) return "blocked";
  return "partial";
}

export function buildRollup(records: readonly ScanFileRecord[]): {
  tree: DirNode;
  verdict: CardVerdict;
} {
  const nodes = new Map<string, DirNode>();
  nodes.set("", emptyNode(""));

  /** Creates a directory and every missing ancestor. */
  const ensure = (dirPath: string): DirNode => {
    const existing = nodes.get(dirPath);
    if (existing) return existing;

    const node = emptyNode(dirPath);
    nodes.set(dirPath, node);

    const parent = parentOf(dirPath);
    if (parent !== null) ensure(parent).children.push(node);
    return node;
  };

  const gaps = new Map<string, number>();

  for (const record of records) {
    const node = ensure(record.relDir);

    // Every count is inclusive of subdirectories, so accumulate up to the root.
    for (let p: string | null = record.relDir; p !== null; p = parentOf(p)) {
      const ancestor = nodes.get(p);
      if (!ancestor) continue;

      ancestor.totalFiles++;
      ancestor.bytes += record.size;
      if (!record.required) continue;

      ancestor.requiredFiles++;
      if (record.satisfied) {
        ancestor.satisfied++;
      } else {
        ancestor.blocked++;
        ancestor.blockedBytes += record.size;
      }
    }

    if (record.required && !record.satisfied) {
      node.ownBlocked++;
      node.ownBlockedBytes += record.size;
      const requirement = record.gap || "not found in any library";
      gaps.set(requirement, (gaps.get(requirement) ?? 0) + 1);
    }
  }

  for (const node of nodes.values()) {
    node.status = statusOf(node);
    node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  const root = nodes.get("") as DirNode;

  const blockedDirs = [...nodes.values()]
    .filter((n) => n.ownBlocked > 0)
    .map((n) => ({ path: n.path, count: n.ownBlocked, bytes: n.ownBlockedBytes }))
    // Ties broken by path so the report is stable between runs.
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const verdict: CardVerdict = {
    status: root.requiredFiles === 0 ? "empty" : root.blocked === 0 ? "safe" : "unsafe",
    totalFiles: root.totalFiles,
    requiredFiles: root.requiredFiles,
    satisfied: root.satisfied,
    blocked: root.blocked,
    bytes: root.bytes,
    blockedBytes: root.blockedBytes,
    blockedDirs,
    gaps: [...gaps.entries()]
      .map(([requirement, count]) => ({ requirement, count }))
      .sort((a, b) => b.count - a.count || a.requirement.localeCompare(b.requirement)),
  };

  return { tree: root, verdict };
}
