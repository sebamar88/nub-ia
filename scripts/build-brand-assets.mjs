#!/usr/bin/env node
// Generates themes/<brand.name>.json from brand.json.
//
// Run with type stripping so lib/*.ts can be imported:
//   node --experimental-strip-types scripts/build-brand-assets.mjs --write|--check [--themes-dir <dir>]
//
// The committed themes/Nub-IA.json is the versioned template the theme is
// derived from; with the default brand the output equals it byte for byte.
// Deleting a stale generated theme after a rename is not implemented yet: it
// needs assets/brand/.applied.json, which a later task creates.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../lib/brand.ts";
import { deriveTheme } from "../lib/brand-colors.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(root, "themes", "Nub-IA.json");

const args = process.argv.slice(2);
const mode = args[0];
const dirFlag = args.indexOf("--themes-dir");
const themesDir = dirFlag >= 0 ? args[dirFlag + 1] : join(root, "themes");
if ((mode !== "--write" && mode !== "--check") || (dirFlag >= 0 && !themesDir)) {
	console.error("usage: build-brand-assets.mjs --write|--check [--themes-dir <dir>]");
	process.exit(2);
}

const expected = `${JSON.stringify(deriveTheme(JSON.parse(readFileSync(TEMPLATE, "utf8")), brand), null, 2)}\n`;
const target = join(themesDir, `${brand.name}.json`);

if (mode === "--write") {
	mkdirSync(themesDir, { recursive: true });
	writeFileSync(target, expected);
} else if (!existsSync(target) || readFileSync(target, "utf8") !== expected) {
	console.error(`${target} is missing or out of date. Run: pnpm run build:brand`);
	process.exit(1);
}
