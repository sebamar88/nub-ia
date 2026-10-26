#!/usr/bin/env node
// Generates themes/<brand.name>.json from brand.json.
//
// Run with type stripping so lib/*.ts can be imported:
//   node --experimental-strip-types scripts/build-brand-assets.mjs --write|--check [--themes-dir <dir>]
//
// assets/brand/theme-template.json is the versioned template the theme is
// derived from; with the default brand the output equals it byte for byte.
// Deleting a stale generated theme after a rename is done by scripts/rebrand.mjs
// (it knows the previous name from assets/brand/.applied.json).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../lib/brand.ts";
import { deriveTheme } from "../lib/brand-colors.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(root, "assets", "brand", "theme-template.json");

const args = process.argv.slice(2);
const mode = args[0];
const dirFlag = args.indexOf("--themes-dir");
const themesDir = dirFlag >= 0 ? args[dirFlag + 1] : join(root, "themes");
if ((mode !== "--write" && mode !== "--check") || (dirFlag >= 0 && !themesDir)) {
	console.error("usage: build-brand-assets.mjs --write|--check [--themes-dir <dir>]");
	process.exit(2);
}

const expected = `${JSON.stringify(deriveTheme(JSON.parse(readFileSync(TEMPLATE, "utf8")), brand), null, 2)}\n`;
const themeFile = `${brand.name}.json`;
if (basename(themeFile) !== themeFile) {
	console.error(`brand.name ${JSON.stringify(brand.name)} is not usable as a file name`);
	process.exit(2);
}
const target = join(themesDir, themeFile);

if (mode === "--write") {
	mkdirSync(themesDir, { recursive: true });
	writeFileSync(target, expected);
} else if (!existsSync(target) || readFileSync(target, "utf8") !== expected) {
	console.error(`${target} is missing or out of date. Run: pnpm run build:brand`);
	process.exit(1);
}
