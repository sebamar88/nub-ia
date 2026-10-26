#!/usr/bin/env node
// Regenerates the startup-banner artwork for the Nubiral PNGs in assets/brand/.
// Needs Python 3 with Pillow. New brands use `pnpm run rebrand` instead (alpha-channel tracing).
//
//   node scripts/trace-brand.mjs isologo [rows=7]   → ROSE_LARGE_RAW (braille, from nubiral-isologo.png)
//   node scripts/trace-brand.mjs wordmark [rows=7]  → TEXT_LOGO (quadrant blocks, from the black text in nubiral-logo.png)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { traceLogo } from "./brand-trace.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const what = process.argv[2];
const rows = Number(process.argv[3] ?? 7);
if (what !== "isologo" && what !== "wordmark") {
	console.error("usage: node scripts/trace-brand.mjs <isologo|wordmark> [rows]");
	process.exit(2);
}
const file = what === "isologo" ? "nubiral-isologo.png" : "nubiral-logo.png";
const constant = what === "isologo" ? "ROSE_LARGE_RAW" : "TEXT_LOGO";
// isologo: the lime mark; wordmark: the black letters only (the PNG also carries the mark).
let lines;
try {
	lines = traceLogo({ file: join(root, "assets", "brand", file), kind: what, rows, predicate: `nubiral-${what}` });
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
console.log(`const ${constant} = [`);
for (const l of lines) console.log(`  "${l}",`);
console.log("];");
