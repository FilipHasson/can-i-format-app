import fs from "node:fs/promises";
import path from "node:path";
import { configDir, configFile, normPath } from "./paths.ts";
import { isTier, type MatchTier } from "./tiers.ts";
import { validateRule } from "./rules.ts";
import { unknownTokens } from "./template.ts";

export type LibraryKind = "folder" | "lightroom";

/**
 * `lazy` reads capture metadata only for library files that are candidates for
 * something on a card — a million-file library then costs zero file opens to
 * index. `full` walks the whole library extracting metadata up front, which is
 * only worth it when imports rename files (so filename matching can't narrow).
 */
export type MetadataMode = "lazy" | "full";

export interface LibraryConfig {
  key: string;
  label: string;
  kind: LibraryKind;
  /** Folder root, or the path to a `.lrcat` file. */
  path: string;
  enabled: boolean;
  metadata: MetadataMode;
  /** Directory names, matched case-insensitively, skipped during the walk. */
  excludes: string[];
}

/**
 * What to do about a kind of media that does not belong with the rest.
 *
 * Video is the case that forced this: people keep footage somewhere other than
 * their photo library, or nowhere at all, and a card of clips reported as
 * unsafe to format teaches them to ignore the answer. `ignore` never blocks a
 * format; `rule` judges that kind against its own libraries.
 */
export type KindHandling =
  | { mode: "default" }
  | { mode: "ignore" }
  | { mode: "rule"; rule: string };

/** Kinds that can be given their own handling. */
export const CONFIGURABLE_KINDS = ["video", "audio"] as const;
export type ConfigurableKind = (typeof CONFIGURABLE_KINDS)[number];

/**
 * What an import sorts files into.
 *
 * Coarser than `MediaKind` on purpose: nobody files their raws in one place and
 * their JPEGs in another, but almost everybody keeps footage somewhere other
 * than their photo library.
 */
export const IMPORT_GROUPS = ["photos", "video", "audio"] as const;
export type ImportGroup = (typeof IMPORT_GROUPS)[number];

/**
 * Where one group of media goes.
 *
 * `library` follows the library's own root, so moving a library moves the
 * destination with it. `folder` names a path outright — used for a subfolder
 * of a library, or a place that is not a library at all.
 */
export type ImportDestination =
  | { mode: "skip" }
  | { mode: "library"; libraryKey: string }
  | { mode: "folder"; path: string };

export interface ImportConfig {
  destinations: Partial<Record<ImportGroup, ImportDestination>>;
  /** Folders below the destination. See `core/template.ts`. */
  folderTemplate: string;
  /** `{name}` keeps the camera's filename, which is what later scans match on. */
  filenameTemplate: string;
}

export interface AppConfig {
  version: number;
  setupComplete: boolean;
  /** Boolean expression over library keys. See `rules.ts`. */
  rule: string;
  libraries: LibraryConfig[];
  /** Confidence at which a library counts as "already has this file". */
  minTier: MatchTier;
  /** Treat .xmp/.thm/.lrv and friends as not needing a match. */
  ignoreSidecars: boolean;
  /** Extra extensions (no dot) to always ignore on cards. */
  ignoreExtensions: string[];
  /** `full` hashes entire files when confirming; `quick` uses head+tail+size. */
  hashMode: "quick" | "full";
  /** Port for the local UI. 0 picks a free one. */
  port: number;
  /** Per-kind overrides. Anything absent follows `rule`. */
  kinds: Partial<Record<ConfigurableKind, KindHandling>>;
  /**
   * Places checked by hand, kept so they stay on the dashboard.
   *
   * A card is detected because it is plugged in. A folder someone browsed to
   * is not, and having to find it again through a file picker every time is
   * the difference between checking it often and never checking it.
   */
  savedFolders: SavedFolder[];
  /** Where the missing files a scan finds get copied to, and how they are filed. */
  import: ImportConfig;
}

export interface SavedFolder {
  path: string;
  label: string;
}

export const CONFIG_VERSION = 1;

export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    setupComplete: false,
    rule: "",
    libraries: [],
    minTier: "probable",
    ignoreSidecars: true,
    ignoreExtensions: [],
    hashMode: "quick",
    port: 4111,
    kinds: {},
    savedFolders: [],
    import: defaultImportConfig(),
  };
}

export function defaultImportConfig(): ImportConfig {
  return {
    destinations: {},
    // Lightroom's own default, so an import lands where an existing library
    // already puts things rather than starting a second scheme beside the first.
    folderTemplate: "{YYYY}/{YYYY}-{MM}-{DD}",
    filenameTemplate: "{name}",
  };
}

/** The handling for a kind, defaulting to whatever the main rule says. */
export function handlingFor(config: AppConfig, kind: string): KindHandling {
  const configured = (config.kinds ?? {})[kind as ConfigurableKind];
  return configured ?? { mode: "default" };
}

