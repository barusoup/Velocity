#!/usr/bin/env node
// verify-release-assets.mjs
//
// Fail-fast audit of everything Velocity ships as visual identity.
// Run before tagging a release so a broken icon state never reaches
// `tauri build` (locally OR in CI — `.github/workflows/release.yml`
// calls this on every matrix build).
//
// Exit codes: 0 = clean, 1 = at least one hard fail.
//
// Hard fails the script intentionally raises:
//   1. icon.ico has fewer than 3 ICONDIR frames (regression: single-frame ICO
//      pixelates the Windows taskbar at every size).
//   2. icon.icns is missing or doesn't start with the "icns" magic.
//   3. tauri.conf.json's bundle.icon contains "desktop-icon.png" or any path
//      whose name is the square wrapper fed to `npx tauri icon` rather than a
//      platform-format target (.ico / .icns / hicolor-spec .png).
//   4. public/icon.png or public/splash-icon.png is missing or NOT tracked by
//      git (CI runners only carry tracked files; untracked = 404 in production).
//   5. velocity-logo.png (canonical byte-preserving master) is missing on disk.
//   6. src-tauri/icons/desktop-icon.png is missing or not square.
//
// Hard fails the script explicitly does NOT raise:
//   - velocity-logo.png being untracked (it's allowed to be a working-tree-only
//     asset as long as it exists for re-derivation).
//   - non-matching `desktop-icon.png` dimensions (already covered by square check).

import { readFileSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FAIL = "\u274C FAIL";
const WARN = "\u26A0\uFE0F WARNING";
const OK = "\u2705 PASS";

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
  console.log(`${FAIL}  ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.log(`${WARN}  ${message}`);
}

function pass(label, detail) {
  console.log(`${OK}  ${label}${detail ? ` (${detail})` : ""}`);
}

// ----- 1. icon.ico multi-frame check --------------------------------------
const icoPath = path.join(ROOT, "src-tauri/icons/icon.ico");
if (!existsSync(icoPath)) {
  fail(`src-tauri/icons/icon.ico is missing`);
} else {
  try {
    const buf = readFileSync(icoPath);
    if (buf.length < 6) {
      fail(`icon.ico is too small to be a valid ICO (${buf.length} bytes)`);
    } else {
      const reserved = buf.readUInt16LE(0);
      const type = buf.readUInt16LE(2);
      const count = buf.readUInt16LE(4);
      if (reserved !== 0) {
        fail(`icon.ico ICONDIR reserved field is ${reserved}, expected 0`);
      } else if (type !== 1) {
        fail(`icon.ico type is ${type}, expected 1 (icon)`);
      } else if (count < 3) {
        fail(
          `icon.ico has only ${count} frame(s) - Windows taskbar will be ` +
            `blurry at every size. Re-run \`npx tauri icon ` +
            `src-tauri/icons/desktop-icon.png\`.`,
        );
      } else {
        // Walk each ICONDIRENTRY to confirm frame dimensions are sensible.
        const dims = [];
        let largestFirst = true;
        let prevArea = Infinity;
        for (let i = 0; i < count; i++) {
          const off = 6 + i * 16;
          const w = buf.readUInt8(off);
          const h = buf.readUInt8(off + 1);
          const bitCount = buf.readUInt16LE(off + 6);
          const fw = w || 256;
          const fh = h || 256;
          dims.push(`${fw}x${fh}@${bitCount}bpp`);
          const area = fw * fh;
          if (area > prevArea) {
            largestFirst = false;
          }
          prevArea = area;
        }
        if (!largestFirst) {
          fail(
            `icon.ico frames are not ordered largest-first (${dims.join(", ")}). ` +
              `Some Windows shortcut rendering paths use the first frame they can load ` +
              `and scale it, so the largest frame must be first. Re-run ` +
              `\`npm run regen-icons\`.`
          );
        } else {
          pass(
            `icon.ico has ${count} frames`,
            `largest-first order expected; got ${dims.join(", ")}`,
          );
        }
      }
    }
  } catch (err) {
    fail(`cannot parse icon.ico: ${err.message}`);
  }
}

// ----- 2. icon.icns magic check ------------------------------------------
const icnsPath = path.join(ROOT, "src-tauri/icons/icon.icns");
if (!existsSync(icnsPath)) {
  fail(`src-tauri/icons/icon.icns is missing`);
} else {
  const buf = readFileSync(icnsPath, { encoding: "binary" });
  const magic = buf.slice(0, 4);
  if (magic !== "icns") {
    fail(
      `icon.icns magic is "${magic}", expected "icns" - file is corrupted or ` +
        `was written by a tool other than \`npx tauri icon\``,
    );
  } else {
    pass(
      `icon.icns has correct "icns" magic`,
      `${buf.length} bytes`,
    );
  }
}

