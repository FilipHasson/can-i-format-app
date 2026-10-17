/**
 * The decisions the desktop shell makes that are worth being sure about:
 * where the window is allowed to navigate, what may be handed to the operating
 * system to open, and where the window is put back on screen.
 *
 * They live here, free of Electron, so they can be tested by calling them
 * rather than by launching a window and hoping.
 */

/** A window's remembered geometry. */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/** The usable area of one display — Electron's `workArea`, minus the taskbar. */
export interface DisplayArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * True only for the app's own origin. The page is served over loopback, so a
 * link that leaves it is either a mistake or someone else's idea, and either
 * way it does not belong inside a window that can read the filesystem through
 * its API.
 */
export function isInternalUrl(candidate: string, origin: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(candidate);
    base = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === base.protocol && url.host === base.host;
}

/**
 * `shell.openExternal` hands a string to the operating system and asks it to
 * do whatever it thinks best. `file:` opens a document in whatever is
 * registered for it, and the schemes below that are worse than that. Only the
 * ones that unambiguously mean "a page, elsewhere" are passed on.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternal(candidate: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(candidate).protocol);
  } catch {
    return false;
  }
}

/**
 * Enough of the window on screen to be able to grab it and drag it back —
 * measured in both directions rather than as an area. A forty-pixel strip down
 * the side of the screen covers more square pixels than a comfortable corner
 * does, and there is nothing on it to take hold of.
 */
const MIN_VISIBLE_ACROSS = 96;
const MIN_VISIBLE_DOWN = 48;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function overlaps(a: DisplayArea, b: DisplayArea): boolean {
  const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return across >= MIN_VISIBLE_ACROSS && down >= MIN_VISIBLE_DOWN;
}

/**
 * Where to put the window, given what was saved last time and the displays
 * that exist now.
 *
 * A remembered position is only honoured while somewhere to see it remains.
 * Unplug the second monitor the app was last used on and the saved coordinates
 * describe a window off the edge of the world: it opens, it is running, it
 * takes the keyboard, and there is nothing on screen. Dropping the position —
 * Electron then centres it — is the one recovery that needs no explanation.
 */
export function placeWindow(
  saved: Partial<WindowBounds> | null | undefined,
  displays: DisplayArea[],
  fallback: { width: number; height: number },
): WindowBounds {
  const width = clamp(Math.round(saved?.width ?? fallback.width), 720, 20000);
  const height = clamp(Math.round(saved?.height ?? fallback.height), 520, 20000);
  const bounds: WindowBounds = { width, height };
  if (saved?.maximized) bounds.maximized = true;

  if (saved?.x === undefined || saved?.y === undefined) return bounds;
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return bounds;

  const x = Math.round(saved.x);
  const y = Math.round(saved.y);
  const visible = { x, y, width, height };
  if (!displays.some((display) => overlaps(visible, display))) return bounds;

  bounds.x = x;
  bounds.y = y;
  return bounds;
}

/** Reads back what was written, rejecting anything that is not geometry. */
export function parseWindowState(raw: string): Partial<WindowBounds> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const out: Partial<WindowBounds> = {};
  for (const key of ["x", "y", "width", "height"] as const) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  if (record.maximized === true) out.maximized = true;
  return out;
}
