import { createHash } from "node:crypto";
import fs from "node:fs/promises";

/**
 * Two hashes, deliberately.
 *
 * `quickHash` reads 64 KiB from each end plus the length. For camera files that
 * is conclusive in practice — two distinct exposures never share a size *and*
 * both ends — while costing 128 KiB instead of the 45 MB a raw file would.
 * `fullHash` exists for the paranoid path and for the "prove it before I wipe
 * the only copy" case.
 */

const EDGE_BYTES = 64 * 1024;

export async function quickHash(file: string, size: number): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`${size}:`);

  const fh = await fs.open(file, "r");
  try {
    if (size <= EDGE_BYTES * 2) {
      const buf = Buffer.alloc(size);
      if (size > 0) await fh.read(buf, 0, size, 0);
      hash.update(buf);
    } else {
      const head = Buffer.alloc(EDGE_BYTES);
      await fh.read(head, 0, EDGE_BYTES, 0);
      hash.update(head);

      const tail = Buffer.alloc(EDGE_BYTES);
      await fh.read(tail, 0, EDGE_BYTES, size - EDGE_BYTES);
      hash.update(tail);
    }
  } finally {
    await fh.close();
  }

  return hash.digest("hex");
}

export async function fullHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

/** Never throws — a hash we couldn't compute just means one less signal. */
export async function tryQuickHash(file: string, size: number): Promise<string | null> {
  try {
    return await quickHash(file, size);
  } catch {
    return null;
  }
}

export async function tryFullHash(file: string): Promise<string | null> {
  try {
    return await fullHash(file);
  } catch {
    return null;
  }
}
