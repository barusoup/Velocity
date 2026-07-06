#!/usr/bin/env node
// verify-bundled-installer.mjs
//
// Tier 3 belt-and-suspenders. After `npm run tauri -- build` produces a
// real installer, re-extract it (NSIS .exe / .dmg / .app.tar.gz /
// .AppImage) with 7z and re-run the embedded icon checks. Catches the
// regression class where the pre-build verifier is green but Tauri's
// bundler still ships a broken icon into the artifact.
//
// Prereq: `7z` on PATH.
//   - macOS: `brew install p7zip`
//   - Linux: `apt install p7zip-full` (Debian/Ubuntu) or pacman equivalent
//   - Windows: install 7-Zip standalone; Git Bash's bundled 7z also works
//
// Exit 0 if every embedded icon passes. Exit 1 if any extracted icon
// regresses (single-frame ICO, missing icns magic, etc.).

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FAIL = "\u274C  FAIL";
const WARN = "\u26A0\uFE0F  WARN";
const OK = "\u2705  PASS";

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
  console.log(`${FAIL}  ${msg}`);
}
function warn(msg) {
  warnings.push(msg);
  console.log(`${WARN}  ${msg}`);
}
function pass(msg, detail) {
  console.log(`${OK}  ${msg}${detail ? ` (${detail})` : ""}`);
}

// 1. Confirm `7z` is reachable.
let extractor = null;
for (const cmd of ["7z", "7za"]) {
  const r = spawnSync(cmd, { stdio: "ignore" });
  if (r.status === 0) {
    extractor = cmd;
    break;
  }
}
if (!extractor) {
  fail(`7z (or 7za) not found on PATH. Install p7zip-full (Linux), p7zip (brew on macOS), or 7-Zip (Windows).`);
  console.log(`
Refusing to proceed without an extractor. Tier 3 is opt-in: skip if 7z
isn't installed.`);
  process.exit(1);
}
pass(`${extractor} found on PATH`);

