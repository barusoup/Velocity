#!/usr/bin/env node
// scripts/build-clean.mjs
//
// Pre-build cleanup step used by `npm run build` to wipe the previous
// vite output before regenerating it. Without this, deleting a public
// asset can leave a stale `dist/` from a previous build that masks the
// deletion on the dev machine: the local npm run build silently ships a
// different `dist/` than CI's clean checkout would. CI is unaffected
// (actions/checkout@v4 starts from a clean working tree per matrix run),
// but the developer is the one who first sees the regression.

import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
console.log("cleaned dist/");
