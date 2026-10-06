import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type GitRunner,
	type LensResult,
	buildReport,
	collectDiff,
	computeVerdict,
	hashDiff,
	isGitPush,
	parseLensOutput,
	pushGateQuestion,
	summarizeReport,
} from "../lib/nub-review.ts";

const fakeGit = (responses: Record<string, { code?: number; stdout?: string; stderr?: string }>): GitRunner => async (args) => {
	const key = args.join(" ");
	const hit = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
	if (!hit) throw new Error(`unexpected git ${key}`);
	return { code: hit[1].code ?? 0, stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "" };
};

const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

test("collectDiff: auto prefers staged changes and falls back to the working tree", async () => {
	const staged = fakeGit({ "diff --cached --quiet": { code: 1 }, "diff --cached --no-color": { stdout: DIFF } });
	const withStaged = await collectDiff(staged, { kind: "auto" });
	assert.ok("diff" in withStaged && withStaged.scope.kind === "staged");
	const unstaged = fakeGit({ "diff --cached --quiet": { code: 0 }, "diff HEAD --no-color": { stdout: DIFF } });
	const withWorking = await collectDiff(unstaged, { kind: "auto" });
	assert.ok("diff" in withWorking && withWorking.scope.kind === "working");
	const base = fakeGit({ "diff main...HEAD": { stdout: DIFF } });
	const ranged = await collectDiff(base, { kind: "base", ref: "main" });
	assert.ok("diff" in ranged && ranged.scope.kind === "base");
});

test("collectDiff: empty diffs, git failures, and oversized diffs are explained, not reviewed", async () => {
	assert.deepEqual(await collectDiff(fakeGit({ "diff --cached --no-color": { stdout: "\n" } }), { kind: "staged" }), { error: "nothing to review: no staged changes" });
	const failed = await collectDiff(fakeGit({ "diff nope...HEAD": { code: 128, stderr: "fatal: bad revision" } }), { kind: "base", ref: "nope" });
	assert.ok("error" in failed && failed.error.includes("bad revision"));
	const huge = await collectDiff(fakeGit({ "diff HEAD": { stdout: "x".repeat(500 * 1024) } }), { kind: "working" });
	assert.ok("error" in huge && /KiB review bound/.test(huge.error));
});

test("parseLensOutput: tolerates fences and prose around the JSON, drops malformed entries, rejects a missing envelope", () => {
	const text = 'Here you go:\n```json\n{"findings":[{"severity":"critical","location":"a.ts:3","claim":"SQL built by concatenation","evidence":"+ `SELECT * FROM t WHERE id=${id}`","suggestion":"parameterize"},{"severity":"nope","claim":"x"},{"severity":"WARNING","claim":"   "},{"severity":"SUGGESTION","claim":"rename foo"}]}\n```\nthanks';
	const findings = parseLensOutput("review-risk", text);
	assert.equal(findings.length, 2);
	assert.deepEqual(findings[0], { lens: "review-risk", severity: "CRITICAL", location: "a.ts:3", claim: "SQL built by concatenation", evidence: "+ `SELECT * FROM t WHERE id=${id}`", suggestion: "parameterize" });
	assert.equal(findings[1].location, "(unspecified)");
	assert.deepEqual(parseLensOutput("review-risk", '{"findings":[]}'), []);
	assert.throws(() => parseLensOutput("review-risk", "I found nothing."), /no JSON object/);
	assert.throws(() => parseLensOutput("review-risk", '{"result":"ok"}'), /findings array/);
});

const lens = (name: LensResult["lens"], findings: Partial<LensResult["findings"][number]>[] = [], error?: string): LensResult => ({
	lens: name,
	model: "github-copilot/claude-sonnet-5.5",
	findings: findings.map((finding) => ({ lens: name, severity: "WARNING", location: "f.ts:1", claim: "c", evidence: "e", ...finding })) as LensResult["findings"],
	...(error ? { error } : {}),
});