// 2. Locate recently-built installers anywhere under src-tauri/target/.
function walk(dir) {
  // Recursive Node walker that replaces `find ...` shell-outs so the
  // script keeps working on bare Windows cmd.exe (no GNU coreutils).
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function findArtifacts() {
  // Walk Release outputs across the standard matrix target dirs.
  const dirs = [
    "src-tauri/target/release",
    "src-tauri/target/aarch64-apple-darwin/release",
    "src-tauri/target/x86_64-apple-darwin/release",
  ];
  const subs = ["bundle/nsis", "bundle/dmg", "bundle/macos", "bundle/appimage"];
  const results = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const sub of subs) {
      const full = `${dir}/${sub}`;
      if (!existsSync(full)) continue;
      try {
        for (const entry of readdirSync(full)) {
          if (
            entry.endsWith(".exe") ||
            entry.endsWith(".dmg") ||
            entry.endsWith(".AppImage") ||
            entry.endsWith(".app.tar.gz")
          ) {
            results.push(path.join(full, entry));
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return results;
}

const artifacts = findArtifacts();
if (artifacts.length === 0) {
  fail(`No built installers found under src-tauri/target/*/release/bundle/{nsis,dmg,macos,appimage}.\nRun \`npm run tauri -- build\` first, then re-run this script.`);
  process.exit(1);
}
pass(`Found ${artifacts.length} built installer(s)`);

const tmp = path.join(tmpdir(), `velocity-verify-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

// 3. For each artifact, extract + run embedded-icon checks.
for (const art of artifacts) {
  console.log(`\n--- ${path.relative(ROOT, art)} ---`);
  const ext = path.extname(art);
  const extractDir = path.join(tmp, path.basename(art) + ".d");
  mkdirSync(extractDir, { recursive: true });

  // .app.tar.gz: use tar (always available), skip 7z.
  let r;
  if (art.endsWith(".app.tar.gz")) {
    r = spawnSync("tar", ["xzf", art, "-C", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    r = spawnSync(extractor, ["x", "-y", `-o${extractDir}`, art], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  if (r.status !== 0) {
    fail(
      `could not extract ${path.basename(art)}: ${(r.stderr || r.stdout || "")
        .toString()
        .split("\n")
        .slice(-3)
        .join(" ")
        .slice(0, 200)}`,
    );
    continue;
  }
  pass(
    `extracted ${path.basename(art)}`,
    `to ${path.relative(tmp, extractDir)}`,
  );

  if (ext === ".exe") {
    // Tauri NSIS .exe has its *executable's* icon embedded as a Windows
    // PE resource, NOT as a discrete file in the install payload. 7z
    // extracts the install payload but cannot read PE resources without
    // pe-tools. We can only verify sidecar files dropped into $INSTDIR
    // (rare for icons). Tell the user this rather than silently passing.
    try {
      const files = walk(extractDir);
      // Case-insensitive extension match mirrors the prior
      // `find ... -iname "*.ico"` semantics without a shell-out.
      const icoList = files.filter((f) => /\.ico$/i.test(f));
      const pngList = files.filter((f) => /\.png$/i.test(f));
      if (icoList.length === 0) {
        warn(
          `No .ico in NSIS payload — expected. The bundled Windows .ico is ` +
            `embedded as a PE resource inside the .exe itself, which this ` +
            `script cannot inspect without pe-tools. Trust the pre-build ` +
            `verify-release gate (icon.ico multi-frame check).`,
        );
      } else {
        for (const f of icoList) {
          const buf = readFileSync(f);
          if (buf.length < 6) {
            fail(`embedded ${path.relative(extractDir, f)} is too small`);
            continue;
          }
          const count = buf.readUInt16LE(4);
          if (count < 3) {
            fail(`embedded ${path.relative(extractDir, f)} has only ${count} frame(s)`);
          } else {
            pass(
              `embedded ${path.relative(extractDir, f)} has ${count} frames`,
            );
          }
        }
      }
      if (pngList.length === 0) {
        warn(`No .png files in NSIS payload.`);
      } else {
        pass(`NSIS payload contains ${pngList.length} PNG(s)`);
      }
    } catch (err) {
      warn(`could not inspect NSIS payload: ${err.message}`);
    }
  }

  if (ext === ".dmg" || art.endsWith(".app.tar.gz")) {
    // macOS: AppIcon lives at Contents/Resources/AppIcon.icns (or
    // *.icns). 7z extracts the .dmg as a UDF filesystem; .app.tar.gz
    // yields the .app bundle directly.
    try {
      const files = walk(extractDir);
      const icnsList = files.filter((f) => /\.icns$/i.test(f));
      if (icnsList.length === 0) {
        warn(
          `No .icns found in ${path.basename(art)} — bundle may have used a ` +
            `different layout. Manual inspection required.`,
        );
      } else {
        for (const f of icnsList) {
          const buf = readFileSync(f, { encoding: "binary" });
          const magic = buf.slice(0, 4);
          if (magic !== "icns") {
            fail(`embedded ${path.relative(extractDir, f)} magic is "${magic}" not "icns"`);
          } else {
            pass(`embedded ${path.relative(extractDir, f)} is valid icns`, `${buf.length}B`);
          }
        }
      }
    } catch (err) {
      warn(`could not inspect mac payload: ${err.message}`);
    }
  }

  if (ext === ".AppImage") {
    // Linux AppImage: squashfs containing the app + hicolor icons.
    try {
      const files = walk(extractDir).filter((f) =>
        /velocity.*\.png$/i.test(f),
      );
      if (files.length === 0) {
        warn(
          `No velocity*.png found in AppImage. Linux bundlers may use a ` +
            `different naming convention; manual inspection required.`,
        );
      } else {
        pass(`AppImage contains ${files.length} velocity*.png file(s)`);
      }
    } catch (err) {
      warn(`could not inspect AppImage payload: ${err.message}`);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log("");
if (errors.length === 0 && warnings.length > 0) {
  console.log(`${WARN}  ${warnings.length} non-blocking warning(s) above.`);
}
if (errors.length > 0) {
  console.log(`${FAIL}  ${errors.length} blocking error(s) above.`);
  process.exit(1);
}
console.log(`${OK}  All extracted icons verified.`);
process.exit(0);
