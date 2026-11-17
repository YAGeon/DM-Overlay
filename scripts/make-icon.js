'use strict';

/**
 * Генерирует assets/icon.png (значок для трея и окна).
 * Запуск: npm run icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3;
const W = SIZE * SS;

const ACCENT = [88, 101, 242];
const WHITE = [255, 255, 255];

const px = new Float64Array(W * W * 4); // premultiplied RGBA, 0..1

function paint(x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  const a = alpha;
  const inv = 1 - a;
  px[i] = color[0] * a + px[i] * inv;
  px[i + 1] = color[1] * a + px[i + 1] * inv;
  px[i + 2] = color[2] * a + px[i + 2] * inv;
  px[i + 3] = a + px[i + 3] * inv;
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(px_, py_, a, b, c) {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([px_, py_], a, b);
  const d2 = sign([px_, py_], b, c);
  const d3 = sign([px_, py_], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const S = (v) => v * SS;

// фон: скруглённый квадрат
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (inRoundRect(x, y, S(6), S(6), S(250), S(250), S(58))) {
      paint(x, y, ACCENT);
    }
  }
}

// облачко сообщения
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const bubble = inRoundRect(x, y, S(50), S(74), S(206), S(168), S(30));
    const tail = inTriangle(x, y, [S(72), S(150)], [S(72), S(200)], [S(120), S(166)]);
    if (bubble || tail) paint(x, y, WHITE);
  }
}

// три точки
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (
      inCircle(x, y, S(92), S(121), S(13)) ||
      inCircle(x, y, S(128), S(121), S(13)) ||
      inCircle(x, y, S(164), S(121), S(13))
    ) {
      paint(x, y, ACCENT);
    }
  }
}

// уменьшение со сглаживанием
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
        a += px[i + 3];
      }
    }
    const n = SS * SS;
    const alpha = a / n;
    const o = (y * SIZE + x) * 4;
    if (alpha > 0.001) {
      out[o] = Math.round((r / n / alpha) * 255);
      out[o + 1] = Math.round((g / n / alpha) * 255);
      out[o + 2] = Math.round((b / n / alpha) * 255);
      out[o + 3] = Math.round(alpha * 255);
    }
  }
}

// PNG
const table = (() => {
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
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, png);
console.log('Готово:', dest, png.length, 'байт');

// ICO с PNG внутри — его использует Electron для окна, трея и сборки .exe.
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(1, 4); // count

const icoEntry = Buffer.alloc(16);
icoEntry.writeUInt8(0, 0); // width 256
icoEntry.writeUInt8(0, 1); // height 256
icoEntry.writeUInt8(0, 2); // palette
icoEntry.writeUInt8(0, 3); // reserved
icoEntry.writeUInt16LE(1, 4); // color planes
icoEntry.writeUInt16LE(32, 6); // bits per pixel
icoEntry.writeUInt32LE(png.length, 8);
icoEntry.writeUInt32LE(icoHeader.length + icoEntry.length, 12);

const icoDest = path.join(__dirname, '..', 'assets', 'icon.ico');
const ico = Buffer.concat([icoHeader, icoEntry, png]);
fs.writeFileSync(icoDest, ico);
console.log('Готово:', icoDest, ico.length, 'байт');
