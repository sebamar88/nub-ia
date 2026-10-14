#!/usr/bin/env node
// Real divergence from gentle-shell (roadmap T4.1/T4.2): compares each
// upstream file with its Nub-IA counterpart after normalising the deliberate
// rename (gentle → nubia, GENTLE_ → NUB_IA_, gentle-ai → nub-ia, …), so the
// number reported is the logic that would actually conflict in a merge.
//
//   node scripts/upstream-diff.mjs [upstream-ref]        (default upstream/main)
//   node scripts/upstream-diff.mjs --json

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const RENAMES = [
	[/gentle-pi#/g, "gentle-pi#"], // issue references stay
	[/GENTLE_PI_/g, "NUB_IA_"], [/GENTLE_AI_/g, "NUB_IA_"], [/GENTLE_/g, "NUB_IA_"],
	[/gentle-shell/g, "nub-ia"], [/gentle-ai/g, "nub-ia"], [/gentle-pi/g, "nub-ia"],
	[/gentle-/g, "nubia-"], [/gentle:/g, "nubia:"], [/gentleShell/g, "gentleShell"],
	[/Gentle Shell/g, "Nub-IA"], [/Gentle AI/g, "Nub-IA"], [/\bGentle\b/g, "Nub-IA"], [/\bgentle\b/g, "nubia"],
];

const PATH_RENAMES = [[/^extensions\/gentle-ai\.ts$/, "extensions/nubia-harness.ts"], [/gentle-/g, "nubia-"]];

function normalise(text) {
	let out = text;
	for (const [pattern, replacement] of RENAMES) out = out.replace(pattern, replacement);
	return out.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.length > 0);
}

function counterpart(path) {
	let out = path;
	for (const [pattern, replacement] of PATH_RENAMES) out = out.replace(pattern, replacement);
	return out;
}

/** Lines present on only one side, by multiset difference (order-insensitive, so moved blocks do not count twice). */
function divergence(a, b) {
	const counts = new Map();
	for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
	let onlyB = 0;
	for (const line of b) {
		const n = counts.get(line) ?? 0;
		if (n > 0) counts.set(line, n - 1); else onlyB += 1;
	}
	let onlyA = 0;
	for (const n of counts.values()) onlyA += n;
	return { removed: onlyA, added: onlyB };
}

export function measure(ref = "upstream/main", { git = (args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined) } = {}) {
	const list = git(["ls-tree", "-r", "--name-only", ref]);
	if (list.status !== 0) throw new Error(`cannot list ${ref}: ${list.stderr?.trim() || "git failed"} (git fetch upstream first)`);
	const rows = [];
	for (const upstreamPath of list.stdout.split("\n").filter((path) => /^(extensions|lib|bin|scripts)\/.*\.(ts|mjs)$/.test(path))) {
		const localPath = counterpart(upstreamPath);
		const local = read(localPath);
		if (local === undefined) { rows.push({ upstream: upstreamPath, local: localPath, status: "missing-locally" }); continue; }
		const upstream = git(["show", `${ref}:${upstreamPath}`]).stdout;
		const { removed, added } = divergence(normalise(upstream), normalise(local));
		rows.push({ upstream: upstreamPath, local: localPath, status: removed + added === 0 ? "identical" : "diverged", removed, added, total: removed + added });
	}
	rows.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
	return rows;
}

function render(rows) {
	const diverged = rows.filter((row) => row.status === "diverged");
	const lines = [`Divergence from upstream after rename normalisation · ${diverged.length} file(s) differ, ${rows.filter((row) => row.status === "identical").length} identical, ${rows.filter((row) => row.status === "missing-locally").length} missing locally`, ""];
	for (const row of diverged.slice(0, 40)) lines.push(`${String(row.total).padStart(5)}  (-${row.removed} +${row.added})  ${row.local}${row.local !== row.upstream ? `  ← ${row.upstream}` : ""}`);
	if (diverged.length > 40) lines.push(`… ${diverged.length - 40} more`);
	lines.push("", `Total divergent lines: ${diverged.reduce((sum, row) => sum + row.total, 0)}`);
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const ref = args.find((arg) => !arg.startsWith("--")) ?? "upstream/main";
	const rows = measure(ref);
	process.stdout.write(json ? `${JSON.stringify(rows, null, 2)}\n` : `${render(rows)}\n`);
}
