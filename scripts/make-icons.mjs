// Turns the 16x16 pixel logo (src/assets/logo.svg, one <rect> per patch of colour) into the icon files the app
// and its installer use. Every size is a whole multiple of 16, so each logo pixel stays a sharp square.
// Run after changing the logo: node scripts/make-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const GRID = 16;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/** The logo's 16x16 pixels as RGBA, painted rect by rect in file order. */
function rasterize(svg) {
    const pixels = new Uint8Array(GRID * GRID * 4);
    for (const [, attrs] of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
        const num = (name, fallback) => {
            const m = attrs.match(new RegExp(`\\b${name}="([^"]+)"`));
            return m ? Number(m[1]) : fallback;
        };
        const fill = attrs.match(/\bfill="#([0-9a-fA-F]{6})"/);
        if (!fill) throw new Error(`a rect without a #rrggbb fill: ${attrs}`);
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(fill[1].slice(i, i + 2), 16));
        const x0 = num('x', 0);
        const y0 = num('y', 0);
        const w = num('width', 0);
        const h = num('height', 0);
        for (let y = y0; y < y0 + h; y++) {
            for (let x = x0; x < x0 + w; x++) {
                const i = (y * GRID + x) * 4;
                pixels.set([r, g, b, 255], i);
            }
        }
    }
    return pixels;
}

/** Nearest-neighbour scaling by a whole factor. */
function scale(pixels, size) {
    const factor = size / GRID;
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const from = (Math.floor(y / factor) * GRID + Math.floor(x / factor)) * 4;
            out.set(pixels.subarray(from, from + 4), (y * size + x) * 4);
        }
    }
    return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A plain RGBA PNG: every row starts with filter byte 0. */
function png(size, rgba) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 6, 0, 0, 0], 8);                        // 8-bit RGBA, no interlace
    const rows = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        rows[y * (size * 4 + 1)] = 0;
        rows.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** An .ico holding one PNG per size (Windows reads PNG entries since Vista). */
function ico(images) {
    const head = Buffer.alloc(6 + images.length * 16);
    head.writeUInt16LE(0, 0);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(images.length, 4);
    let offset = head.length;
    images.forEach(({ size, data }, i) => {
        const at = 6 + i * 16;
        head.writeUInt8(size >= 256 ? 0 : size, at);
        head.writeUInt8(size >= 256 ? 0 : size, at + 1);
        head.writeUInt8(0, at + 2);
        head.writeUInt8(0, at + 3);
        head.writeUInt16LE(1, at + 4);
        head.writeUInt16LE(32, at + 6);
        head.writeUInt32LE(data.length, at + 8);
        head.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });
    return Buffer.concat([head, ...images.map((image) => image.data)]);
}

const pixels = rasterize(readFileSync(new URL('../src/assets/logo.svg', import.meta.url), 'utf8'));
const pngOf = (size) => png(size, scale(pixels, size));
writeFileSync(new URL('../public/launcher.ico', import.meta.url), ico(ICO_SIZES.map((size) => ({ size, data: pngOf(size) }))));
writeFileSync(new URL('../public/icon-16x16.png', import.meta.url), pngOf(16));
writeFileSync(new URL('../public/icon-16x16@2x.png', import.meta.url), pngOf(32));   // the tray on scaled displays
writeFileSync(new URL('../public/icon.png', import.meta.url), pngOf(256));
console.log(`icons written: launcher.ico (${ICO_SIZES.join(', ')}), icon-16x16.png (+@2x), icon.png`);
