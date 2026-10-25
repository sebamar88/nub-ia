import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HISTORY_CAPTURE_SCHEMA,
	historyCaptureEnabled,
	historyCaptureEnvOverride,
	parseHistoryCaptureFile,
	resolveHistoryCapture,
	resolveHistoryCapturePolicy,
	writeHistoryCapturePolicy,
} from "../lib/history-capture-policy.ts";

const home = () => mkdtempSync(join(tmpdir(), "nubia-history-capture-"));

test("env override accepts only explicit on/off values, trimmed and case-insensitive", () => {
	for (const value of ["1", "true", "on", " TRUE ", "On"]) assert.equal(historyCaptureEnvOverride({ NUB_IA_HISTORY_CAPTURE: value }), "on", value);
	for (const value of ["0", "false", "off", " FALSE ", "Off"]) assert.equal(historyCaptureEnvOverride({ NUB_IA_HISTORY_CAPTURE: value }), "off", value);
	for (const value of [undefined, "", "yes", "no", "enabled", "2"]) assert.equal(historyCaptureEnvOverride({ NUB_IA_HISTORY_CAPTURE: value }), undefined, String(value));
});

test("persisted preference round-trips through the atomic writer", () => {
	const dir = home();
	assert.equal(resolveHistoryCapturePolicy({ nubiaConfigHome: dir }).source, "default");
	const path = writeHistoryCapturePolicy("on", { nubiaConfigHome: dir });
	assert.equal(path, join(dir, "history-capture.json"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: HISTORY_CAPTURE_SCHEMA, policy: "on" });
	assert.deepEqual(resolveHistoryCapturePolicy({ nubiaConfigHome: dir }), { policy: "on", source: "global_file", malformed: false, globalFile: path });
	writeHistoryCapturePolicy("off", { nubiaConfigHome: dir });
	assert.equal(resolveHistoryCapturePolicy({ nubiaConfigHome: dir }).policy, "off");
	assert.deepEqual(readdirSync(dir), ["history-capture.json"], "no temporary file survives the rename");
});

test("writer rejects values outside the on/off domain", () => {
	const dir = home();
	assert.throws(() => writeHistoryCapturePolicy("yes" as never, { nubiaConfigHome: dir }), TypeError);
	assert.equal(existsSync(join(dir, "history-capture.json")), false);
});

test("invalid or unreadable preference files fail closed to off", () => {
	for (const raw of ["", "{", "[]", "null", `{"schema":"${HISTORY_CAPTURE_SCHEMA}","policy":"yes"}`, `{"schema":"other/v1","policy":"on"}`, `{"schema":"${HISTORY_CAPTURE_SCHEMA}","policy":"on","extra":1}`]) {
		assert.equal(parseHistoryCaptureFile(raw), undefined, raw);
		const dir = home();
		writeFileSync(join(dir, "history-capture.json"), raw);
		const resolved = resolveHistoryCapturePolicy({ nubiaConfigHome: dir });
		assert.equal(resolved.policy, "off", raw);
		assert.equal(resolved.malformed, true, raw);
		assert.equal(resolveHistoryCapture({ env: {}, nubiaConfigHome: dir }).enabled, false, raw);
	}
	// A directory where the file should be is unreadable, not missing.
	const dir = home();
	mkdirSync(join(dir, "history-capture.json"));
	assert.deepEqual({ ...resolveHistoryCapturePolicy({ nubiaConfigHome: dir }), globalFile: "" }, { policy: "off", source: "global_file", malformed: true, globalFile: "" });
	if (process.getuid?.() !== 0) {
		const locked = home();
		writeHistoryCapturePolicy("on", { nubiaConfigHome: locked });
		chmodSync(join(locked, "history-capture.json"), 0o000);
		try { assert.equal(resolveHistoryCapture({ env: {}, nubiaConfigHome: locked }).enabled, false); }
		finally { chmodSync(join(locked, "history-capture.json"), 0o600); }
	}
});

test("precedence: explicit env wins, then the persisted preference, then off", () => {
	const dir = home();
	assert.deepEqual(resolveHistoryCapture({ env: {}, nubiaConfigHome: dir }), { enabled: false, source: "default", preference: "off", envOverride: undefined, malformed: false, globalFile: join(dir, "history-capture.json") });
	writeHistoryCapturePolicy("on", { nubiaConfigHome: dir });
	assert.equal(resolveHistoryCapture({ env: {}, nubiaConfigHome: dir }).enabled, true);
	assert.equal(resolveHistoryCapture({ env: {}, nubiaConfigHome: dir }).source, "global_file");
	assert.equal(resolveHistoryCapture({ env: { NUB_IA_HISTORY_CAPTURE: "yes" }, nubiaConfigHome: dir }).enabled, true, "an unrecognized env value defers to the preference");
	const forcedOff = resolveHistoryCapture({ env: { NUB_IA_HISTORY_CAPTURE: " OFF " }, nubiaConfigHome: dir });
	assert.equal(forcedOff.enabled, false);
	assert.equal(forcedOff.source, "env");
	assert.equal(forcedOff.envOverride, "off");
	assert.equal(forcedOff.preference, "on", "the saved preference is still reported under an override");
	writeHistoryCapturePolicy("off", { nubiaConfigHome: dir });
	const forcedOn = resolveHistoryCapture({ env: { NUB_IA_HISTORY_CAPTURE: "1" }, nubiaConfigHome: dir });
	assert.equal(forcedOn.enabled, true);
	assert.equal(forcedOn.source, "env");
	assert.equal(forcedOn.preference, "off");
});

test("per-prompt gate follows the same precedence and fails closed", () => {
	const dir = home();
	assert.equal(historyCaptureEnabled({ env: {}, nubiaConfigHome: dir }), false);
	writeHistoryCapturePolicy("on", { nubiaConfigHome: dir });
	assert.equal(historyCaptureEnabled({ env: {}, nubiaConfigHome: dir }), true);
	assert.equal(historyCaptureEnabled({ env: { NUB_IA_HISTORY_CAPTURE: "off" }, nubiaConfigHome: dir }), false);
	assert.equal(historyCaptureEnabled({ env: { NUB_IA_HISTORY_CAPTURE: "maybe" }, nubiaConfigHome: dir }), true);
	writeFileSync(join(dir, "history-capture.json"), "{");
	assert.equal(historyCaptureEnabled({ env: {}, nubiaConfigHome: dir }), false);
	// An explicit env value decides without consulting the (malformed) file.
	assert.equal(historyCaptureEnabled({ env: { NUB_IA_HISTORY_CAPTURE: "TRUE" }, nubiaConfigHome: dir }), true);
});

test("config home defaults to NUB_IA_CONFIG_HOME from the supplied env", () => {
	const dir = home();
	writeHistoryCapturePolicy("on", { nubiaConfigHome: dir });
	assert.equal(resolveHistoryCapture({ env: { NUB_IA_CONFIG_HOME: dir } }).enabled, true);
	assert.equal(resolveHistoryCapture({ env: { NUB_IA_CONFIG_HOME: dir } }).globalFile, join(dir, "history-capture.json"));
});
