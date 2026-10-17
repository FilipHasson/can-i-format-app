import { normPath, pathKey } from "./paths.ts";

/**
 * Deciding where a card file lands in a library.
 *
 * Photographers organise by date and expect to keep doing so, so the layout is
 * a template — `{YYYY}/{YYYY}-{MM}-{DD}` is Lightroom's own default and the one
 * most people already have on disk. The tokens are deliberately few: this
 * decides where someone's originals live for the next decade, and a template
 * language nobody can read at a glance is a liability.
 *
 * Everything here is written on the assumption that the template is hostile.
 * It is typed by hand into a field that names a real directory on a real disk,
 * so every segment is sanitised and the result is checked to be inside the
 * destination before anything is created. See `joinUnder`.
 */

export interface TemplateFacts {
  /** Naive YYYYMMDDHHMMSS from EXIF, or null when nothing dated the file. */
  capturedAt: number | null;
  /** Filesystem mtime — the fallback, and a worse one. See `datedByFile`. */
  mtimeMs: number;
  /** Original filename, extension included. */
  name: string;
  ext: string;
  kind: string;
  group: string;
  /** Camera model, without the serial half of a camera key. */
  camera: string | null;
  /** What the card is called. */
  card: string;
  /** The folder the file sits in on the card, relative to its root. */
  cardDir: string;
}

export interface Token {
  token: string;
  describe: string;
}

/** Everything a template may say, and what it means. Shown in the UI. */
export const TOKENS: readonly Token[] = [
  { token: "YYYY", describe: "Year, four digits" },
  { token: "YY", describe: "Year, two digits" },
  { token: "MM", describe: "Month, 01–12" },
  { token: "M", describe: "Month, 1–12 — no leading zero" },
  { token: "DD", describe: "Day, 01–31" },
  { token: "D", describe: "Day, 1–31 — no leading zero" },
  { token: "HH", describe: "Hour, 00–23" },
  { token: "mm", describe: "Minute" },
  { token: "ss", describe: "Second" },
  { token: "camera", describe: "Camera model" },
  { token: "card", describe: "Card name" },
  { token: "kind", describe: "photos, video or audio" },
  { token: "name", describe: "Original filename, without the extension" },
  { token: "ext", describe: "Extension, lowercase" },
  { token: "EXT", describe: "Extension, uppercase" },
  { token: "cardfolder", describe: "Folder it sat in on the card" },
];

const TOKEN_NAMES = new Set(TOKENS.map((t) => t.token));

/** Ready-made layouts, so most people never type a template at all. */
export const FOLDER_PRESETS: ReadonlyArray<{ template: string; label: string }> = [
  { template: "{YYYY}/{YYYY}-{MM}-{DD}", label: "2026 / 2026-08-19  (Lightroom's default)" },
  { template: "{YYYY}/{MM}-{DD}-{YYYY}", label: "2026 / 08-19-2026" },
  { template: "{YYYY}/{M}-{D}-{YYYY}", label: "2026 / 8-19-2026  (no leading zeros)" },
  { template: "{YYYY}/{MM}/{DD}", label: "2026 / 08 / 19" },
  { template: "{YYYY}-{MM}-{DD}", label: "2026-08-19" },
  { template: "{YYYY}/{YYYY}-{MM}-{DD} {camera}", label: "2026 / 2026-08-19 ILCE-7RM5" },
  { template: "{YYYY}/{MM}", label: "2026 / 08" },
  { template: "", label: "Everything in one folder" },
];

/**
 * The token someone probably meant.
 *
 * Case is the whole difficulty: `{MM}` is a month and `{mm}` is a minute, so
 * folding case would quietly file a year's work by the wrong number. Rather
 * than guess, an unknown token that differs from a real one only by case gets
 * named in the error — `{yyyy}` is a typo for `{YYYY}`, and saying so is worth
 * more than either accepting it or a bare rejection.
 */
export function suggestToken(name: string): string | null {
  if (TOKEN_NAMES.has(name)) return null;

  const hits = TOKENS.filter((t) => t.token.toLowerCase() === name.toLowerCase());
  // `{Mm}` could be either, and a suggestion taken on trust would file a year
  // of work by the minute it was shot. Where case cannot decide, say nothing.
  return hits.length === 1 ? (hits[0] as Token).token : null;
}

interface DateParts {
  YYYY: string;
  YY: string;
  MM: string;
  /** Unpadded, for the many libraries filed as `2024/7-1-2024`. */
  M: string;
  DD: string;
  D: string;
  HH: string;
  mm: string;
  ss: string;
}

/** "07" -> "7". Whatever the source, a number is what comes out. */
const unpad = (s: string): string => String(Number(s));

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Date parts for a file, and whether they came from the file's own timestamp.
 *
 * A capture time is the moment the shutter opened. An mtime is whenever the
 * bytes were last written, which for a card that has been copied about can be
 * years later — so the two are never silently mixed. Callers surface the count
 * of files dated the second way, because a wrong year puts a photograph in a
 * folder its owner will not think to look in.
 */
