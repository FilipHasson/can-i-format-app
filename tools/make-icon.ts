/**
 * Draws the application icon.
 *
 * A packaged app with Electron's own icon on it is not packaged, it is a demo,
 * and the alternative to drawing one here is committing a binary nobody can
 * diff or regenerate. The project already synthesises its JPEG fixtures rather
 * than checking them in (`tools/exif-writer.ts`), so the icon is made the same
 * way: geometry in code, a rasteriser, a PNG encoder, and an ICO container.
 *
 *   node tools/make-icon.ts build/icon.ico   # every size Windows asks for
 *   node tools/make-icon.ts build/icon.png   # one 256px sheet
 *
 * The mark is the floppy disk the page already uses as its brand, in the
 * accent blue from `web/style.css`, so the taskbar and the header agree.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Every shape is tested per sub-sample and is either in or out, so no shape
 * needs to compute coverage itself; averaging the block afterwards is what
 * produces the smooth edge. Four is the point where more stops showing.
 */
const SS = 4;

/** The sizes Windows picks between: taskbar, alt-tab, Explorer, and the tile. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

type Rgb = readonly [number, number, number];

const INK: Record<string, Rgb> = {
  // --accent, --surface, --border, --text-faint from web/style.css.
  blue: [0x2a, 0x6d, 0xf4],
  deep: [0x1b, 0x4c, 0xb8],
  white: [0xff, 0xff, 0xff],
  panel: [0xdf, 0xe3, 0xe8],
  steel: [0x8a, 0x94, 0xa0],
  slate: [0x5c, 0x67, 0x73],
};

/** A shape answers one question: is this point inside me? */
type Shape = (x: number, y: number) => boolean;

/** Coordinates are 0..1 across the icon, so one drawing serves every size. */
function roundRect(x0: number, y0: number, x1: number, y1: number, r: number): Shape {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    // Outside the corner boxes the rectangle test is the whole answer; inside
    // one, the distance to that corner's centre is.
    const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
}

function polygon(points: ReadonlyArray<readonly [number, number]>): Shape {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i] as [number, number];
      const [xj, yj] = points[j] as [number, number];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

class Sheet {
  readonly size: number;
  readonly #w: number;
  /** Straight RGBA at sub-sample resolution; alpha is only ever 0 or 255. */
  readonly #px: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.#w = size * SS;
    this.#px = new Uint8Array(this.#w * this.#w * 4);
  }

  fill(shape: Shape, colour: Rgb): void {
    const [r, g, b] = colour;
    for (let py = 0; py < this.#w; py++) {
      // The sub-sample's centre, not its corner: sampling the corner shifts
      // the whole drawing half a sub-pixel up and left.
      const y = (py + 0.5) / this.#w;
      for (let px = 0; px < this.#w; px++) {
        const x = (px + 0.5) / this.#w;
        if (!shape(x, y)) continue;
        const at = (py * this.#w + px) * 4;
        this.#px[at] = r;
        this.#px[at + 1] = g;
        this.#px[at + 2] = b;
        this.#px[at + 3] = 255;
      }
    }
  }

  /**
   * Averages each block in premultiplied space. Averaging straight colour
   * would blend the transparent pixels' black into the edge and ring the
   * rounded corners in grey.
   */
  resolve(): Uint8Array {
    const out = new Uint8Array(this.size * this.size * 4);
    const n = SS * SS;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const at = ((y * SS + sy) * this.#w + (x * SS + sx)) * 4;
            const alpha = this.#px[at + 3] as number;
            if (alpha === 0) continue;
            r += this.#px[at] as number;
            g += this.#px[at + 1] as number;
            b += this.#px[at + 2] as number;
            a += alpha;
          }
        }
        const at = (y * this.size + x) * 4;
        if (a === 0) continue;
        const covered = a / 255;
        out[at] = Math.round(r / covered);
        out[at + 1] = Math.round(g / covered);
        out[at + 2] = Math.round(b / covered);
        out[at + 3] = Math.round(a / n);
      }
    }
    return out;
  }
}

/**
 * The floppy, drawn once in fractions of the icon.
 *
 * It is the save icon's proportions rather than a real disk's: shutter high
 * and right of centre, label filling the bottom and running into the edge.
 * A corner notch was tried and cut for reading as a folded sheet of paper —
 * at 32px the thing has to be recognised, not examined.
 */
function drawIcon(size: number): Uint8Array {
  const sheet = new Sheet(size);
  sheet.fill(roundRect(0, 0, 1, 1, 0.22), INK.blue as Rgb);

  // A darker disk under the body, a shade larger. White on blue is already
  // stark; this gives the edge somewhere to land at the sizes where a
  // one-pixel outline would be swallowed by the anti-aliasing.
  sheet.fill(roundRect(0.165, 0.145, 0.835, 0.855, 0.045), INK.deep as Rgb);
  sheet.fill(roundRect(0.18, 0.16, 0.82, 0.84, 0.035), INK.white as Rgb);

  // Shutter: metal plate at the top with its window, the part of a disk that
  // is nothing else's shape.
  sheet.fill(roundRect(0.31, 0.16, 0.57, 0.395, 0.012), INK.steel as Rgb);
  sheet.fill(roundRect(0.455, 0.19, 0.525, 0.365, 0.008), INK.white as Rgb);

  // Label: to the bottom edge, the way the save icon has always drawn it.
  sheet.fill(roundRect(0.27, 0.50, 0.73, 0.84, 0.02), INK.panel as Rgb);
  if (size >= 32) {
    for (const y of [0.575, 0.65]) {
      sheet.fill(roundRect(0.32, y, 0.68, y + 0.038, 0.019), INK.slate as Rgb);
    }
    sheet.fill(roundRect(0.32, 0.725, 0.55, 0.763, 0.019), INK.steel as Rgb);
  }

  return sheet.resolve();
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(rgba: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // compression, filter and interlace all have exactly one legal value.

  // Filter byte 0 on every row. A predictor would compress better; these are
  // flat colours, so deflate has little left to find and the encoder stays
  // short enough to read.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

// ---------------------------------------------------------------- ICO

/**
 * Every entry is a PNG rather than a DIB. Windows has read PNG-compressed
 * icon entries since Vista, and the alternative is a bottom-up bitmap with a
 * padded AND mask that nothing needs any more.
 */
function encodeIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const at = i * 16;
    // 256 does not fit in a byte and is written as 0, which is the format
    // saying "the PNG knows".
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

// ---------------------------------------------------------------- main

const target = process.argv[2] ?? "build/icon.ico";
fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });

if (target.toLowerCase().endsWith(".png")) {
  const size = Number(process.argv[3] ?? 256);
  fs.writeFileSync(target, encodePng(drawIcon(size), size));
  console.log(`${target}  ${size}×${size}`);
} else {
  const images = ICO_SIZES.map((size) => ({ size, png: encodePng(drawIcon(size), size) }));
  const ico = encodeIco(images);
  fs.writeFileSync(target, ico);
  console.log(`${target}  ${ICO_SIZES.join(", ")}  ${(ico.length / 1024).toFixed(1)}KB`);
}
