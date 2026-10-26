import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

// Subcommands a user types after the binary name. Derived from the dispatcher
// in lib/nubia-launcher.ts: the `arg === "<name>"` branches of parseLauncherArgs
// (home, setup, review, policy, usage, init, audit) plus PI_SUBCOMMANDS
// (install, remove, uninstall, update, list, config, auth).
const SUBCOMMANDS = "home|setup|review|policy|usage|init|audit|install|remove|uninstall|update|list|config|auth";
// `nub-ia <sub>` as a typed command, or `nub-ia <sub>:` as an output prefix.
const LITERAL = new RegExp(`nub-ia (${SUBCOMMANDS})\\b`);

// Per-line exceptions: file + substring of the line. None are needed today;
// every hit must render the binary name from brand.bin.
const LINE_ALLOWLIST: Array<{ file: string; includes: string }> = [];

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return walk(path);
		return /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
	});
}

test("no hard-coded `nub-ia <subcommand>` in user-facing code", () => {
	const hits: string[] = [];
	for (const dir of ["lib", "extensions", "scripts"]) {
		for (const path of walk(join(root, dir))) {
			const file = relative(root, path).split("\\").join("/");
			if (file === "scripts/brand-guard.mjs") continue; // brand unreadable there: literal prefix by design
			readFileSync(path, "utf8").split("\n").forEach((line, index) => {
				if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
				if (!LITERAL.test(line)) return;
				if (LINE_ALLOWLIST.some((entry) => entry.file === file && line.includes(entry.includes))) return;
				hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
			});
		}
	}
	assert.deepEqual(hits, [], `Use \${brand.bin} instead of the literal binary name:\n${hits.join("\n")}`);
});