export function dateParts(facts: TemplateFacts): { parts: DateParts; datedByFile: boolean } {
  if (facts.capturedAt !== null && facts.capturedAt > 0) {
    const s = String(facts.capturedAt).padStart(14, "0");
    return {
      datedByFile: false,
      parts: {
        YYYY: s.slice(0, 4),
        YY: s.slice(2, 4),
        MM: s.slice(4, 6),
        M: unpad(s.slice(4, 6)),
        DD: s.slice(6, 8),
        D: unpad(s.slice(6, 8)),
        HH: s.slice(8, 10),
        mm: s.slice(10, 12),
        ss: s.slice(12, 14),
      },
    };
  }

  // Local time deliberately: an mtime is being used as a stand-in for "when
  // this was shot", and the person filing it thinks in their own clock.
  const d = new Date(facts.mtimeMs);
  const year = pad(d.getFullYear(), 4);
  return {
    datedByFile: true,
    parts: {
      YYYY: year,
      YY: year.slice(2),
      MM: pad(d.getMonth() + 1),
      M: String(d.getMonth() + 1),
      DD: pad(d.getDate()),
      D: String(d.getDate()),
      HH: pad(d.getHours()),
      mm: pad(d.getMinutes()),
      ss: pad(d.getSeconds()),
    },
  };
}

function stemOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function valueFor(token: string, facts: TemplateFacts, parts: DateParts): string {
  switch (token) {
    case "YYYY":
    case "YY":
    case "MM":
    case "M":
    case "DD":
    case "D":
    case "HH":
    case "mm":
    case "ss":
      return parts[token];
    case "camera":
      return facts.camera ?? "";
    case "card":
      return facts.card;
    case "kind":
      return facts.group;
    case "name":
      return stemOfName(facts.name);
    case "ext":
      return facts.ext.toLowerCase();
    case "EXT":
      return facts.ext.toUpperCase();
    case "cardfolder":
      return facts.cardDir;
    default:
      return "";
  }
}

/** Tokens in a template that mean nothing. Empty means the template is usable. */
export function unknownTokens(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    const name = match[1] ?? "";
    if (!TOKEN_NAMES.has(name)) found.add(name);
  }
  return [...found];
}

/** Windows refuses these outright, whatever the extension after them. */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * One path segment, made safe to create.
 *
 * Returns "" for anything that cannot be a folder name, and callers drop those
 * rather than creating a folder called `_`. The rules are Windows' — it is the
 * strictest of the three platforms, and a library written on one machine gets
 * opened on another.
 *
 * Trailing dots and spaces get special treatment because Windows silently
 * strips them: ask for `Sunday ` and you get `Sunday`, so the path we recorded
 * and the path that exists disagree, and the next scan cannot find the file.
 */
export function safeSegment(raw: string): string {
  let s = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "");
  // Collapse the runs of spaces an absent token leaves behind.
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[. ]+$/, "").replace(/^[. ]+/, "");
  if (s === "") return "";
  if (RESERVED.has(s.toLowerCase().split(".")[0] ?? "")) return "";
  // NAME_MAX is 255 on every filesystem worth supporting.
  return s.slice(0, 200);
}

/**
 * A template plus a file, as a relative path.
 *
 * Segments that sanitise away are dropped, so `{camera}/{YYYY}` on a file whose
 * camera is unknown files it under the year rather than under a stray empty
 * folder.
 */
export function expandTemplate(
  template: string,
  facts: TemplateFacts,
): { path: string; datedByFile: boolean } {
  const { parts, datedByFile } = dateParts(facts);

  const expanded = template.replace(/\{([^}]*)\}/g, (_, token: string) =>
    valueFor(token, facts, parts),
  );

  const segments = expanded
    .split(/[/\\]+/)
    .map(safeSegment)
    .filter((s) => s !== "");

  return { path: segments.join("/"), datedByFile };
}

/**
 * A filename from a template, keeping the original extension.
 *
 * The extension is never templated away: a `.ARW` that arrives called `.arw`
 * is a different file to half the tools that will read it, and a raw with no
 * extension is not openable at all.
 */
export function expandFilename(template: string, facts: TemplateFacts): string {
  const { parts } = dateParts(facts);
  const expanded = template.replace(/\{([^}]*)\}/g, (_, token: string) =>
    valueFor(token, facts, parts),
  );

  const stem = safeSegment(expanded);
  // Taken from the original name rather than `facts.ext`, which is folded to
  // lowercase for matching. A camera writes A9303932.ARW and that is the file
  // the photographer expects to find in their library, not A9303932.arw.
  const dot = facts.name.lastIndexOf(".");
  const ext = dot <= 0 ? "" : facts.name.slice(dot);
  // A template that sanitises to nothing would produce a file called ".ARW",
  // which is hidden on Unix and nameless everywhere.
  if (stem === "") return facts.name;
  return `${stem}${ext}`;
}

/**
 * Joins a relative path onto a base, or returns null if it would end up
 * outside it.
 *
 * This is the last line of defence and the reason it exists as its own
 * function: the segment sanitiser already removes separators and `..` cannot
 * survive it, but the cost of being wrong here is writing over files anywhere
 * on the disk, so the result is checked rather than reasoned about.
 */
export function joinUnder(base: string, relative: string): string | null {
  const root = normPath(base).replace(/\/+$/, "");
  const joined = normPath(relative === "" ? root : `${root}/${relative}`);

  const rootKey = pathKey(root);
  const joinedKey = pathKey(joined);
  if (joinedKey !== rootKey && !joinedKey.startsWith(`${rootKey}/`)) return null;
  return joined;
}

/**
 * Adds `_2`, `_3` … before the extension.
 *
 * Two cameras shooting the same day produce two files called IMG_0001, and
 * they are different photographs. Nothing is ever overwritten to resolve that,
 * so one of them takes a suffix — the same answer Lightroom gives.
 */
export function disambiguate(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}_${n}`;
  return `${name.slice(0, dot)}_${n}${name.slice(dot)}`;
}
