// Team metrics sink (roadmap T3.3): opt-in, sanitized, batched, best effort.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendMetricRows } from "../lib/runtime-metrics-sink.ts";
import { sanitizeForTeam, sendTeamBatches, teamBatches, teamSinkConfig, TEAM_SINK_MAX_ROWS } from "../lib/team-metrics-sink.ts";

test("teamSinkConfig: only with an https endpoint (or localhost http), never when metrics are off", () => {
	assert.equal(teamSinkConfig({}), undefined);
	assert.equal(teamSinkConfig({ NUB_IA_METRICS_ENDPOINT: "ftp://x" }), undefined);
	assert.equal(teamSinkConfig({ NUB_IA_METRICS_ENDPOINT: "http://metrics.example/ingest" }), undefined, "plain http to a remote host is refused");
	assert.deepEqual(teamSinkConfig({ NUB_IA_METRICS_ENDPOINT: "http://localhost:8080/ingest" }), { endpoint: "http://localhost:8080/ingest" });
	assert.deepEqual(teamSinkConfig({ NUB_IA_METRICS_ENDPOINT: "https://m.nubiral.com/ingest", NUB_IA_METRICS_TOKEN: "t", NUB_IA_METRICS_INSTALLATION: "laptop-7" }), { endpoint: "https://m.nubiral.com/ingest", token: "t", installation: "laptop-7" });
	assert.equal(teamSinkConfig({ NUB_IA_METRICS_ENDPOINT: "https://m/ingest", NUB_IA_METRICS: "off" }), undefined);
});

test("sanitizeForTeam drops local-only fields and redacts strings, recursively", () => {
	const row = { kind: "tool.ask", subject: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", repository: "/home/me/secret-repo", reportPath: "/x", nested: { path: "/p", ok: 1, note: "AKIAIOSFODNN7EXAMPLE" }, count: 2 };
	assert.deepEqual(sanitizeForTeam(row), { kind: "tool.ask", subject: "token [redacted github token]", nested: { ok: 1, note: "AKIA…[redacted aws key]" }, count: 2 });
	assert.equal(sanitizeForTeam("x"), undefined);
});

test("teamBatches respects the row cap and sendTeamBatches posts each with the token, counting failures", async () => {
	const config = { endpoint: "https://m/ingest", token: "secret", installation: "i" };
	const rows = Array.from({ length: TEAM_SINK_MAX_ROWS + 1 }, (_, index) => ({ n: index }));
	const batches = teamBatches("audit", rows, config, new Date("2026-01-01T00:00:00Z"));
	assert.equal(batches.length, 2);
	assert.equal(batches[0]!.rows.length, TEAM_SINK_MAX_ROWS);
	assert.equal(batches[0]!.sink, "audit");
	assert.equal(batches[0]!.installation, "i");
	const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
	let n = 0;
	const result = await sendTeamBatches(batches, config, async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); n += 1; return n === 1 ? { ok: true, status: 202 } : { ok: false, status: 500 }; });
	assert.deepEqual(result, { sent: 1, failed: 1 });
	assert.equal(calls[0]!.headers.authorization, "Bearer secret");
	assert.equal(JSON.parse(calls[0]!.body).schema, "nub-ia.team-metrics/v1");
	const thrown = await sendTeamBatches(batches, config, async () => { throw new Error("offline"); });
	assert.deepEqual(thrown, { sent: 0, failed: 2 });
});

test("appendMetricRows mirrors to the team sink only when configured, after writing locally", async () => {
	const configHome = mkdtempSync(join(tmpdir(), "nubia-team-"));
	try {
		const posted: string[] = [];
		const fetcher = async (_url: string, init: { body: string }) => { posted.push(init.body); return { ok: true, status: 200 }; };
		let outcome: { sent: number; failed: number } | undefined;
		await appendMetricRows("audit", [{ schema: "nub-ia.audit/v1", kind: "x", repository: "/r" }], {}, { configHome, fetcher, onTeamSink: (result) => { outcome = result; } });
		assert.equal(posted.length, 0, "no endpoint, no mirror");
		assert.equal(outcome, undefined);
		await appendMetricRows("audit", [{ schema: "nub-ia.audit/v1", kind: "x", repository: "/r" }], { NUB_IA_METRICS_ENDPOINT: "https://m/ingest" }, { configHome, fetcher, onTeamSink: (result) => { outcome = result; } });
		assert.deepEqual(outcome, { sent: 1, failed: 0 });
		const body = JSON.parse(posted[0]!) as { rows: Array<Record<string, unknown>> };
		assert.ok(!("repository" in body.rows[0]!), "local-only fields never leave the machine");
	} finally {
		rmSync(configHome, { recursive: true, force: true });
	}
});
