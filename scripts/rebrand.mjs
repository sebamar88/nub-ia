#!/usr/bin/env node
// Applies brand.json (or $NUB_IA_BRAND_FILE) to the checkout.
//
//   pnpm run rebrand -- [--wordmark <png>] [--isologo <png>]
//
// New logos: PNG with a transparent background, traced by alpha (a > 128).
// Steps: trace PNGs -> banner-art.json, copy PNGs to brand.logos, regenerate
// the theme (and delete the previous one), rewrite the slash-command prefix in
// the two workflow SKILL.md files, rewrite package.json "bin", record state in
// assets/brand/.applied.json. Idempotent; with the default brand and no flags
// it changes nothing. Requires Python 3 + Pillow only when PNGs are given.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../lib/brand.ts";
import { letterWeights, traceLogo } from "./brand-trace.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = ["skills/nubia-spec-design-tasks/SKILL.md", "skills/nubia-svsd-spec/SKILL.md"];
const APPLIED = join(root, "assets", "brand", ".applied.json");

const args = process.argv.slice(2).filter((a) => a !== "--");
const flags = {};
for (let i = 0; i < args.length; i += 2) {
	const key = args[i];
	if ((key !== "--wordmark" && key !== "--isologo") || !args[i + 1]) {
		console.error("usage: rebrand.mjs [--wordmark <png>] [--isologo <png>]");
		process.exit(2);
	}
	flags[key.slice(2)] = resolve(args[i + 1]);
}

function writeIfChanged(file, text) {
	if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
}

// (1) trace
const artFile = join(root, brand.artwork);
if (flags.wordmark || flags.isologo) {
	const art = JSON.parse(readFileSync(artFile, "utf8"));
	try {
		if (flags.wordmark) {
			art.wordmark = traceLogo({ file: flags.wordmark, kind: "wordmark" });
			art.letterWeights = letterWeights(art.wordmark);
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

// (3) theme
const build = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "build-brand-assets.mjs"), "--write", "--themes-dir", join(root, "themes")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const applied = existsSync(APPLIED) ? JSON.parse(readFileSync(APPLIED, "utf8")) : { prefix: "nubia", themeFile: "Nub-IA.json" };
const themeFile = `${brand.name}.json`;
if (applied.themeFile !== themeFile) rmSync(join(root, "themes", applied.themeFile), { force: true });

// (4) command prefix
const escaped = applied.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prefixRe = new RegExp(`(?<![\\w/])/${escaped}:`, "g");
for (const rel of SKILLS) {
	const file = join(root, rel);
	writeIfChanged(file, readFileSync(file, "utf8").replace(prefixRe, `/${brand.prefix}:`));
}

// (5) package.json bin: replace only the "bin" block to keep the file's formatting.
const pkgFile = join(root, "package.json");
writeIfChanged(pkgFile, readFileSync(pkgFile, "utf8").replace(/("bin": \{\n)[^}]*(\n\t\})/, `$1\t\t${JSON.stringify(brand.bin)}: "bin/nub-ia.mjs"$2`));

// (6) state
writeIfChanged(APPLIED, `${JSON.stringify({ prefix: brand.prefix, themeFile }, null, 2)}\n`);
