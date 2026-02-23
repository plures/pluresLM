#!/usr/bin/env node
/**
 * Copies built-in YAML pattern files from src/patterns/ to dist/patterns/
 * after tsc compilation (so they are included in the published package).
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "src", "patterns");
const dest = join(__dirname, "..", "dist", "patterns");

if (!existsSync(src)) {
  console.warn(`[copy-patterns] src dir not found: ${src}`);
  process.exit(0);
}

if (!existsSync(dest)) {
  mkdirSync(dest, { recursive: true });
}

const files = readdirSync(src).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
for (const file of files) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log(`[copy-patterns] Copied ${files.length} pattern file(s) to ${dest}`);
