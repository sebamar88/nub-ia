// Review calibration (roadmap T1.7): metrics → per-lens summary and the eval report.
import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrate, parseMetricRows, renderCalibration } from "../lib/nub-review-calibration.ts";
import { REVIEW_METRICS_SCHEMA } from "../lib/nub-review-metrics.ts";

const verdict = (verdict: "approve" | "warn" | "block" | "incomplete", lenses: Array<{ lens: string; outcome?: "ok" | "failed"; durationMs?: number | null; dropped?: number; model?: { provider: string; id: string } }>) =>
	JSON.stringify({ schema: REVIEW_METRICS_SCHEMA, kind: "verdict", at: "2026-01-01T00:00:00Z", diffHash: "0".repeat(16), scope: "working", verdict, diffBytes: 10, durationMs: 1, findings: { BLOCKER: 0, CRITICAL: 0, WARNING: 0, SUGGESTION: 0 }, lenses: lenses.map((lens) => ({ lens: lens.lens, model: lens.model ?? { provider: "openai", id: "gpt-6-astra" }, outcome: lens.outcome ?? "ok", findings: 0, dropped: lens.dropped ?? 0, durationMs: lens.durationMs ?? null })) });
const finding = (lens: string, severity: string) => JSON.stringify({ schema: REVIEW_METRICS_SCHEMA, kind: "finding", at: "x", diffHash: "0".repeat(16), lens, severity, model: { provider: "openai", id: "gpt-6-astra" }, located: true, hasSuggestion: false });

test("parseMetricRows: keeps verdict and finding rows, counts everything else", () => {
	const text = [verdict("approve", []), finding("review-risk", "WARNING"), "not json", JSON.stringify({ kind: "other" }), "", JSON.stringify({ kind: "finding" })].join("\n");
	const parsed = parseMetricRows(text);
	assert.equal(parsed.rows.length, 2);
	assert.equal(parsed.skipped, 3);
});

test("calibrate: per lens runs, failure count, findings by severity, dropped, mean duration and models; unknown lenses ignored", () => {
	const text = [
		verdict("block", [{ lens: "review-risk", durationMs: 1000 }, { lens: "review-readability", outcome: "failed", model: { provider: "unknown", id: "unknown" } }]),
		verdict("warn", [{ lens: "review-risk", durationMs: 3000, dropped: 2, model: { provider: "github-copilot", id: "claude-opus-5.5" } }, { lens: "review-readability" }]),
		verdict("approve", [{ lens: "review-nope" }]),
		finding("review-risk", "BLOCKER"), finding("review-risk", "WARNING"), finding("review-readability", "SUGGESTION"), finding("review-risk", "bogus"), finding("review-nope", "WARNING"),
	].join("\n");
	const parsed = parseMetricRows(text);
	const calibration = calibrate(parsed.rows, parsed.skipped);
	assert.equal(calibration.reviews, 3);
	assert.deepEqual(calibration.verdicts, { approve: 1, warn: 1, block: 1, incomplete: 0 });
	assert.deepEqual(calibration.lenses.map((lens) => lens.lens), ["review-risk", "review-readability"]);
	const risk = calibration.lenses[0]!;
	assert.equal(risk.runs, 2);
	assert.equal(risk.failed, 0);
	assert.deepEqual(risk.findings, { BLOCKER: 1, CRITICAL: 0, WARNING: 1, SUGGESTION: 0 });
	assert.equal(risk.dropped, 2);
	assert.equal(risk.meanDurationMs, 2000);
	assert.deepEqual(risk.models, ["github-copilot/claude-opus-5.5", "openai/gpt-6-astra"]);
	const readability = calibration.lenses[1]!;
	assert.equal(readability.failed, 1);
	assert.equal(readability.meanDurationMs, null);
	assert.deepEqual(readability.models, ["openai/gpt-6-astra"]);
});

test("renderCalibration: empty hint, one line per lens, and advisories only with enough runs", () => {
	assert.match(renderCalibration(calibrate([]), "x.jsonl"), /No review metrics yet in x\.jsonl/);
	const rows = parseMetricRows([
		...Array.from({ length: 6 }, () => verdict("block", [{ lens: "review-risk", durationMs: 2000 }, { lens: "review-resilience", outcome: "failed" }])),
		...Array.from({ length: 12 }, () => finding("review-risk", "BLOCKER")),
	].join("\n")).rows;
	const text = renderCalibration(calibrate(rows), "review-2026-01.jsonl");
	assert.match(text, /6 reviews in review-2026-01\.jsonl/);
	assert.match(text, /risk\s+runs\s+6 · failed 0% · findings\/run 2\.0 \(12 B 0 C 0 W 0 S\) · dropped 0 · mean 2s · openai\/gpt-6-astra/);
	assert.match(text, /Possibly over-severe .*: review-risk/);
	assert.match(text, /Failing often .*: review-resilience/);
});
