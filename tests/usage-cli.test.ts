import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectUsageInputs, parseUsageArgs } from "../scripts/usage-cli.mjs";

test("parseUsageArgs and collectUsageInputs", () => {
	assert.deepEqual(parseUsageArgs(["--month", "2026-02", "--json"]), { month: "2026-02", json: true });
	assert.deepEqual(parseUsageArgs(["--month=2026-02"]), { month: "2026-02", json: false });
	assert.match(parseUsageArgs(["--month", "feb"]).error, /must be YYYY-MM/);
	assert.match(parseUsageArgs(["--nope"]).error, /Unrecognized argument/);
	assert.match(parseUsageArgs([]).month, /^\d{4}-\d{2}$/);
	const home = mkdtempSync(join(tmpdir(), "nubia-usage-"));
	try {
		mkdirSync(join(home, "metrics"));
		mkdirSync(join(home, "audit"));
		writeFileSync(join(home, "metrics", "runtime-2026-02.jsonl"), "{}\n");
		writeFileSync(join(home, "metrics", "spend-2026-02-01.json"), '{"usd":1}');
		writeFileSync(join(home, "metrics", "review-2026-02.jsonl"), "");
		writeFileSync(join(home, "audit", "audit-2026-02.jsonl"), "");
		const inputs = collectUsageInputs("2026-02", { NUB_IA_CONFIG_HOME: home });
		assert.equal(inputs.runtimeText, "{}\n");
		assert.deepEqual(inputs.spend, [{ date: "2026-02-01", text: '{"usd":1}' }]);
		assert.equal(inputs.reviewText, "");
		assert.equal(inputs.auditText, "");
		assert.equal(collectUsageInputs("2026-03", { NUB_IA_CONFIG_HOME: home }).reviewText, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
