#!/usr/bin/env node
// reorder-ico-frames.mjs
//
// Reorders the frames in src-tauri/icons/icon.ico so the largest frame comes
// first. Some Windows code paths (including desktop shortcut rendering on
// certain DPI / icon-size combinations) appear to pick the first frame they
// can load and scale it, rather than doing proper size-aware selection. By
// putting the 256x256 frame first, those paths downscale from the highest
// resolution instead of upscaling a 32x32 frame.
//
// Run this after `npx tauri icon src-tauri/icons/desktop-icon.png`.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICO_PATH = path.join(ROOT, "src-tauri", "icons", "icon.ico");

const buf = readFileSync(ICO_PATH);
if (buf.length < 6) {
  console.error("icon.ico is too small to be valid");
  process.exit(1);
}

const reserved = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);

if (reserved !== 0 || type !== 1 || count < 1) {
  console.error("icon.ico header is invalid");
  process.exit(1);
}

const frames = [];
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16;
  const w = buf.readUInt8(off);
  const h = buf.readUInt8(off + 1);
  const colors = buf.readUInt8(off + 2);
  const reservedByte = buf.readUInt8(off + 3);
  const planes = buf.readUInt16LE(off + 4);
  const bpp = buf.readUInt16LE(off + 6);
  const size = buf.readUInt32LE(off + 8);
  const offset = buf.readUInt32LE(off + 12);
  frames.push({
    width: w === 0 ? 256 : w,
    height: h === 0 ? 256 : h,
    colors,
    reservedByte,
    planes,
    bpp,
    size,
    payload: Buffer.from(buf.subarray(offset, offset + size)),
  });
}

// Sort by area descending (largest first).
frames.sort((a, b) => b.width * b.height - a.width * a.height);

const newHeader = Buffer.alloc(6);
newHeader.writeUInt16LE(0, 0); // reserved
newHeader.writeUInt16LE(1, 2); // type
newHeader.writeUInt16LE(count, 4);

const newEntries = Buffer.alloc(count * 16);
let payloadOffset = 6 + count * 16;
for (let i = 0; i < count; i++) {
  const f = frames[i];
  const off = i * 16;
  newEntries.writeUInt8(f.width === 256 ? 0 : f.width, off);
  newEntries.writeUInt8(f.height === 256 ? 0 : f.height, off + 1);
  newEntries.writeUInt8(f.colors, off + 2);
  newEntries.writeUInt8(f.reservedByte, off + 3);
  newEntries.writeUInt16LE(f.planes, off + 4);
  newEntries.writeUInt16LE(f.bpp, off + 6);
  newEntries.writeUInt32LE(f.payload.length, off + 8);
  newEntries.writeUInt32LE(payloadOffset, off + 12);
  payloadOffset += f.payload.length;
}

const newIco = Buffer.concat([newHeader, newEntries, ...frames.map((f) => f.payload)]);
writeFileSync(ICO_PATH, newIco);

const order = frames.map((f) => `${f.width}x${f.height}`).join(", ");
console.log(`Reordered icon.ico frames (largest first): ${order}`);
