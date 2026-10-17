import fs from "node:fs/promises";
import path from "node:path";
import { buildJpegWithExif, type ExifSpec } from "./exif-writer.ts";

/**
 * Builds a synthetic card and library pair that exercises the cases real
 * footage actually produces.
 *
 * The important one is the filename collision: both shoots contain IMG_0001
 * through IMG_0004, because cameras restart their counters. A matcher that
 * trusts filenames will happily declare the second shoot backed up when it is
 * not, so the fixtures are arranged so that mistake shows up as a failed test
 * rather than as lost work.
 */

const CAMERA = { make: "Canon", model: "Canon EOS R5", serial: "042000123456" };

export interface FixturePaths {
  root: string;
  card: string;
  main: string;
  backup: string;
}

interface Shot {
  name: string;
  spec: ExifSpec;
  size: number;
  bytes: Buffer;
}

function makeShot(name: string, captureTime: string, size: number): Shot {
  const spec: ExifSpec = {
    ...CAMERA,
    dateTimeOriginal: captureTime,
  };
  // Distinct filler per file so sizes and content hashes differ, the way real
  // exposures do.
  return { name, spec, size, bytes: buildJpegWithExif(spec, size, size % 251) };
}

async function write(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

export async function makeFixtures(baseDir: string): Promise<FixturePaths> {
  const root = path.resolve(baseDir);
  await fs.rm(root, { recursive: true, force: true });

  const card = path.join(root, "card");
  const main = path.join(root, "libraries", "main");
  const backup = path.join(root, "libraries", "backup");

  // Shoot A — six frames, 1 May.
  const shootA = Array.from({ length: 6 }, (_, i) =>
    makeShot(`IMG_000${i + 1}.JPG`, `2024:05:01 09:${String(10 + i).padStart(2, "0")}:00`, 30_000 + i * 137),
  );

  // Shoot B — four frames, 15 June, and the counter has wrapped back to 0001.
  const shootB = Array.from({ length: 4 }, (_, i) =>
    makeShot(`IMG_000${i + 1}.JPG`, `2024:06:15 17:${String(20 + i).padStart(2, "0")}:00`, 41_000 + i * 211),
  );

  for (const shot of shootA) await write(path.join(card, "DCIM", "100EOSR5", shot.name), shot.bytes);
  for (const shot of shootB) await write(path.join(card, "DCIM", "101EOSR5", shot.name), shot.bytes);

  // A sidecar and an OS artefact: neither should ever block a format.
  await write(path.join(card, "DCIM", "100EOSR5", "IMG_0001.THM"), Buffer.alloc(4096, 7));
  await write(path.join(card, "MISC", "notes.txt"), Buffer.from("ignored"));
  await write(path.join(card, "System Volume Information", "tracking.log"), Buffer.alloc(512));

  // main: shoot A copied verbatim, shoot B's first two converted to DNG *and*
  // renamed on import — the case that only capture metadata can resolve.
  for (const shot of shootA) {
    await write(path.join(main, "2024", "2024-05-01", shot.name), shot.bytes);
  }
  for (const [i, shot] of shootB.slice(0, 2).entries()) {
    const converted = buildJpegWithExif(
      { ...shot.spec, originalRawFileName: shot.name },
      shot.size + 9_000,
      99,
    );
    await write(path.join(main, "2024", "2024-06-15", `20240615_${String(i + 1).padStart(4, "0")}.dng`), converted);
  }

  // backup: shoot A's first four, plus shoot B's first two verbatim.
  for (const shot of shootA.slice(0, 4)) {
    await write(path.join(backup, "2024-05", shot.name), shot.bytes);
  }
  for (const shot of shootB.slice(0, 2)) {
    await write(path.join(backup, "2024-06", shot.name), shot.bytes);
  }

  return { root, card, main, backup };
}

/**
 * What the fixtures are designed to prove, given the rule `main and backup`.
 * Tests assert against this rather than restating the arithmetic.
 */
export const EXPECTED = {
  /** In both libraries: shoot A frames 1-4, shoot B frames 1-2. */
  satisfied: ["DCIM/100EOSR5/IMG_0001.JPG", "DCIM/100EOSR5/IMG_0002.JPG",
              "DCIM/100EOSR5/IMG_0003.JPG", "DCIM/100EOSR5/IMG_0004.JPG",
              "DCIM/101EOSR5/IMG_0001.JPG", "DCIM/101EOSR5/IMG_0002.JPG"],
  /** In main only — backup is missing them. */
  missingFromBackup: ["DCIM/100EOSR5/IMG_0005.JPG", "DCIM/100EOSR5/IMG_0006.JPG"],
  /**
   * In neither. Their filenames collide with shoot A frames that *are* backed
   * up, so a filename-trusting matcher would wrongly clear these.
   */
  missingEverywhere: ["DCIM/101EOSR5/IMG_0003.JPG", "DCIM/101EOSR5/IMG_0004.JPG"],
} as const;

if (import.meta.filename === process.argv[1]) {
  const target = process.argv[2] ?? path.join(process.cwd(), "fixtures");
  const paths = await makeFixtures(target);
  console.log(`Fixtures written to ${paths.root}`);
  console.log(`  card:    ${paths.card}`);
  console.log(`  main:    ${paths.main}`);
  console.log(`  backup:  ${paths.backup}`);
}
