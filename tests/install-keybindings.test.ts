import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installIsolatedKeybindings, THINKING_CYCLE_ACTION, THINKING_CYCLE_REBIND, withIsolatedHomeKeybindings } from "../scripts/install-keybindings.mjs";

test("withIsolatedHomeKeybindings frees Shift+Tab unless the user already bound thinking-cycle", () => {
	assert.deepEqual(withIsolatedHomeKeybindings({}), { [THINKING_CYCLE_ACTION]: THINKING_CYCLE_REBIND });
	assert.deepEqual(withIsolatedHomeKeybindings({ "app.exit": "ctrl+q" }), { "app.exit": "ctrl+q", [THINKING_CYCLE_ACTION]: THINKING_CYCLE_REBIND });
	const chosen = { [THINKING_CYCLE_ACTION]: "shift+tab" };
	assert.equal(withIsolatedHomeKeybindings(chosen), chosen);
	assert.deepEqual(withIsolatedHomeKeybindings(null), { [THINKING_CYCLE_ACTION]: THINKING_CYCLE_REBIND });
});

test("installIsolatedKeybindings writes keybindings.json once and leaves a decided file alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "nubia-keys-"));
	try {
		assert.deepEqual(installIsolatedKeybindings(dir), { changed: true });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf8")), { [THINKING_CYCLE_ACTION]: THINKING_CYCLE_REBIND });
		assert.deepEqual(installIsolatedKeybindings(dir), { changed: false, reason: "already set" });
		writeFileSync(join(dir, "keybindings.json"), "{broken");
		assert.deepEqual(installIsolatedKeybindings(dir), { changed: false, reason: "unreadable" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
