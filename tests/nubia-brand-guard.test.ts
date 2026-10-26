import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

// The command prefix comes from brand.json (lib/brand.ts `cmd` / `cmdSlash`).
// This guard fails on the literal `nubia:` in code under lib/ and extensions/.
// Comment lines (`//`, `/*`, `*`) are skipped: they are not user-visible output.
const LITERAL = /nubia:/;

// Whole files that may hold the literal.
const FILE_ALLOWLIST = new Set<string>([
	"lib/brand.ts", // default prefix documentation / derivation
	"lib/agent-name-migration.ts", // legacy agent names are intentionally frozen
]);

// Per-line exceptions: internal identifiers that are NOT user-typed commands
// (event names, UI status keys, channels). They are wire names and must not
// change with the brand. Each entry matches `file` and a substring of the line.
const LINE_ALLOWLIST: Array<{ file: string; includes: string }> = [
	{ file: "lib/yolo-session-policy.ts", includes: 'YOLO_STATUS_KEY = "nubia:yolo"' }, // UI status key
	{ file: "lib/yolo-session-policy.ts", includes: 'HOST_UI_CHANNEL = "nubia:yolo:host-ui"' }, // event bus channel
	{ file: "lib/agents-status-model.ts", includes: 'AGENTS_STATUS_EVENT = "nubia:agents-status/v1"' }, // event bus name
	{ file: "lib/router-status-model.ts", includes: 'ROUTER_STATUS_EVENT = "nubia:router-status/v1"' }, // event bus name
	{ file: "lib/runtime-metrics-children.ts", includes: 'CHILD_METRICS_EVENT = "nubia:runtime-metrics:child/v1"' }, // event bus name
	{ file: "lib/runtime-metrics-children.ts", includes: 'CHILD_METRICS_REVOKED = "nubia:runtime-metrics:revoked/v1"' }, // event bus name
	{ file: "lib/herdr-activity.ts", includes: '"nubia:activity"' }, // herdr report source id
	{ file: "extensions/nubia-permission-mode.ts", includes: 'PERMISSION_MODE_EVENT = "nubia:permission-mode/v1"' }, // event bus name
	{ file: "extensions/nubia-permission-mode.ts", includes: 'PERMISSION_MODE_REQUEST = "nubia:permission-mode:request"' }, // event bus name
	{ file: "extensions/nubia-permission-mode.ts", includes: 'PERMISSION_MODE_STATUS_KEY = "nubia:mode"' }, // UI status key
];

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return walk(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

test("no hard-coded nubia: command prefix outside the allowlist", () => {
	const hits: string[] = [];
	for (const dir of ["lib", "extensions"]) {
		for (const path of walk(join(root, dir))) {
			const file = relative(root, path).split("\\").join("/");
			if (FILE_ALLOWLIST.has(file)) continue;
			readFileSync(path, "utf8").split("\n").forEach((line, index) => {
				const trimmed = line.trim();
				if (/^(\/\/|\/\*|\*)/.test(trimmed)) return;
				if (!LITERAL.test(line)) return;
				if (LINE_ALLOWLIST.some((entry) => entry.file === file && line.includes(entry.includes))) return;
				hits.push(`${file}:${index + 1}: ${trimmed.slice(0, 100)}`);
			});
		}
	}
	assert.deepEqual(hits, [], `Use cmd()/cmdSlash() from lib/brand.ts instead of the literal:\n${hits.join("\n")}`);
});

// The product display name comes from brand.json (lib/brand.ts `brand.name`).
// Comment lines are skipped; lib/*.json data files are not scanned.
const NAME_LITERAL = "Nub-IA";

// Whole files that may hold the literal (none: every hit is display text).
const NAME_FILE_ALLOWLIST = new Set<string>([]);

// Per-line exceptions: identifiers/persisted values that must not follow the brand.
const NAME_LINE_ALLOWLIST: Array<{ file: string; includes: string }> = [
	// Persisted wake text recorded by sessions written before the rename: a frozen match key, not display text.
	{ file: "extensions/nubia-agents.ts", includes: "const LEGACY_PARENT_WAKE_TEXT" },
];

test("no hard-coded Nub-IA product name outside the allowlist", () => {
	const hits: string[] = [];
	for (const dir of ["lib", "extensions"]) {
		for (const path of walk(join(root, dir))) {
			const file = relative(root, path).split("\\").join("/");
			if (NAME_FILE_ALLOWLIST.has(file)) continue;
			readFileSync(path, "utf8").split("\n").forEach((line, index) => {
				if (/^(\/\/|\/\*|\*)/.test(line.trim())) return;
				if (!line.includes(NAME_LITERAL)) return;
				if (NAME_LINE_ALLOWLIST.some((entry) => entry.file === file && line.includes(entry.includes))) return;
				hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
			});
		}
	}
	assert.deepEqual(hits, [], `Use brand.name from lib/brand.ts instead of the literal:\n${hits.join("\n")}`);
});