/** The rule a kind is judged by, or null when it is not judged at all. */
export function ruleFor(config: AppConfig, kind: string): string | null {
  const handling = handlingFor(config, kind);
  if (handling.mode === "ignore") return null;
  if (handling.mode === "rule") return handling.rule;
  return config.rule;
}

/** Slugify a label into a key usable as a bare identifier in a rule. */
export function makeKey(label: string, taken: readonly string[] = []): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base === "" || /^[0-9-]/.test(base)) base = `lib-${base}`.replace(/-+$/, "");

  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_KEYS = new Set(["and", "or", "not"]);

/**
 * Why a key chosen by hand cannot be used, or null when it can.
 *
 * The same shape `makeKey` produces: a key has to stand as a bare word in a
 * rule, so it starts with a letter, holds only what the rule tokenizer reads
 * as part of a name, and is never one of the rule's own words. Lowercase
 * only, because rules compare keys exactly and `Backup` beside `backup` is a
 * mistake waiting to be made.
 */
export function keyProblem(key: string, taken: readonly string[]): string | null {
  if (key === "") return "A key can't be empty.";
  if (key.length > 40) return "Keep a key to 40 characters or fewer.";
  if (!KEY_PATTERN.test(key)) {
    return "Use lowercase letters, digits, - and _, starting with a letter.";
  }
  if (RESERVED_KEYS.has(key)) return `"${key}" is a word rules use, so it can't be a key.`;
  if (taken.includes(key)) return `Another library is already called "${key}".`;
  return null;
}

export function defaultLibrary(partial: Partial<LibraryConfig> & { path: string }): LibraryConfig {
  const kind: LibraryKind =
    partial.kind ?? (partial.path.toLowerCase().endsWith(".lrcat") ? "lightroom" : "folder");
  const label = partial.label ?? path.basename(partial.path).replace(/\.lrcat$/i, "");
  return {
    key: partial.key ?? makeKey(label),
    label,
    kind,
    path: normPath(partial.path),
    enabled: partial.enabled ?? true,
    metadata: partial.metadata ?? "lazy",
    excludes: partial.excludes ?? [],
  };
}

/**
 * A sensible starting rule: every library must have the file. Users relax it to
 * `(a or b) and c` from the UI once they see what their layout actually is.
 */
export function suggestRule(libraries: readonly LibraryConfig[]): string {
  const keys = libraries.filter((l) => l.enabled).map((l) => l.key);
  return keys.join(" and ");
}

export interface ConfigProblem {
  field: string;
  message: string;
}

export function validateConfig(cfg: AppConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const seen = new Set<string>();

  for (const lib of cfg.libraries) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(lib.key)) {
      problems.push({
        field: `libraries.${lib.key}`,
        message: `"${lib.key}" is not usable in a rule — use letters, digits, dashes and underscores, starting with a letter or digit.`,
      });
    }
    if (seen.has(lib.key)) {
      problems.push({ field: `libraries.${lib.key}`, message: `Duplicate library key "${lib.key}".` });
    }
    seen.add(lib.key);

    if (!lib.path) {
      problems.push({ field: `libraries.${lib.key}`, message: `Library "${lib.label}" has no path.` });
    }
  }

  const enabled = cfg.libraries.filter((l) => l.enabled).map((l) => l.key);
  if (cfg.rule.trim() === "") {
    if (enabled.length > 0) {
      problems.push({ field: "rule", message: "No rule set — nothing would ever count as safe to format." });
    }
  } else {
    const result = validateRule(cfg.rule, enabled);
    if (!result.ok) problems.push({ field: "rule", message: result.error ?? "Invalid rule." });
  }

  for (const kind of CONFIGURABLE_KINDS) {
    const handling = cfg.kinds?.[kind];
    if (handling?.mode !== "rule") continue;

    const label = kind === "video" ? "Video" : "Audio";
    if (handling.rule.trim() === "") {
      problems.push({ field: `kinds.${kind}`, message: `${label} has its own rule, but it is empty.` });
      continue;
    }
    const result = validateRule(handling.rule, enabled);
    if (!result.ok) {
      problems.push({ field: `kinds.${kind}`, message: `${label} rule: ${result.error ?? "invalid."}` });
    }
  }

  for (const group of IMPORT_GROUPS) {
    const destination = cfg.import?.destinations?.[group];
    if (destination?.mode !== "library") continue;
    if (!cfg.libraries.some((l) => l.key === destination.libraryKey)) {
      problems.push({
        field: `import.${group}`,
        message: `${group} are set to import into "${destination.libraryKey}", which is not a library.`,
      });
    }
  }

  for (const [field, template] of [
    ["import.folderTemplate", cfg.import?.folderTemplate ?? ""],
    ["import.filenameTemplate", cfg.import?.filenameTemplate ?? ""],
  ] as const) {
    const unknown = unknownTokens(template);
    if (unknown.length > 0) {
      problems.push({
        field,
        message: `Unknown ${unknown.length === 1 ? "token" : "tokens"} ${unknown
          .map((u) => `{${u}}`)
          .join(", ")}.`,
      });
    }
  }

  if (!isTier(cfg.minTier)) {
    problems.push({ field: "minTier", message: `Unknown confidence threshold "${String(cfg.minTier)}".` });
  }

  return problems;
}

