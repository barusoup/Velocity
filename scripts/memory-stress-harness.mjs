#!/usr/bin/env node
/**
 * Long-running memory / performance stress gate for Velocity.
 * Runs vitest memory-stress suite with GC exposed for heap measurements.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const result = spawnSync(
  npxCmd,
  [
    "vitest",
    "run",
    "src/memory-stress.test.ts",
    "--pool=threads",
    "--poolOptions.threads.singleThread=true",
  ],
  {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        "--expose-gc",
      ]
        .filter(Boolean)
        .join(" "),
    },
  },
);

if (result.status !== 0) {
  console.error("\nMemory stress harness failed.");
  process.exit(result.status ?? 1);
}

console.log("\nMemory stress harness passed all scenarios.");