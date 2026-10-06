import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRuntimeMetricRows, runtimeMetricsFilePath, runtimeMetricsSinkEnabled, runtimeMetricsSummary } from "../lib/runtime-metrics-sink.ts";

function tmp(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "nub-ia-metrics-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const march = () => new Date(Date.UTC(2026, 2, 15));

test("the sink appends one JSON line per row under metrics/runtime-YYYY-MM.jsonl", async (t) => {
	const configHome = tmp(t);
	const rows = [{ a: 1 }, { b: "two" }];
	assert.equal(await appendRuntimeMetricRows(rows, {}, { configHome, now: march }), 2);
	assert.equal(await appendRuntimeMetricRows([{ c: 3 }], {}, { configHome, now: march }), 1);
	const path = join(configHome, "metrics", "runtime-2026-03.jsonl");
	assert.equal(runtimeMetricsFilePath({}, { configHome, now: march }), path);
	const lines = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines, [{ a: 1 }, { b: "two" }, { c: 3 }]);
	assert.deepEqual(await runtimeMetricsSummary({}, { configHome, now: march }), { rows: 3, path });
});

test("rotation is by month only", async (t) => {
	const configHome = tmp(t);
	await appendRuntimeMetricRows([{ m: 3 }], {}, { configHome, now: march });
	await appendRuntimeMetricRows([{ m: 4 }], {}, { configHome, now: () => new Date(Date.UTC(2026, 3, 1)) });
	assert.ok(existsSync(join(configHome, "metrics", "runtime-2026-03.jsonl")));
	assert.ok(existsSync(join(configHome, "metrics", "runtime-2026-04.jsonl")));
});

test("past the cap it stops appending and writes a .capped marker once", async (t) => {
	const configHome = tmp(t);
	const path = runtimeMetricsFilePath({}, { configHome, now: march });
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x".repeat(100));
	const options = { configHome, now: march, maxBytes: 50 };
	assert.equal(await appendRuntimeMetricRows([{ a: 1 }], {}, options), 0);
	assert.equal(readFileSync(path, "utf8"), "x".repeat(100));
	const marker = readFileSync(`${path}.capped`, "utf8");
	await appendRuntimeMetricRows([{ a: 1 }], {}, options);
	assert.equal(readFileSync(`${path}.capped`, "utf8"), marker, "marker is written once");
});

test("NUB_IA_METRICS=off disables the sink", async (t) => {
	const configHome = tmp(t);
	assert.equal(runtimeMetricsSinkEnabled({ NUB_IA_METRICS: "off" }), false);
	assert.equal(runtimeMetricsSinkEnabled({}), true);
	assert.equal(await appendRuntimeMetricRows([{ a: 1 }], { NUB_IA_METRICS: "off" }, { configHome, now: march }), 0);
	assert.equal(existsSync(join(configHome, "metrics")), false);
});
