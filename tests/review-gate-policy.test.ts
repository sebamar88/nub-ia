import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewStatusLines, describeAge } from "../lib/nub-review.ts";
import { REVIEW_GATE_SCHEMA, REVIEW_MODE_ACTIONS, describeReviewGate, parseReviewGateFile, resolveReviewGate, writeGlobalReviewGate } from "../lib/review-gate-policy.ts";

function scratch(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "nub-ia-review-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	const configHome = join(root, "config");
	mkdirSync(cwd, { recursive: true });
	return { cwd, configHome };
}

test("parseReviewGateFile accepts only the strict schema", () => {
	assert.equal(parseReviewGateFile(JSON.stringify({ schema: REVIEW_GATE_SCHEMA, mode: "strict" })), "strict");
	for (const raw of ["nope", "[]", JSON.stringify({ schema: REVIEW_GATE_SCHEMA, mode: "loud" }), JSON.stringify({ schema: "other", mode: "off" }), JSON.stringify({ schema: REVIEW_GATE_SCHEMA, mode: "off", extra: 1 })]) {
		assert.equal(parseReviewGateFile(raw), undefined, raw);
	}
});

test("resolveReviewGate: project file, then global file, then env, then default confirm; malformed fails closed", (t) => {
	const { cwd, configHome } = scratch(t);
	const env: Record<string, string | undefined> = {};
	assert.deepEqual(resolveReviewGate(cwd, { configHome, env }).mode, "confirm");
	assert.equal(resolveReviewGate(cwd, { configHome, env }).source, "default");
	env.NUB_IA_REVIEW_GATE = "off";
	assert.equal(resolveReviewGate(cwd, { configHome, env }).source, "environment");
	assert.equal(resolveReviewGate(cwd, { configHome, env }).mode, "off");
	const globalPath = writeGlobalReviewGate("strict", configHome);
	assert.equal(globalPath, join(configHome, "review-gate.json"));
	assert.deepEqual([resolveReviewGate(cwd, { configHome, env }).mode, resolveReviewGate(cwd, { configHome, env }).source], ["strict", "global_file"]);
	mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "nub-ia", "review-gate.json"), JSON.stringify({ schema: REVIEW_GATE_SCHEMA, mode: "confirm" }));
	assert.deepEqual([resolveReviewGate(cwd, { configHome, env }).mode, resolveReviewGate(cwd, { configHome, env }).source], ["confirm", "project_file"]);
	writeFileSync(join(cwd, ".pi", "nub-ia", "review-gate.json"), "{broken");
	const broken = resolveReviewGate(cwd, { configHome, env });
	assert.deepEqual([broken.mode, broken.source, broken.malformed], ["confirm", "project_file", true]);
	assert.match(describeReviewGate(broken), /Review gate: confirm — decided by project file .*malformed/);
});

test("the /nubia:review-mode actions map to modes; enable means confirm", () => {
	assert.deepEqual(REVIEW_MODE_ACTIONS, { enable: "confirm", confirm: "confirm", strict: "strict", disable: "off", off: "off" });
});

test("reviewStatusLines renders the Status block for every state", () => {
	const now = new Date("2026-10-06T12:00:00Z");
	const last = { diffHash: "abc", verdict: "approve" as const, reportPath: "/r/1.md", when: "2026-10-06T11:48:00Z" };
	assert.deepEqual(reviewStatusLines(undefined, undefined, "confirm", now), { headline: "No review yet", tone: "none", detail: "nub_review · gate: confirm" });
	assert.deepEqual(reviewStatusLines(last, "abc", "confirm", now), { headline: "APPROVE · 12 min ago", tone: "ok", detail: "gate: confirm" });
	assert.deepEqual(reviewStatusLines(last, undefined, "strict", now), { headline: "APPROVE · 12 min ago", tone: "ok", detail: "gate: strict" }, "an unknown current hash does not claim staleness");
	assert.deepEqual(reviewStatusLines(last, "zzz", "confirm", now), { headline: "APPROVE · 12 min ago · diff changed since", tone: "warn", detail: "rerun nub_review · gate: confirm" });
	assert.equal(reviewStatusLines({ ...last, verdict: "block" }, "abc", "off", now).tone, "bad");
	assert.equal(reviewStatusLines({ ...last, verdict: "warn" }, "abc", "off", now).tone, "warn");
	assert.equal(describeAge(new Date("2026-10-06T11:59:40Z"), now), "just now");
	assert.equal(describeAge(new Date("2026-10-06T09:00:00Z"), now), "3 h ago");
	assert.equal(describeAge(new Date("2026-10-01T12:00:00Z"), now), "5 d ago");
});
