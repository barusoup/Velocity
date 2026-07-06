#!/usr/bin/env node
/**
 * Simulation gate for Discord Rich Presence.
 * Runs baseline, deep edge-case, fuzz, and sync-generation suites.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const result = spawnSync(
  npmCmd,
  ["run", "test:discord-presence"],
  // Includes: sync-engine.test.ts, deep-scenarios.test.ts, fuzz.test.ts, sync-generation.test.ts
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.status !== 0) {
  console.error("\nDiscord presence harness failed.");
  process.exit(result.status ?? 1);
}

console.log("\nDiscord presence harness passed all scenarios.");