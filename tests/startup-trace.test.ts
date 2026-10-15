import assert from "node:assert/strict";
import test from "node:test";
import {
	TRACE_ENV,
	cachedPiVersion,
	createStartupTrace,
	piRuntimeFingerprint,
	piVersionCacheEntry,
	readPiVersionCache,
} from "../scripts/startup-trace.mjs";

test("createStartupTrace is a no-op unless NUB_IA_TRACE_STARTUP=1", () => {
	const lines: string[] = [];
	createStartupTrace({}, { write: (l: string) => lines.push(l) })("x");
	assert.deepEqual(lines, []);
	let t = 0;
	const stage = createStartupTrace({ [TRACE_ENV]: "1" }, { write: (l: string) => lines.push(l), now: () => t });
	t = 120; stage("pi version (probed)");
	t = 150; stage("rtk checked");
	assert.deepEqual(lines, [
		"nub-ia: [startup] pi version (probed)          +120 ms (total 120 ms)\n",
		"nub-ia: [startup] rtk checked                  +30 ms (total 150 ms)\n",
	]);
});

test("piRuntimeFingerprint keys on the executed file: bundled cli for node, the binary otherwise", () => {
	const stat = () => ({ size: 10, mtimeMs: 5 });
	const realpath = (p: string) => `/real${p}`;
	assert.deepEqual(piRuntimeFingerprint({ command: "/usr/bin/node", args: ["/pkg/cli.js"] }, { stat, realpath }), {
		command: "/usr/bin/node", args: ["/pkg/cli.js"], path: "/real/pkg/cli.js", size: 10, mtimeMs: 5,
	});
	assert.equal(piRuntimeFingerprint({ command: "/bin/pi", args: [] }, { stat, realpath })?.path, "/real/bin/pi");
	assert.equal(piRuntimeFingerprint({ command: "/gone", args: [] }, { stat: () => { throw new Error("ENOENT"); }, realpath }), undefined);
});

test("cachedPiVersion matches only the exact fingerprint and schema", () => {
	const fp = { command: "/bin/pi", args: [] as string[], path: "/real/pi", size: 10, mtimeMs: 5 };
	const entry = piVersionCacheEntry(fp, "1.0.0");
	assert.equal(entry.schema, "nub-ia.pi-version-cache/v1");
	assert.equal(cachedPiVersion(entry, fp), "1.0.0");
	assert.equal(cachedPiVersion(entry, { ...fp, mtimeMs: 6 }), undefined, "reinstalled pi re-probes");
	assert.equal(cachedPiVersion(entry, { ...fp, args: ["/x"] }), undefined);
	assert.equal(cachedPiVersion({ ...entry, schema: "other" }, fp), undefined);
	assert.equal(cachedPiVersion(undefined, fp), undefined);
	assert.equal(cachedPiVersion(entry, undefined), undefined);
});

test("readPiVersionCache tolerates a missing or corrupt file", () => {
	assert.equal(readPiVersionCache("/x", () => { throw new Error("ENOENT"); }), undefined);
	assert.equal(readPiVersionCache("/x", () => "{nope"), undefined);
	assert.deepEqual(readPiVersionCache("/x", () => '{"a":1}'), { a: 1 });
});
