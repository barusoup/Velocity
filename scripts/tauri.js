#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const delimiter = path.delimiter;
const currentPath = process.env.PATH ?? process.env.Path ?? "";
const require = createRequire(import.meta.url);

// Tauri's CLI is sensitive to stray quotes in PATH entries on Windows.
const normalizedPath = currentPath
  .split(delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => entry.replace(/^"+|"+$/g, ""))
  .join(delimiter);

const env = {
  ...process.env,
  PATH: normalizedPath,
  Path: normalizedPath,
};

const child = spawn(
  process.execPath,
  [require.resolve("@tauri-apps/cli/tauri.js"), ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
