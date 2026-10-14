// Review fixtures (roadmap T0.1): realistic diffs with the findings each lens
// must and must not report, exercised deterministically through recorded lens
// answers. The prompt pins make any edit to a lens prompt fail here until the
// fixtures have been re-validated against the real models (roadmap T1.7).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkExpectations,
	currentPromptPins,
	describeFailures,
	lensPromptHash,
	loadReviewFixtures,
	type ReviewFixture,
} from "../lib/nub-review-fixtures.ts";
import { buildReport, type LensResult, parseLensOutputDetailed, REVIEW_LENSES } from "../lib/nub-review.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, "tests", "fixtures", "review");
const AGENTS = join(ROOT, "assets", "agents");
const PINS_PATH = join(FIXTURES, "prompt-pins.json");

const fixtures = loadReviewFixtures(FIXTURES);

/** Runs the recorded answers through the same parser the extension uses. */
function lensResultsFromAnswers(fixture: ReviewFixture): LensResult[] {
	return REVIEW_LENSES.map((lens) => {
		const text = fixture.answers[lens];
		if (text === undefined) return { lens, model: "recorded", findings: [], error: "no recorded answer" };
		const parsed = parseLensOutputDetailed(lens, text);
		return { lens, model: "recorded", findings: parsed.findings, ...(parsed.dropped ? { dropped: parsed.dropped } : {}) };
	});
}

test("review fixtures: every case has a diff, a verdict, an answer per lens and at least one expectation", () => {
	assert.ok(fixtures.length >= 5, `expected at least 5 fixture cases, found ${fixtures.length}`);
	for (const fixture of fixtures) {
		assert.ok(fixture.diff.startsWith("diff --git "), `${fixture.name}: diff.patch is not a unified diff`);
		assert.ok(Object.keys(fixture.lenses).length > 0, `${fixture.name}: no lens expectations`);
		for (const lens of REVIEW_LENSES) assert.ok(fixture.answers[lens], `${fixture.name}: missing answers/${lens}.txt`);
	}
});

test("review fixtures: each lens is pinned down by at least three cases", () => {
	for (const lens of REVIEW_LENSES) {
		const cases = fixtures.filter((fixture) => fixture.lenses[lens]).map((fixture) => fixture.name);
		assert.ok(cases.length >= 3, `${lens} is covered by ${cases.length} case(s): ${cases.join(", ")}`);
	}
	// At least one positive and one negative expectation per lens, so a lens
	// that reports nothing and one that reports everything both fail somewhere.
	for (const lens of REVIEW_LENSES) {
		const positives = fixtures.filter((fixture) => (fixture.lenses[lens]?.mustFlag?.length ?? 0) > 0);
		const negatives = fixtures.filter((fixture) => (fixture.lenses[lens]?.mustNotFlag?.length ?? 0) > 0);
		assert.ok(positives.length >= 1, `${lens} has no mustFlag expectation`);
		assert.ok(negatives.length >= 1, `${lens} has no mustNotFlag expectation`);
	}
});

for (const fixture of fixtures) {
	test(`review fixture ${fixture.name}: recorded answers satisfy the expectations and yield ${fixture.verdict}`, () => {
		const lenses = lensResultsFromAnswers(fixture);
		const report = buildReport({ scope: { kind: "working" }, diff: fixture.diff, lenses, when: new Date("2026-01-01T00:00:00Z") });
		const failures = checkExpectations(fixture, report.findings);
		assert.equal(failures.length, 0, `${fixture.name}:\n${describeFailures(failures)}`);
		assert.equal(report.verdict, fixture.verdict, `${fixture.name}: verdict\n${report.markdown}`);
	});
}

test("review fixture fetch-without-fallback: an invalid-severity entry is dropped and counted, not promoted", () => {
	const fixture = fixtures.find((candidate) => candidate.name === "fetch-without-fallback");
	assert.ok(fixture);
	const reliability = lensResultsFromAnswers(fixture).find((lens) => lens.lens === "review-reliability");
	assert.equal(reliability?.dropped, 1);
	assert.equal(reliability?.findings.length, 1);
});

test("checkExpectations: reports what is missing and what is unexpected", () => {
	const fixture: Pick<ReviewFixture, "lenses"> = {
		lenses: {
			"review-risk": { mustFlag: [{ location: "a.ts", minSeverity: "CRITICAL", claimPattern: "inject" }], mustNotFlag: [{ location: "b.tsx" }] },
		},
	};
	const tooWeak = { lens: "review-risk" as const, severity: "WARNING" as const, location: "a.ts:1", claim: "sql injection", evidence: "" };
	const stray = { lens: "review-risk" as const, severity: "WARNING" as const, location: "b.tsx:3", claim: "xss", evidence: "" };
	const otherLens = { lens: "review-readability" as const, severity: "WARNING" as const, location: "b.tsx:3", claim: "naming", evidence: "" };
	const failures = checkExpectations(fixture, [tooWeak, stray, otherLens]);
	assert.deepEqual(failures.map((failure) => failure.kind), ["missing", "unexpected"]);
	assert.match(describeFailures(failures), /expected a finding at a\.ts \(>= CRITICAL\) matching \/inject\/i/);
	assert.match(describeFailures(failures), /unexpected finding at b\.tsx:3 — xss/);
	const ok = { ...tooWeak, severity: "BLOCKER" as const };
	assert.deepEqual(checkExpectations(fixture, [ok, otherLens]), []);
});

test("lens prompts are pinned: changing a review-*.md prompt requires re-validating the fixtures", () => {
	const pinned = JSON.parse(readFileSync(PINS_PATH, "utf8")) as Record<string, string>;
	const current = currentPromptPins(AGENTS);
	for (const lens of REVIEW_LENSES) {
		assert.equal(
			current[lens],
			pinned[lens],
			`${lens} prompt changed (pin ${pinned[lens]} → ${current[lens]}). Re-run the review fixtures against the real models, adjust tests/fixtures/review/* if the behaviour moved, then update ${PINS_PATH}.`,
		);
	}
	// The pin covers the output contract too: the lenses answer under both.
	assert.notEqual(lensPromptHash("a"), lensPromptHash("b"));
});
