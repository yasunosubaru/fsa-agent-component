'use strict';

/**
 * Generate the app's icon set: one PNG per size Windows asks for, plus a
 * multi-resolution .ico that carries all of them.
 *
 * Windows renders one .ico at 16, 20, 24, 32, 40, 48, 64, 256 — so the file has
 * to contain each size drawn *at that size*. Scaling a single 256px image down
 * turns the two chevrons into grey mush in the taskbar and the file list.
 *
 * The artwork is drawn here rather than checked in as a binary: a rounded slate
 * tile with two chevrons pointing right, one cool (OpenChamber) and one warm
 * (Claude Code). Every coordinate is expressed as a fraction of the side, so any
 * size comes out proportionally identical.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** The sizes Windows uses, plus 128 for high-DPI file lists. */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// ── minimal PNG encoder (RGBA, 8-bit) ──────────────────────────────────────
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing ───────────────────────────────────────────────────────────────
/**
 * Draw the tile at one size.
 *
 * Coverage is supersampled 4x4 within each pixel, which is what keeps a 16px
 * icon's diagonal edges from stair-stepping.
 */
function draw(size) {
  const S = size;
  const px = new Float32Array(S * S * 3);
  const alpha = new Float32Array(S * S);

  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
    const i = y * S + x;
    const ia = 1 - a;
    px[i * 3] = px[i * 3] * ia + r * a;
    px[i * 3 + 1] = px[i * 3 + 1] * ia + g * a;
    px[i * 3 + 2] = px[i * 3 + 2] * ia + b * a;
    alpha[i] = Math.min(1, alpha[i] + a);
  };

  /** Rounded rectangle, given in fractions of the side. */
  const roundedRect = (fx0, fy0, fx1, fy1, fRadius, color) => {
    const x0 = fx0 * S, y0 = fy0 * S, x1 = fx1 * S, y1 = fy1 * S;
    const radius = fRadius * S;
    const [r, g, b] = color;
    const sub = 4;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(S, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(S, Math.ceil(x1)); x++) {
        let hits = 0;
        for (let sy = 0; sy < sub; sy++) {
          for (let sx = 0; sx < sub; sx++) {
            const cx0 = x + (sx + 0.5) / sub;
            const cy0 = y + (sy + 0.5) / sub;
            if (cx0 < x0 || cx0 > x1 || cy0 < y0 || cy0 > y1) continue;
            const qx = Math.min(Math.max(cx0, x0 + radius), x1 - radius);
            const qy = Math.min(Math.max(cy0, y0 + radius), y1 - radius);
            const dx = cx0 - qx;
            const dy = cy0 - qy;
            if (dx * dx + dy * dy <= radius * radius) hits++;
          }
        }
        if (hits) blend(x, y, r, g, b, hits / (sub * sub));
      }
    }
  };

  /** A chevron ">" drawn as two thick segments, in fractions of the side. */
  const chevron = (fcx, fcy, fw, fh, fThickness, color) => {
    const cx = fcx * S, cy = fcy * S;
    const w = fw * S, h = fh * S;
    const reach = (fThickness * S) / 2;
    const pts = [
      [cx - w / 2, cy - h / 2],
      [cx + w / 2, cy],
      [cx - w / 2, cy + h / 2],
    ];
    const segs = [[pts[0], pts[1]], [pts[1], pts[2]]];
    const [r, g, b] = color;
    const sub = 4;
    for (let y = Math.max(0, Math.floor(cy - h)); y < Math.min(S, Math.ceil(cy + h)); y++) {
      for (let x = Math.max(0, Math.floor(cx - w)); x < Math.min(S, Math.ceil(cx + w)); x++) {
        let hits = 0;
        for (let sy = 0; sy < sub; sy++) {
          for (let sx = 0; sx < sub; sx++) {
            const fx = x + (sx + 0.5) / sub;
            const fy = y + (sy + 0.5) / sub;
            let inside = false;
            for (const [a, c] of segs) {
              const dx = c[0] - a[0];
              const dy = c[1] - a[1];
              const len2 = dx * dx + dy * dy;
              let t = len2 ? ((fx - a[0]) * dx + (fy - a[1]) * dy) / len2 : 0;
              t = Math.max(0, Math.min(1, t));
              const qx = a[0] + t * dx;
              const qy = a[1] + t * dy;
              if (Math.hypot(fx - qx, fy - qy) <= reach) { inside = true; break; }
            }
            if (inside) hits++;
          }
        }
        if (hits) blend(x, y, r, g, b, hits / (sub * sub));
      }
    }
  };

  // Tile: deep slate, generously rounded, near-inset like a macOS/Windows icon.
  roundedRect(0.039, 0.039, 0.961, 0.961, 0.203, [24, 24, 27]);

  // Two chevrons: cool for the chamber, warm for Claude.
  chevron(0.375, 0.5, 0.22, 0.29, 0.074, [96, 165, 250]);
  chevron(0.617, 0.5, 0.22, 0.29, 0.074, [222, 150, 98]);

  const out = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = Math.round(Math.min(255, px[i * 3]));
    out[i * 4 + 1] = Math.round(Math.min(255, px[i * 3 + 1]));
    out[i * 4 + 2] = Math.round(Math.min(255, px[i * 3 + 2]));
    out[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  return out;
}

// ── ICO writer ────────────────────────────────────────────────────────────
/**
 * Build an .ico from the PNGs.
 *
 * Every entry after the header is a PNG stream, which is legal for Vista and
 * later and is what keeps the 256px entry from being stored uncompressed. The
 * directory records offsets and lengths, so the file is assembled in two passes.
 */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  entries.forEach((entry, i) => {
    const base = i * 16;
    // 256 is stored as 0 in the directory; that is the format's convention.
    dir[base] = entry.size >= 256 ? 0 : entry.size;
    dir[base + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[base + 2] = 0; // palette entries
    dir[base + 3] = 0; // reserved
    dir.writeUInt16LE(1, base + 4); // colour planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(entry.data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ── write ─────────────────────────────────────────────────────────────────
function main() {
  const assets = path.resolve(__dirname, '..', 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const entries = SIZES.map((size) => ({ size, data: encodePng(size, size, draw(size)) }));

  // One canonical PNG, for BrowserWindow's `icon` on Linux and for reference.
  const whole = entries[entries.length - 1];
  fs.writeFileSync(path.join(assets, 'icon.png'), whole.data);
  console.log(`icon.png    ${whole.size}x${whole.size}  ${whole.data.length} B`);

  const ico = buildIco(entries);
  const icoPath = path.join(assets, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`icon.ico    ${SIZES.join('/')}  ${ico.length} B`);

  // The exe's own resource edit runs over this file, so its path is reported.
  console.log(`written: ${icoPath}`);
}

main();
