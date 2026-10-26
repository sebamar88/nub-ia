#!/usr/bin/env node
// Applies brand.json (or $NUB_IA_BRAND_FILE) to the checkout.
//
//   pnpm run rebrand -- [--wordmark <png>] [--isologo <png>]
//   node --experimental-strip-types scripts/rebrand.mjs --check   (writes nothing; exit 1 if the checkout is out of date)
//
// New logos: PNG with a transparent background, traced by alpha (a > 128).
// Steps: trace PNGs -> banner-art.json, copy PNGs to brand.logos, regenerate
// the theme (and delete the previous one), rewrite the slash-command prefix in
// the two workflow SKILL.md files, rewrite package.json "bin", record state in
// assets/brand/.applied.json. Idempotent; with the default brand and no flags
// it changes nothing. Requires Python 3 + Pillow only when PNGs are given.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_WORDMARK_WIDTH, brand } from "../lib/brand.ts";
import { letterWeights, traceLogo } from "./brand-trace.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = ["skills/nubia-spec-design-tasks/SKILL.md", "skills/nubia-svsd-spec/SKILL.md"];
const APPLIED = join(root, "assets", "brand", ".applied.json");

const args = process.argv.slice(2).filter((a) => a !== "--");
const check = args.length === 1 && args[0] === "--check";
const flags = {};
for (let i = 0; !check && i < args.length; i += 2) {
	const key = args[i];
	if ((key !== "--wordmark" && key !== "--isologo") || !args[i + 1]) {
		console.error("usage: rebrand.mjs [--wordmark <png>] [--isologo <png>] | --check");
		process.exit(2);
	}
	flags[key.slice(2)] = resolve(args[i + 1]);
}

function writeIfChanged(file, text) {
	if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
}

const applied = existsSync(APPLIED) ? JSON.parse(readFileSync(APPLIED, "utf8")) : { prefix: "nubia", themeFile: "Nub-IA.json" };
const themeFile = `${brand.name}.json`;
// .applied.json is state on disk: never let a tampered file name escape themes/.
if (basename(applied.themeFile) !== applied.themeFile || basename(themeFile) !== themeFile) {
	console.error(`rebrand: refusing unsafe theme file name (${JSON.stringify(applied.themeFile)} -> ${JSON.stringify(themeFile)})`);
	process.exit(2);
}

// Text files rebrand derives from brand.json: [absolute path, expected content].
function derivedFiles() {
	const out = [];
	const escaped = applied.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const prefixRe = new RegExp(`(?<![\\w/])/${escaped}:`, "g");
	for (const rel of SKILLS) out.push([join(root, rel), readFileSync(join(root, rel), "utf8").replace(prefixRe, `/${brand.prefix}:`)]);
	// package.json: replace only the "bin" block to keep the file's formatting.
	const pkgFile = join(root, "package.json");
	const binRe = /("bin": \{\n)[^}]*(\n\t\})/;
	const pkg = readFileSync(pkgFile, "utf8");
	if (!binRe.test(pkg)) throw new Error('rebrand: package.json has no tab-indented multi-line "bin": { ... } block to rewrite');
	out.push([pkgFile, pkg.replace(binRe, `$1\t\t${JSON.stringify(brand.bin)}: "bin/nub-ia.mjs"$2`)]);
	out.push([APPLIED, `${JSON.stringify({ prefix: brand.prefix, themeFile }, null, 2)}\n`]);
	return out;
}

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const artFile = join(root, brand.artwork);

if (check) {
	const problems = [];
	try {
		const art = JSON.parse(readFileSync(artFile, "utf8"));
		if (!isStrings(art.wordmark) || !isStrings(art.isologo) || !Array.isArray(art.letterWeights) || !art.letterWeights.every((n) => typeof n === "number")) {
			problems.push(`${brand.artwork} must contain wordmark: string[], isologo: string[], letterWeights: number[]`);
		}
	} catch (error) {
		problems.push(`${brand.artwork} (brand.artwork) is missing or not valid JSON: ${error.message}`);
	}
	for (const [file, text] of derivedFiles()) {
		if (!existsSync(file) || readFileSync(file, "utf8") !== text) problems.push(`${file.slice(root.length)} is out of date`);
	}
	if (problems.length) {
		console.error(`brand check failed:\n- ${problems.join("\n- ")}\nRun: pnpm run rebrand`);
		process.exit(1);
	}
	process.exit(0);
}

// (1) trace
if (flags.wordmark || flags.isologo) {
	const art = JSON.parse(readFileSync(artFile, "utf8"));
	try {
		if (flags.wordmark) {
			art.wordmark = traceLogo({ file: flags.wordmark, kind: "wordmark" });
			art.letterWeights = letterWeights(art.wordmark);
			const width = Math.max(...art.wordmark.map((l) => l.length));
			if (width > MAX_WORDMARK_WIDTH) {
				console.error(`warning: traced wordmark is ${width} columns wide; the banner logo column holds ${MAX_WORDMARK_WIDTH} and clips the rest. Use a narrower aspect ratio or fewer rows.`);
			}
		}
		if (flags.isologo) art.isologo = traceLogo({ file: flags.isologo, kind: "isologo" });
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
	writeIfChanged(artFile, `${JSON.stringify(art, null, 2)}\n`);
	// (2) copy
	for (const kind of ["wordmark", "isologo"]) {
		if (!flags[kind]) continue;
		const dest = join(root, brand.logos[kind]);
		mkdirSync(dirname(dest), { recursive: true });
		if (resolve(dest) !== flags[kind]) copyFileSync(flags[kind], dest);
	}
}

// (3) theme: drop the previous generated theme BEFORE building, so a case-only rename
// (ACME -> Acme) cannot delete the file just written on a case-insensitive filesystem.
if (applied.themeFile !== themeFile) rmSync(join(root, "themes", applied.themeFile), { force: true });
const build = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "build-brand-assets.mjs"), "--write", "--themes-dir", join(root, "themes")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

// (4) command prefix, (5) package.json bin, (6) state
for (const [file, text] of derivedFiles()) writeIfChanged(file, text);
