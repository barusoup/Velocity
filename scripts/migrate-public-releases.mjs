#!/usr/bin/env node
/**
 * Copy GitHub Releases (and assets) from barusoup/Velocity-Public into
 * barusoup/Velocity. Requires GH_TOKEN or `gh auth login`.
 *
 * Skips tags that already exist on the destination repo.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = "barusoup/Velocity-Public";
const DEST = "barusoup/Velocity";
const TAGS = ["v0.0.0", "v0.0.1", "v0.0.2", "v0.1.0", "v0.1.1"];

function gh(args, { input } = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

function ghJson(args, fields) {
  return JSON.parse(gh([...args, "--json", fields]));
}

function destHasRelease(tag) {
  try {
    gh(["release", "view", tag, "--repo", DEST]);
    return true;
  } catch {
    return false;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "velocity-migrate-"));

try {
  for (const tag of TAGS) {
    if (destHasRelease(tag)) {
      console.log(`skip ${tag} — already on ${DEST}`);
      continue;
    }

    console.log(`migrate ${tag}...`);
    const release = ghJson(
      ["release", "view", tag, "--repo", SOURCE],
      "tagName,name,body,isPrerelease,assets",
    );

    const notesPath = join(tmp, `${tag}-notes.md`);
    writeFileSync(notesPath, release.body || release.name || tag, "utf8");

    const assetDir = join(tmp, tag);
    mkdirSync(assetDir, { recursive: true });

    for (const asset of release.assets) {
      const out = join(assetDir, asset.name);
      console.log(`  download ${asset.name}`);
      execFileSync(
        "gh",
        [
          "release",
          "download",
          tag,
          "--repo",
          SOURCE,
          "--pattern",
          asset.name,
          "--dir",
          assetDir,
        ],
        { stdio: "inherit" },
      );
    }

    const createArgs = [
      "release",
      "create",
      tag,
      "--repo",
      DEST,
      "--title",
      release.name,
      "--notes-file",
      notesPath,
    ];
    if (release.isPrerelease) createArgs.push("--prerelease");

    const files = release.assets.map((a) => join(assetDir, a.name));
    gh([...createArgs, ...files]);

    console.log(`done ${tag}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("Migration complete.");