#!/usr/bin/env node
// Pin bumps (roadmap T4.4): refreshes the two hand-pinned dependencies and
// prints what changed, so a workflow (or a human) can open a PR with verified
// digests instead of editing constants by hand.
//
//   node scripts/bump-pins.mjs            # rewrite files in place, exit 0 if something changed, 3 if nothing did
//   node scripts/bump-pins.mjs --check    # report only
//
// rtk: latest GitHub release → RTK_VERSION, RTK_ASSETS digests from the
// release's checksums.txt (matched by file name), RTK_BINARY_SHA256 reset to
// undefined (the installer re-records them per platform; the archive digest
// protects the download meanwhile).
// ponytail: npm registry dist-tags.latest → the TEAM_PACKAGE_SOURCES pin in
// lib/nubia-launcher.ts and the README mention.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RTK_RELEASES_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";
export const PONYTAIL_REGISTRY = "https://registry.npmjs.org/@dietrichgebert%2Fponytail";

// --- pure rewriters (unit-tested) ---------------------------------------------------

/** checksums.txt lines `<sha256>  <file>` → { file: sha256 }. */
export function parseChecksums(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
		if (match) out[match[2]] = match[1];
	}
	return out;
}

/** Rewrites RTK_VERSION, every RTK_ASSETS digest it can match, and clears RTK_BINARY_SHA256. */
export function rewriteRtkInstaller(source, version, checksums) {
	let out = source.replace(/export const RTK_VERSION = "[^"]+";/, `export const RTK_VERSION = "${version}";`);
	out = out.replace(/\/\/ Archive digests from the release's checksums\.txt \(v[^)]+\)\./, `// Archive digests from the release's checksums.txt (v${version}).`);
	const missing = [];
	out = out.replace(/\{ file: "([^"]+)", sha256: "[0-9a-f]{64}" \}/g, (whole, file) => {
		const digest = checksums[file];
		if (!digest) { missing.push(file); return whole; }
		return `{ file: "${file}", sha256: "${digest}" }`;
	});
	out = out.replace(/("(?:linux|darwin|win32)-(?:x64|arm64)": )"[0-9a-f]{64}"/g, "$1undefined");
	return { source: out, missing };
}

export function rewritePonytailPin(source, version) {
	return source.replace(/npm:@dietrichgebert\/ponytail@\d+\.\d+\.\d+/g, `npm:@dietrichgebert/ponytail@${version}`);
}

export function currentRtkVersion(source) {
	return /export const RTK_VERSION = "([^"]+)";/.exec(source)?.[1];
}

export function currentPonytailVersion(source) {
	return /npm:@dietrichgebert\/ponytail@(\d+\.\d+\.\d+)/.exec(source)?.[1];
}

// --- network + files ------------------------------------------------------------------

async function fetchJson(url) {
	const response = await fetch(url, { headers: { "user-agent": "nub-ia-bump-pins", accept: "application/vnd.github+json, application/json" } });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return response.json();
}

export async function bumpPins({ check = false, fetchJsonImpl = fetchJson, fetchTextImpl = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); } } = {}) {
	const changes = [];
	// rtk
	const installerPath = join(ROOT, "scripts", "rtk-installer.mjs");
	const installer = readFileSync(installerPath, "utf8");
	const release = await fetchJsonImpl(RTK_RELEASES_API);
	const latestRtk = String(release.tag_name ?? "").replace(/^v/, "");
	const currentRtk = currentRtkVersion(installer);
	if (latestRtk && latestRtk !== currentRtk) {
		const checksumAsset = (release.assets ?? []).find((asset) => /checksums?\.txt$/i.test(asset.name));
		if (!checksumAsset) throw new Error(`rtk v${latestRtk} has no checksums.txt asset; cannot bump safely`);
		const checksums = parseChecksums(await fetchTextImpl(checksumAsset.browser_download_url));
		const { source, missing } = rewriteRtkInstaller(installer, latestRtk, checksums);
		if (missing.length) throw new Error(`rtk v${latestRtk} checksums.txt lacks ${missing.join(", ")}; the asset names changed, bump by hand`);
		if (!check) writeFileSync(installerPath, source);
		changes.push(`rtk ${currentRtk} → ${latestRtk} (archive digests from checksums.txt; binary digests reset, re-record with pnpm run install:rtk)`);
	}
	// ponytail
	const launcherPath = join(ROOT, "lib", "nubia-launcher.ts");
	const launcher = readFileSync(launcherPath, "utf8");
	const registry = await fetchJsonImpl(PONYTAIL_REGISTRY);
	const latestPonytail = registry?.["dist-tags"]?.latest;
	const currentPonytail = currentPonytailVersion(launcher);
	if (typeof latestPonytail === "string" && latestPonytail !== currentPonytail) {
		if (!check) {
			writeFileSync(launcherPath, rewritePonytailPin(launcher, latestPonytail));
			const readmePath = join(ROOT, "README.md");
			writeFileSync(readmePath, rewritePonytailPin(readFileSync(readmePath, "utf8"), latestPonytail));
		}
		changes.push(`ponytail ${currentPonytail} → ${latestPonytail} (lib/nubia-launcher.ts, README.md; regenerate runtime/ with pnpm run build:runtime-modules)`);
	}
	return changes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const check = process.argv.includes("--check");
	bumpPins({ check }).then((changes) => {
		if (changes.length === 0) { process.stdout.write("pins are current\n"); process.exit(3); }
		process.stdout.write(`${changes.join("\n")}\n`);
	}, (error) => { process.stderr.write(`bump-pins: ${error.message}\n`); process.exit(1); });
}