test("computeVerdict: blockers win over failures, failures over warnings, warnings over a clean pass", () => {
	assert.equal(computeVerdict([lens("review-risk"), lens("review-readability")]), "approve");
	assert.equal(computeVerdict([lens("review-risk", [{ severity: "WARNING" }])]), "warn");
	assert.equal(computeVerdict([lens("review-risk", [{ severity: "SUGGESTION" }])]), "approve");
	assert.equal(computeVerdict([lens("review-risk", [{ severity: "WARNING" }]), lens("review-resilience", [], "timed out")]), "incomplete");
	assert.equal(computeVerdict([lens("review-risk", [{ severity: "CRITICAL" }]), lens("review-resilience", [], "timed out")]), "block");
	assert.equal(computeVerdict([lens("review-reliability", [{ severity: "BLOCKER" }])]), "block");
});

test("buildReport: findings ordered by severity, counts and lens failures rendered, hash is stable", () => {
	const report = buildReport({
		scope: { kind: "staged" },
		diff: DIFF,
		when: new Date("2026-10-05T12:00:00Z"),
		lenses: [
			lens("review-readability", [{ severity: "SUGGESTION", location: "z.ts:9", claim: "rename" }]),
			lens("review-risk", [{ severity: "BLOCKER", location: "a.ts:1", claim: "secret committed", evidence: "+ API_KEY=sk-…", suggestion: "move to env" }]),
			lens("review-resilience", [], "unparseable answer: no JSON object in lens output"),
		],
	});
	assert.equal(report.verdict, "block");
	assert.equal(report.diffHash, hashDiff(DIFF));
	assert.deepEqual(report.findings.map((finding) => finding.severity), ["BLOCKER", "SUGGESTION"]);
	assert.match(report.markdown, /^# Nub-IA review · staged changes/);
	assert.match(report.markdown, /Verdict: \*\*BLOCK/);
	assert.match(report.markdown, /Findings: 1 BLOCKER, 1 SUGGESTION/);
	assert.match(report.markdown, /resilience \(github-copilot\/claude-sonnet-5\.5, failed\)/);
	assert.match(report.markdown, /## BLOCKER\n\n### a\.ts:1 — secret committed\n- Lens: risk\n- Evidence: \+ API_KEY=sk-…\n- Suggestion: move to env/);
	assert.match(report.markdown, /## Lens failures\n\n- review-resilience: unparseable answer/);
	const summary = summarizeReport(report, "/r/x.md");
	assert.match(summary, /^BLOCK — fix the BLOCKER\/CRITICAL findings before pushing \(2 findings across 3 lenses, diff [0-9a-f]{16}\)\n- \[BLOCKER\] a\.ts:1: secret committed\n- \[SUGGESTION\] z\.ts:9: rename\nFull report: \/r\/x\.md$/);
});

test("isGitPush recognises push in the usual shell shapes and nothing else", () => {
	for (const command of ["git push", "git push origin main", "git -C /repo push --force-with-lease", "pnpm test && git push", "cd x; git push", "sh -c 'git push origin HEAD'", "git -c push.default=current push"]) {
		assert.ok(isGitPush(command), command);
	}
	for (const command of ["git status", "git pull", "echo git push", "rtk git log", "git pushd", "npm run push"]) {
		assert.equal(isGitPush(command), false, command);
	}
});

test("pushGateQuestion: silent when nothing is deliverable or the matching review approved; asks otherwise", () => {
	const last = { diffHash: "abc", verdict: "approve" as const, reportPath: "/r/1.md", when: "2026-10-05T12:00:00Z" };
	assert.equal(pushGateQuestion(undefined, undefined), undefined, "no upstream/no diff → nothing to gate");
	assert.equal(pushGateQuestion(last, "abc"), undefined);
	assert.equal(pushGateQuestion({ ...last, verdict: "warn" }, "abc"), undefined, "warnings do not gate");
	assert.match(pushGateQuestion(undefined, "abc")!, /No Nub-IA review on record/);
	assert.match(pushGateQuestion(last, "zzz")!, /covered a different diff/);
	assert.match(pushGateQuestion({ ...last, verdict: "block" }, "abc")!, /BLOCKER\/CRITICAL findings \(\/r\/1\.md\)/);
	assert.match(pushGateQuestion({ ...last, verdict: "incomplete" }, "abc")!, /incomplete/);
});
