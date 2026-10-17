import type { Db } from "../core/db.ts";
import type { Volume } from "./volumes.ts";

/**
 * Telling one card from another.
 *
 * Drive letters are reused: swap two cards through the same reader and both
 * are G:. Scan history then records two shoots against the same name, and
 * "have I checked this one yet" stops having an answer.
 *
 * What is actually available, in descending order of usefulness:
 *
 *   volume serial   Written at format time and unique per card. Cameras and
 *                   Windows both set one — but not always: a card formatted
 *                   in some bodies comes back 0000-0000, and there is then
 *                   nothing on it that distinguishes it from its twin.
 *   reader model    Names the *slot*, not the card — "ProGrade CFexpress
 *                   PG09" — which is exactly how to tell SD from CFexpress.
 *   capacity        The number printed on the card, once the reported bytes
 *                   are snapped back to a size cards are actually sold in.
 *
 * So a card that can be identified gets a lasting name, and one that cannot
 * gets an honest description of what it is. Formatting resets the serial and
 * the card reads as new. Names could once be pinned by hand to survive that,
 * but a name tied to an identity the card loses on every format was more
 * confusing than useful, so they no longer are.
 */

/** Capacities cards are sold in. Reported bytes are snapped to the nearest. */
const NOMINAL_SIZES = [8, 16, 32, 64, 128, 160, 256, 320, 512, 640, 1024, 2048, 4096, 8192];
/** How far off a reported size may be and still be that nominal size. */
const SNAP_TOLERANCE = 0.12;

export interface CardIdentity {
  /** Registry row, or null for a volume not worth remembering. */
  id: number | null;
  /** What to call it: "CFexpress 512GB" or "SD 128GB #2". */
  name: string;
  /** Without the sequence number — "SD 128GB". */
  descriptor: string;
  /**
   * False when nothing on the card distinguishes it from another of the same
   * type and size, so the name describes a kind of card rather than one card.
   */
  distinguishable: boolean;
}

/**
 * The card type, read from the reader's model.
 *
 * A reader is built for one kind of card, so its name is a reliable statement
 * about what is in it — far more so than anything the card itself reports.
 */
export function cardKind(model: string | null, removable: boolean): string {
  const m = (model ?? "").toLowerCase();
  if (/cfexpress|cfx|\bxqd\b/.test(m)) return "CFexpress";
  if (/microsd|micro sd/.test(m)) return "microSD";
  if (/compactflash|\bcf\b/.test(m)) return "CompactFlash";
  if (/\bsdxc\b|\bsdhc\b|\bsd\b/.test(m)) return "SD";
  if (/\bssd\b|nvme/.test(m)) return "SSD";
  return removable ? "Card" : "Drive";
}

/** "512GB" — what is printed on the card, not what the filesystem reports. */
export function nominalSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  // Cards are sold in decimal gigabytes, and a formatted card reports less
  // than its raw capacity, so both conversions have to go the same way.
  const gb = bytes / 1_000_000_000;

  for (const size of NOMINAL_SIZES) {
    if (Math.abs(gb - size) / size <= SNAP_TOLERANCE) {
      return size >= 1024 ? `${Math.round(size / 1024)}TB` : `${size}GB`;
    }
  }
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)}TB` : `${Math.round(gb)}GB`;
}

/**
 * What identifies this card across sessions, or null when nothing does.
 *
 * A volume serial of all zeros is what a card carries when whatever formatted
 * it did not bother — it identifies nothing, and treating it as an identity
 * would merge every such card into one.
 */
export function fingerprint(volume: Volume): string | null {
  const serial = (volume.serial ?? "").replace(/[^0-9a-z]/gi, "").toUpperCase();
  if (serial === "" || /^0+$/.test(serial)) return null;
  return `vol:${serial}`;
}

export function describe(volume: Volume): string {
  const kind = cardKind(volume.model, volume.removable);
  const size = nominalSize(volume.totalBytes);
  return size === "" ? kind : `${kind} ${size}`;
}

/**
 * Looks a card up in the registry, adding it the first time it is seen.
 *
 * The sequence number is assigned once and kept, so the second 128GB card
 * stays "#2" rather than swapping places with the first depending on which
 * happens to be plugged in.
 */
export function identify(db: Db, volume: Volume): CardIdentity {
  const descriptor = describe(volume);
  const print = fingerprint(volume);

  if (print === null) {
    return { id: null, name: descriptor, descriptor, distinguishable: false };
  }

  const now = Date.now();
  const existing = db.getAs<{ id: number; seq: number }>(
    "SELECT id, seq FROM card WHERE fingerprint = ?",
    print,
  );

  if (existing) {
    db.prep("UPDATE card SET last_seen = ?, descriptor = ? WHERE id = ?").run(
      now,
      descriptor,
      existing.id,
    );
    return {
      id: existing.id,
      // A name set by hand in an earlier version is ignored, not shown: there
      // is no longer any way to change or clear it.
      name: label(descriptor, existing.seq),
      descriptor,
      distinguishable: true,
    };
  }

  const taken =
    db.getAs<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM card WHERE descriptor = ?", descriptor)
      ?.n ?? 0;
  const seq = taken + 1;

  const row = db
    .prep(
      `INSERT INTO card (fingerprint, descriptor, seq, name, first_seen, last_seen)
       VALUES (?, ?, ?, NULL, ?, ?) RETURNING id`,
    )
    .get(print, descriptor, seq, now, now) as { id: number };

  return { id: row.id, name: label(descriptor, seq), descriptor, distinguishable: true };
}

function label(descriptor: string, seq: number): string {
  return seq <= 1 ? descriptor : `${descriptor} #${seq}`;
}
