#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import fs from "node:fs/promises";
import exifr from "exifr";

import { findEmbeddedJpegs } from "../src/core/preview.ts";
import { extOf } from "../src/core/paths.ts";

/**
 * What preview, if any, is actually inside a file.
 *
 * Raw formats put their preview in different places — IFD1, a SubIFD, the
 * maker note — and which one a given camera uses is not something to guess at.
 * Point this at a real file and it reports every JPEG it can find and where it
 * came from, so a missing thumbnail becomes a fact rather than a theory.
 *
 *   node tools/preview-probe.ts "D:/DCIM/100MSDCF/DSC00001.ARW"
 */

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node tools/preview-probe.ts <file> [file...]");
  process.exit(2);
}

for (const file of files) {
  console.log(`\n=== ${file}`);
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch (err) {
    console.log(`  cannot open: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB`);

  try {
    const thumb = (await exifr.thumbnail(file)) as Uint8Array | undefined;
    console.log(`  exifr.thumbnail(): ${thumb ? `${thumb.length} bytes` : "nothing"}`);
  } catch (err) {
    console.log(`  exifr.thumbnail(): threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  const handle = await fs.open(file, "r");
  try {
    const found = await findEmbeddedJpegs(handle, size, extOf(file));
    if (found.length === 0) {
      console.log("  embedded JPEGs: none found");
    } else {
      console.log(`  embedded JPEGs: ${found.length}`);
      for (const c of found) {
        console.log(
          `    ${c.source.padEnd(22)} offset ${String(c.offset).padStart(10)}  ${(c.length / 1024).toFixed(0).padStart(6)} KB`,
        );
      }
    }
  } catch (err) {
    console.log(`  scan failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await handle.close();
  }
}
