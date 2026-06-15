'use strict';
// Generates all 8 PWA icon sizes using only Node.js core modules (no npm deps).
// Run from project root: node scripts/generate-icons.js

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC-32 for PNG chunks ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tBuf = Buffer.from(type, 'ascii');
  const len  = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const crc  = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([tBuf, data])), 0);
  return Buffer.concat([len, tBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  // Prepend filter byte (0 = None) to each scanline
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon drawing (no external deps) ─────────────────────────────────────────
// Green (#22c55e) circle background + white teardrop leaf in centre
const GREEN = [34, 197, 94];

function isInCircle(dx, dy, r) { return dx * dx + dy * dy <= r * r; }

// Teardrop: circular bottom half + pointed top half
function isInTeardrop(nx, ny) {
  // nx, ny are normalised to [-1, 1] relative to icon centre
  // Circle portion (lower): centre at (0, +0.12), radius 0.44
  if (isInCircle(nx, ny - 0.12, 0.44)) return true;
  // Triangle portion (upper): tip at (0, -0.70), base matches circle top at ny ≈ -0.32
  if (ny >= -0.70 && ny < -0.32) {
    const t = (ny + 0.70) / (0.38); // 0 at tip, 1 at base
    return Math.abs(nx) <= 0.44 * t;
  }
  return false;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4); // all transparent
  const cx = size / 2;
  const cy = size / 2;
  const bgR = size / 2 - 0.5;
  const SUBS = 4; // 4×4 supersampling for clean edges

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, leafHits = 0;

      for (let sy = 0; sy < SUBS; sy++) {
        for (let sx = 0; sx < SUBS; sx++) {
          const x = px + (sx + 0.5) / SUBS;
          const y = py + (sy + 0.5) / SUBS;
          const dx = x - cx, dy = y - cy;

          if (isInCircle(dx, dy, bgR)) bgHits++;

          // Normalise to [-1, 1] for teardrop test
          const nx = dx / (size * 0.5);
          const ny = dy / (size * 0.5);
          if (isInTeardrop(nx, ny)) leafHits++;
        }
      }

      if (bgHits === 0) continue;

      const total = SUBS * SUBS;
      const bgA   = bgHits   / total;
      const leafA = leafHits / total;
      const i = (py * size + px) * 4;

      // Composite white leaf over green background
      rgba[i]   = Math.round(255 * leafA + GREEN[0] * (1 - leafA));
      rgba[i+1] = Math.round(255 * leafA + GREEN[1] * (1 - leafA));
      rgba[i+2] = Math.round(255 * leafA + GREEN[2] * (1 - leafA));
      rgba[i+3] = Math.round(bgA * 255);
    }
  }

  return rgba;
}

// ── Generate ─────────────────────────────────────────────────────────────────
const SIZES  = [72, 96, 128, 144, 152, 192, 384, 512];
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const rgba    = drawIcon(size);
  const png     = encodePNG(size, rgba);
  const outPath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✓  icon-${size}.png  (${(png.length / 1024).toFixed(1)} KB)`);
}

console.log(`\nAll ${SIZES.length} icons saved → public/icons/`);