// ----- 3. tauri.conf.json bundle.icon sanity ------------------------------
const confPath = path.join(ROOT, "src-tauri/tauri.conf.json");
if (!existsSync(confPath)) {
  fail(`src-tauri/tauri.conf.json is missing`);
} else {
  let conf;
  try {
    conf = JSON.parse(readFileSync(confPath, "utf8"));
  } catch (err) {
    fail(`cannot parse tauri.conf.json: ${err.message}`);
  }
  if (conf) {
    const icons = conf?.bundle?.icon ?? [];
    if (!Array.isArray(icons) || icons.length === 0) {
      fail(`tauri.conf.json bundle.icon is missing or empty`);
    } else {
      const offenders = icons.filter((p) => /desktop-icon/.test(p));
      if (offenders.length > 0) {
        fail(
          `tauri.conf.json bundle.icon contains the wrapper assets: ` +
            `${offenders.join(", ")}. The 875x875 wrapper is the *source* ` +
            `for \`npx tauri icon\` and must NOT be bundled. Remove it.`,
        );
      } else {
        pass(
          `bundle.icon contains only platform-format targets`,
          `${icons.length} entries: ${icons.join(", ")}`,
        );
      }
    }
  }
}

// ----- 4. public/* tracking + presence ------------------------------------
for (const rel of ["public/icon.png", "public/splash-icon.png"]) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) {
    fail(`${rel} is missing on disk`);
    continue;
  }
  let tracked = false;
  try {
    execSync(`git ls-files --error-unmatch --full-name -- "${rel}"`, {
      cwd: ROOT,
      stdio: "ignore",
    });
    tracked = true;
  } catch {
    /* git returns non-zero when file isn't tracked */
  }
  if (!tracked) {
    fail(
      `${rel} exists on disk but is NOT tracked by git. CI runners only ` +
        `carry tracked files, so a release build would silently ship with ` +
        `a missing \`/${path.basename(rel)}\` and the runtime webview would ` +
        `show broken-image icons. \`git add ${rel}\` then commit.`,
    );
  } else {
    pass(`${rel} is present and tracked by git`);
  }
}

// ----- 5. canonical master existence -------------------------------------
const master = path.join(ROOT, "velocity-logo.png");
if (!existsSync(master)) {
  fail(
    `velocity-logo.png is missing. This is the byte-preserving master needed ` +
      `to re-derive the icon set after any source-of-truth change. ` +
      `See AGENTS.md -> "Design assets" for how to (re)introduce it.`,
  );
} else {
  const buf = readFileSync(master);
  pass(`velocity-logo.png canonical master present`, `${buf.length} bytes`);
  // PNG magic: 0x89 0x50 0x4E 0x47 ("\x89PNG"). If the master is ever
  // replaced with a corrupted download or a JPG renamed to .png, the
  // existence check would still pass but the icon-regen chain would
  // silently break downstream when PIL tries to parse the file.
  if (
    buf.length < 4 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    const got = [buf[0], buf[1], buf[2], buf[3]]
      .map((b) => "0x" + b.toString(16).padStart(2, "0"))
      .join(" ");
    fail(
      `velocity-logo.png is not a valid PNG (got magic bytes ${got}, ` +
        `expected 0x89 0x50 0x4e 0x47). Re-export from the original ` +
        `source as a real PNG.`,
    );
  }
}

// ----- 6. desktop-icon.png is square + present ---------------------------
const square = path.join(ROOT, "src-tauri/icons/desktop-icon.png");
if (!existsSync(square)) {
  fail(`src-tauri/icons/desktop-icon.png is missing (the square wrapper)`);
} else {
  // PNG IHDR check: bytes 16-23 = width (4B BE) + height (4B BE).
  const buf = readFileSync(square);
  if (
    buf.length < 24 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    fail(`src-tauri/icons/desktop-icon.png is not a valid PNG`);
  } else {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== h) {
      fail(
        `src-tauri/icons/desktop-icon.png is not square (${w}x${h}). The ` +
          `square wrapper fed to \`npx tauri icon\` must be square so the ` +
          `Tauri CLI doesn't center-crop or pad asymmetrically.`,
      );
    } else {
      pass(`desktop-icon.png is square`, `${w}x${h}`);
    }
  }
}

// ----- summary -----------------------------------------------------------
console.log("");
if (errors.length === 0 && warnings.length === 0) {
  console.log(`${OK}  All checks passed. Safe to tag the release.`);
  process.exit(0);
}
if (warnings.length > 0) {
  console.log(`${WARN}  ${warnings.length} non-blocking warning(s) above.`);
}
if (errors.length > 0) {
  console.log(`${FAIL}  ${errors.length} blocking error(s) above.`);
  process.exit(1);
}
process.exit(0);
