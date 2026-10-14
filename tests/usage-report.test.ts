// Usage report (roadmap T3.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUsageReport, renderUsageReport } from "../lib/usage-report.ts";

const row = (agentClass: string, provider: string, model: string, responses: number, input: number, output: number, error = "none") =>
	JSON.stringify({ agentClass, provider, observedModelId: model, responseModelId: "unknown", modelFamily: "unknown", error, responses, tokens: { input: { sum: input }, output: { sum: output }, cacheRead: { sum: 10 }, cacheWrite: { sum: 20 }, totalTokens: { sum: input + output + 30 } } });

test("buildUsageReport: totals, by agent class, by model, errors, spend by day, reviews and audit", () => {
	const runtimeText = [row("orchestrator", "github-copilot", "claude-sonnet-5.5", 2, 1000, 200), row("worker", "amazon-bedrock", "custom", 1, 500, 100, "rate_limit"), row("orchestrator", "github-copilot", "claude-sonnet-5.5", 1, 100, 50), "garbage"].join("\n");
	const report = buildUsageReport({
		month: "2026-10",
		runtimeText,
		spend: [{ date: "2026-10-14", text: '{"usd":1.5}' }, { date: "2026-10-02", text: '{"usd":0.25}' }, { date: "2026-09-30", text: '{"usd":9}' }, { date: "2026-10-05", text: "bad" }],
		reviewText: [JSON.stringify({ kind: "verdict", verdict: "block" }), JSON.stringify({ kind: "finding" }), JSON.stringify({ kind: "verdict", verdict: "approve" })].join("\n"),
		auditText: [JSON.stringify({ outcome: "approved" }), JSON.stringify({ outcome: "blocked" }), JSON.stringify({ kind: "mode.change" })].join("\n"),
	});
	assert.equal(report.runtimeRows, 3);
	assert.equal(report.skipped, 1);
	assert.equal(report.responses, 4);
	assert.deepEqual(report.tokens, { input: 1600, output: 350, cacheRead: 30, cacheWrite: 60, total: 2040 });
	assert.deepEqual(report.byAgentClass.map((entry) => [entry.key, entry.responses, entry.total]), [["orchestrator", 3, 1410], ["worker", 1, 630]]);
	assert.deepEqual(report.byModel.map((entry) => entry.key), ["github-copilot/claude-sonnet-5.5", "amazon-bedrock/unknown"]);
	assert.deepEqual(report.errors, { rate_limit: 1 });
	assert.deepEqual(report.spendByDay, [{ date: "2026-10-02", usd: 0.25 }, { date: "2026-10-05", usd: 0 }, { date: "2026-10-14", usd: 1.5 }]);
	assert.equal(report.spendUsd, 1.75);
	assert.deepEqual(report.reviews, { count: 2, verdicts: { block: 1, approve: 1 } });
	assert.deepEqual(report.audit, { rows: 3, approved: 1, denied: 1 });
	const text = renderUsageReport(report, "x.jsonl");
	assert.match(text, /2026-10 · 4 responses · 2\.0k tokens .* · \$1\.75/);
	assert.match(text, /orchestrator\s+3 resp\s+1\.4k tokens/);
	assert.match(text, /Spend by day:\n  2026-10-02  \$0\.25/);
	assert.match(text, /Reviews: 2 \(1 block, 1 approve\)/);
	assert.match(text, /Audit: 3 rows · 1 approved · 1 denied\/blocked/);
	assert.match(renderUsageReport(buildUsageReport({ month: "2026-01", runtimeText: "", spend: [] }), "y"), /No usage recorded for 2026-01/);
});
