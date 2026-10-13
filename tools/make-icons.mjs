// Writes the extension's PNG icons from scratch — no dependencies, no binary
// assets checked into the repo. Run once after cloning:
//
//   node tools/make-icons.mjs
//
// Draws the Omnipotent mark: an ink tile, a bone aperture ring opened by a
// shutter notch at 45 degrees, and a signal-red record dot at the centre.
// brand/omnipotent-mark.svg is the master; this redraws the same construction
// with analytic anti-aliasing so it stays crisp at 16px.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 48, 128];

/* ------------------------------------------------------------------ drawing */

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Coverage of a rounded rectangle covering the whole canvas, inset by `inset`. */
function roundedRectCoverage(x, y, size, inset, radius) {
  const half = size / 2 - inset;
  const cx = size / 2;
  const dx = Math.max(Math.abs(x - cx) - (half - radius), 0);
  const dy = Math.max(Math.abs(y - cx) - (half - radius), 0);
  const dist = Math.hypot(dx, dy) - radius;
  return clamp01(0.5 - dist);
}

function circleCoverage(x, y, cx, cy, radius) {
  return clamp01(0.5 - (Math.hypot(x - cx, y - cy) - radius));
}

function ringCoverage(x, y, cx, cy, radius, width) {
  const dist = Math.abs(Math.hypot(x - cx, y - cy) - radius);
  return clamp01(0.5 - (dist - width / 2));
}

/** Smallest absolute angle between two directions, in radians. */
function angleGap(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/**
 * The ring, with a radial slice removed — the shutter notch.
 * The cut is feathered by roughly one pixel of arc so the ends stay clean at
 * 16px instead of turning into stair-steps.
 */
function notchedRingCoverage(x, y, cx, cy, radius, width, notchAt, notchHalf) {
  const ring = ringCoverage(x, y, cx, cy, radius, width);
  if (ring <= 0) return 0;
  const gap = angleGap(Math.atan2(cy - y, x - cx), notchAt);
  const feather = Math.min(notchHalf, 1.1 / radius);
  return ring * clamp01((gap - (notchHalf - feather)) / feather);
}

/* --------------------------------------------------------------- brand marks */

const INK = [16, 16, 20]; // #101014
const BONE = [244, 241, 234]; // #f4f1ea
const SIGNAL = [192, 57, 43]; // #c0392b

/** Standard "source over" composite onto a premultiplied-free RGBA tuple. */
function over(dst, color, alpha) {
  const a = alpha;
  if (a <= 0) return dst;
  const outA = a + dst[3] * (1 - a);
  if (outA === 0) return [0, 0, 0, 0];
  const blend = (i) => (color[i] * a + dst[i] * dst[3] * (1 - a)) / outA;
  return [blend(0), blend(1), blend(2), outA];
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = size / 2;

  // Fractions of the canvas, matching brand/omnipotent-mark.svg on its 64 grid.
  const tileRadius = size * 0.24;
  const tileInset = size * 0.019;
  const ringRadius = size * 0.3156; // 20.2 / 64
  const ringWidth = Math.max(1.15, size * 0.1047); // 6.7 / 64
  const dotRadius = size * 0.1453; // 9.3 / 64
  const notchAt = Math.PI / 4; // upper right
  const notchHalf = (13 * Math.PI) / 180;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      let rgba = [0, 0, 0, 0];
      rgba = over(rgba, INK, roundedRectCoverage(px, py, size, tileInset, tileRadius));
      rgba = over(
        rgba,
        BONE,
        notchedRingCoverage(px, py, centre, centre, ringRadius, ringWidth, notchAt, notchHalf),
      );
      rgba = over(rgba, SIGNAL, circleCoverage(px, py, centre, centre, dotRadius));

      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(rgba[0]);
      pixels[offset + 1] = Math.round(rgba[1]);
      pixels[offset + 2] = Math.round(rgba[2]);
      pixels[offset + 3] = Math.round(rgba[3] * 255);
    }
  }
  return pixels;
}

/* --------------------------------------------------------------- PNG writer */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- main */

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, renderIcon(size)));
  console.log(`wrote ${file}`);
}
