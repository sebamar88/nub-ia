// Keybindings of a freshly bootstrapped isolated home. Pi reserves Shift+Tab
// for `app.thinking.cycle`, and an extension shortcut on a reserved key is
// skipped; Nub-IA wants Shift+Tab for the permission-mode cycle (Claude Code
// muscle memory), so the isolated home moves thinking-cycle to Ctrl+Alt+T.
// Only a key the file does not already set is written; `--link` homes are
// never touched (docs/permission-modes.md explains the manual rebind).

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const THINKING_CYCLE_ACTION = "app.thinking.cycle";
export const THINKING_CYCLE_REBIND = "ctrl+alt+t";
export const MODE_CYCLE_KEY = "shift+tab";

/** Pure merge: adds the thinking-cycle rebind unless the user already decided. */
export function withIsolatedHomeKeybindings(value) {
	if (value !== null && typeof value === "object" && !Array.isArray(value) && THINKING_CYCLE_ACTION in value) return value;
	return { ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}), [THINKING_CYCLE_ACTION]: THINKING_CYCLE_REBIND };
}

export function installIsolatedKeybindings(dir) {
	const path = join(dir, "keybindings.json");
	let current = {};
	if (existsSync(path)) {
		try { current = JSON.parse(readFileSync(path, "utf8")); } catch { return { changed: false, reason: "unreadable" }; }
	}
	const next = withIsolatedHomeKeybindings(current);
	if (next === current) return { changed: false, reason: "already set" };
	const staging = join(dir, `.keybindings-${randomUUID()}.tmp`);
	const fd = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally { closeSync(fd); }
	renameSync(staging, path);
	return { changed: true };
}
