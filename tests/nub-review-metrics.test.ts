// Review metrics rows (roadmap T0.2): shape, privacy and sink file.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REVIEW_METRICS_SCHEMA, type ReviewFindingRow, type ReviewVerdictRow, reviewMetricModel, reviewMetricRows } from "../lib/nub-review-metrics.ts";
import { buildReport, type LensResult } from "../lib/nub-review.ts";
import { appendMetricRows, metricsFilePath, runtimeMetricsFilePath } from "../lib/runtime-metrics-sink.ts";

const SECRET_PATH = "src/payments/secret-config.ts";
const DIFF = `diff --git a/${SECRET_PATH} b/${SECRET_PATH}\n--- a/${SECRET_PATH}\n+++ b/${SECRET_PATH}\n@@ -1 +1 @@\n-a\n+const key = "AKIAIOSFODNN7EXAMPLE";\n`;

const lenses: LensResult[] = [
	{
		lens: "review-risk",
		model: "github-copilot/claude-opus-5.5",
		findings: [
			{ lens: "review-risk", severity: "BLOCKER", location: `${SECRET_PATH}:1`, claim: "hardcoded AWS key AKIAIOSFODNN7EXAMPLE", evidence: "const key = ...", suggestion: "use env" },
			{ lens: "review-risk", severity: "WARNING", location: "(unspecified)", claim: "no tests", evidence: "" },
		],
	},
	{ lens: "review-reliability", model: "amazon-bedrock/us.anthropic.claude-sonnet-5-5", findings: [], dropped: 2 },
	{ lens: "review-resilience", model: "nub-ia/balanced", findings: [], error: "timed out after 6 min" },
	{ lens: "review-readability", model: "(none)", findings: [], error: "agent definition not installed" },
];

const when = new Date("2026-03-04T05:06:07.000Z");
const report = buildReport({ scope: { kind: "base", ref: "origin/main" }, diff: DIFF, lenses, when });
const rows = reviewMetricRows({ report, scopeKind: "base", diffBytes: Buffer.byteLength(DIFF), when, durationMs: 12345.6, lensDurationsMs: { "review-risk": 9000.4, "review-reliability": 7000 } });

test("reviewMetricRows: one verdict row then one row per finding, in report order", () => {
	assert.equal(rows.length, 3);
	const [verdict, ...findings] = rows as [ReviewVerdictRow, ...ReviewFindingRow[]];
	assert.equal(verdict.kind, "verdict");
	assert.equal(verdict.schema, REVIEW_METRICS_SCHEMA);
	assert.equal(verdict.at, "2026-03-04T05:06:07.000Z");
	assert.equal(verdict.diffHash, report.diffHash);
	assert.equal(verdict.scope, "base");
	assert.equal(verdict.verdict, "block");
	assert.equal(verdict.diffBytes, Buffer.byteLength(DIFF));
	assert.equal(verdict.durationMs, 12346);
	assert.deepEqual(verdict.findings, { BLOCKER: 1, CRITICAL: 0, WARNING: 1, SUGGESTION: 0 });
	assert.deepEqual(findings.map((row) => [row.kind, row.lens, row.severity, row.located, row.hasSuggestion]), [
		["finding", "review-risk", "BLOCKER", true, true],
		["finding", "review-risk", "WARNING", false, false],
	]);
	for (const row of findings) assert.equal(row.diffHash, report.diffHash);
});

test("reviewMetricRows: per-lens outcome, counts, normalised model and timing; unmeasured durations are null", () => {
	const verdict = rows[0] as ReviewVerdictRow;
	assert.deepEqual(verdict.lenses, [
		{ lens: "review-risk", model: { provider: "github-copilot", id: "claude-opus-5.5" }, outcome: "ok", findings: 2, dropped: 0, durationMs: 9000 },
		{ lens: "review-reliability", model: { provider: "custom", id: "custom" }, outcome: "ok", findings: 0, dropped: 2, durationMs: 7000 },
		{ lens: "review-resilience", model: { provider: "custom", id: "custom" }, outcome: "failed", findings: 0, dropped: 0, durationMs: null },
		{ lens: "review-readability", model: { provider: "unknown", id: "unknown" }, outcome: "failed", findings: 0, dropped: 0, durationMs: null },
	]);
	const finding = rows[1] as ReviewFindingRow;
	assert.deepEqual(finding.model, { provider: "github-copilot", id: "claude-opus-5.5" });
});

test("reviewMetricRows: rows never carry paths, claims, evidence, refs or diff content", () => {
	const text = JSON.stringify(rows);
	for (const leak of [SECRET_PATH, "secret-config", "AKIAIOSFODNN7EXAMPLE", "hardcoded", "const key", "origin/main", "use env"]) {
		assert.ok(!text.includes(leak), `metrics rows leak ${JSON.stringify(leak)}`);
	}
});

test("reviewMetricModel: provider/id labels normalise exactly like runtime rows; placeholders and non-public ids fail closed", () => {
	assert.deepEqual(reviewMetricModel("openai/gpt-6-astra"), { provider: "openai", id: "gpt-6-astra" });
	assert.deepEqual(reviewMetricModel("(session model)"), { provider: "unknown", id: "unknown" });
	assert.deepEqual(reviewMetricModel("(none)"), { provider: "unknown", id: "unknown" });
	assert.deepEqual(reviewMetricModel("llama.cpp/my-private-finetune.gguf"), { provider: "custom", id: "custom" });
	// Bedrock's region/vendor-prefixed ids and the nub-ia virtual tiers are not
	// public family ids under the shared schema, so they are custom here too.
	assert.deepEqual(reviewMetricModel("amazon-bedrock/us.anthropic.claude-sonnet-5-5"), { provider: "custom", id: "custom" });
	assert.deepEqual(reviewMetricModel("nub-ia/balanced"), { provider: "custom", id: "custom" });
});

test("review rows go to their own monthly file next to the runtime rows; NUB_IA_METRICS=off disables them", async () => {
	const configHome = mkdtempSync(join(tmpdir(), "nubia-review-metrics-"));
	try {
		const now = () => when;
		const path = metricsFilePath("review", {}, { configHome, now });
		assert.equal(path, join(configHome, "metrics", "review-2026-03.jsonl"));
		assert.equal(runtimeMetricsFilePath({}, { configHome, now }), join(configHome, "metrics", "runtime-2026-03.jsonl"));
		assert.equal(await appendMetricRows("review", rows, {}, { configHome, now }), 3);
		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
		assert.deepEqual(lines.map((line) => line.kind), ["verdict", "finding", "finding"]);
		assert.equal(await appendMetricRows("review", rows, { NUB_IA_METRICS: "off" }, { configHome, now }), 0);
	} finally {
		rmSync(configHome, { recursive: true, force: true });
	}
});