/** Fill in anything missing so an older or hand-edited file still loads. */
function coerce(raw: unknown): AppConfig {
  const base = defaultConfig();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;

  const libraries = Array.isArray(r.libraries)
    ? r.libraries
        .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
        .filter((l) => typeof l.path === "string" && l.path !== "")
        .map((l) => defaultLibrary(l as Partial<LibraryConfig> & { path: string }))
    : [];

  return {
    version: typeof r.version === "number" ? r.version : CONFIG_VERSION,
    setupComplete: r.setupComplete === true,
    rule: typeof r.rule === "string" ? r.rule : "",
    libraries,
    minTier: isTier(r.minTier) ? r.minTier : base.minTier,
    ignoreSidecars: r.ignoreSidecars !== false,
    ignoreExtensions: Array.isArray(r.ignoreExtensions)
      ? r.ignoreExtensions.filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase().replace(/^\./, ""))
      : [],
    hashMode: r.hashMode === "full" ? "full" : "quick",
    port: typeof r.port === "number" && Number.isFinite(r.port) ? r.port : base.port,
    kinds: coerceKinds(r.kinds),
    savedFolders: Array.isArray(r.savedFolders)
      ? r.savedFolders
          .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
          .filter((f) => typeof f.path === "string" && f.path !== "")
          .map((f) => ({
            path: normPath(f.path as string),
            label:
              typeof f.label === "string" && f.label.trim() !== ""
                ? f.label.trim()
                : path.basename((f.path as string).replace(/[\\/]+$/, "")) || (f.path as string),
          }))
      : [],
    import: coerceImport(r.import),
  };
}

/** Anything unusable falls back to the default rather than failing the load. */
function coerceImport(raw: unknown): ImportConfig {
  const base = defaultImportConfig();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;

  const destinations: ImportConfig["destinations"] = {};
  const rawDest = typeof r.destinations === "object" && r.destinations !== null ? r.destinations : {};

  for (const group of IMPORT_GROUPS) {
    const value = (rawDest as Record<string, unknown>)[group];
    if (typeof value !== "object" || value === null) continue;
    const mode = (value as Record<string, unknown>).mode;

    if (mode === "skip") {
      destinations[group] = { mode: "skip" };
    } else if (mode === "library") {
      const key = (value as Record<string, unknown>).libraryKey;
      if (typeof key === "string" && key !== "") destinations[group] = { mode: "library", libraryKey: key };
    } else if (mode === "folder") {
      const target = (value as Record<string, unknown>).path;
      // A folder destination with no folder would copy to the process's
      // working directory, which is nowhere anyone meant.
      if (typeof target === "string" && target !== "") {
        destinations[group] = { mode: "folder", path: normPath(target) };
      }
    }
  }

  return {
    destinations,
    folderTemplate: typeof r.folderTemplate === "string" ? r.folderTemplate : base.folderTemplate,
    filenameTemplate:
      typeof r.filenameTemplate === "string" && r.filenameTemplate.trim() !== ""
        ? r.filenameTemplate
        : base.filenameTemplate,
  };
}

/** Anything unrecognised falls back to following the main rule. */
function coerceKinds(raw: unknown): AppConfig["kinds"] {
  if (typeof raw !== "object" || raw === null) return {};
  const out: AppConfig["kinds"] = {};

  for (const kind of CONFIGURABLE_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (typeof value !== "object" || value === null) continue;
    const mode = (value as Record<string, unknown>).mode;

    if (mode === "ignore") {
      out[kind] = { mode: "ignore" };
    } else if (mode === "rule") {
      const rule = (value as Record<string, unknown>).rule;
      // A "rule" handling with no rule in it would report everything missing.
      if (typeof rule === "string" && rule.trim() !== "") out[kind] = { mode: "rule", rule };
    }
  }
  return out;
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const text = await fs.readFile(configFile(), "utf8");
    return coerce(JSON.parse(text));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    if (err instanceof SyntaxError) {
      throw new Error(`Config at ${configFile()} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  const target = configFile();
  const tmp = `${target}.tmp`;
  // Write-then-rename so an interrupted save can't leave a truncated config.
  await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

export function findLibrary(cfg: AppConfig, key: string): LibraryConfig | undefined {
  return cfg.libraries.find((l) => l.key === key);
}
