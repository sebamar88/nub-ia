// Local audit trail (roadmap T8.4).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AUDIT_SCHEMA, auditFileName, auditRow, auditSubject, auditToday, parseAuditRows, renderAuditSummary, summarizeAudit } from "../lib/audit-log.ts";
import { appendMetricRows, metricsFilePath } from "../lib/runtime-metrics-sink.ts";

test("auditRow: redacts and clips the subject, drops undefined fields, stamps time", () => {
	const row = auditRow({ kind: "tool.ask", outcome: "approved", by: "human", tool: "bash", subject: "  export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \n && ls  ", mode: "manual", when: new Date("2026-02-03T04:05:06Z") });
	assert.equal(row.schema, AUDIT_SCHEMA);
	assert.equal(row.at, "2026-02-03T04:05:06.000Z");
	assert.equal(row.subject, "export AWS_SECRET_ACCESS_KEY=[redacted] && ls");
	assert.ok(!("diffHash" in row));
	assert.equal(auditSubject("x".repeat(500))!.length, 200);
	assert.equal(auditSubject("   "), undefined);
	assert.equal(auditFileName(new Date("2026-02-03T23:59:59Z")), "audit-2026-02.jsonl");
});

test("audit rows land in <configHome>/audit/audit-<month>.jsonl and summarise", async () => {
	const configHome = mkdtempSync(join(tmpdir(), "nubia-audit-"));
	try {
		const now = () => new Date("2026-02-03T04:05:06Z");
		const rows = [
			auditRow({ kind: "mode.change", by: "human", mode: "plan", when: now() }),
			auditRow({ kind: "tool.deny", outcome: "denied", by: "mode", tool: "write", subject: "a.ts", mode: "plan", when: now() }),
			auditRow({ kind: "tool.ask", outcome: "approved", by: "human", tool: "bash", subject: "rm x", when: now() }),
			auditRow({ kind: "push.gate", outcome: "blocked", by: "review-gate", diffHash: "abc", when: new Date("2026-02-02T00:00:00Z") }),
		];
		const path = metricsFilePath("audit", {}, { configHome, now });
		assert.equal(path, join(configHome, "audit", "audit-2026-02.jsonl"));
		assert.equal(await appendMetricRows("audit", rows, {}, { configHome, now }), 4);
		const parsed = parseAuditRows(`${readFileSync(path, "utf8")}garbage\n{"schema":"x"}\n`);
		assert.equal(parsed.rows.length, 4);
		assert.equal(parsed.skipped, 2);
		const summary = summarizeAudit(parsed.rows);
		assert.deepEqual([summary.rows, summary.approved, summary.denied, summary.modeChanges, summary.pushesGated], [4, 1, 2, 1, 1]);
		assert.equal(summary.since, "2026-02-02T00:00:00.000Z");
		assert.match(renderAuditSummary(summary, "audit-2026-02.jsonl"), /4 rows in audit-2026-02\.jsonl · 2026-02-02 → 2026-02-03\nApproved 1 · denied\/blocked 2 · mode changes 1 · gated pushes 1/);
		assert.deepEqual(auditToday(parsed.rows, now()), { denied: 1, approved: 1 });
		assert.match(renderAuditSummary(summarizeAudit([]), "x"), /No audit rows yet/);
	} finally {
		rmSync(configHome, { recursive: true, force: true });
	}
});
