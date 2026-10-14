// Review fixtures: a diff, the findings each lens is expected (and expected
// NOT) to report, and recorded lens answers. Shared by the deterministic unit
// tests (tests/nub-review-fixtures.test.ts) and, later, by the opt-in
// evaluation that runs the real lens models over the same expectations.
//
// Pure: no I/O except the loader, which takes a root directory.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDefinition } from "./agents-config.ts";
import { type Finding, LENS_OUTPUT_CONTRACT, REVIEW_LENSES, type ReviewLens, SEVERITIES, type Severity, type Verdict } from "./nub-review.ts";

export interface FindingExpectation {
	/** Substring the finding's location must contain (usually the file path). */
	location: string;
	/** For mustFlag: the weakest acceptable severity. Defaults to SUGGESTION. */
	minSeverity?: Severity;
	/** Regex (case-insensitive) the claim or evidence must match. */
	claimPattern?: string;
}

export interface LensExpectation {
	mustFlag?: FindingExpectation[];
	mustNotFlag?: FindingExpectation[];
}

export interface ReviewFixture {
	name: string;
	description: string;
	verdict: Verdict;
	lenses: Partial<Record<ReviewLens, LensExpectation>>;
	diff: string;
	/** Recorded lens answers, raw text as a model would return it. */
	answers: Partial<Record<ReviewLens, string>>;
}

export interface ExpectationFailure {
	lens: ReviewLens;
	kind: "missing" | "unexpected";
	expectation: FindingExpectation;
	/** For "unexpected": the finding that violated the expectation. */
	finding?: Finding;
}

const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

function matches(expectation: FindingExpectation, finding: Finding): boolean {
	if (!finding.location.includes(expectation.location)) return false;
	if (expectation.claimPattern === undefined) return true;
	const pattern = new RegExp(expectation.claimPattern, "i");
	return pattern.test(finding.claim) || pattern.test(finding.evidence);
}

/** Findings that violate the fixture's expectations; empty when the lenses behaved. */
export function checkExpectations(fixture: Pick<ReviewFixture, "lenses">, findings: readonly Finding[]): ExpectationFailure[] {
	const failures: ExpectationFailure[] = [];
	for (const lens of REVIEW_LENSES) {
		const expectation = fixture.lenses[lens];
		if (!expectation) continue;
		const own = findings.filter((finding) => finding.lens === lens);
		for (const must of expectation.mustFlag ?? []) {
			const floor = severityRank(must.minSeverity ?? "SUGGESTION");
			if (!own.some((finding) => matches(must, finding) && severityRank(finding.severity) <= floor)) failures.push({ lens, kind: "missing", expectation: must });
		}
		for (const mustNot of expectation.mustNotFlag ?? []) {
			for (const finding of own) if (matches(mustNot, finding)) failures.push({ lens, kind: "unexpected", expectation: mustNot, finding });
		}
	}
	return failures;
}

export function describeFailures(failures: readonly ExpectationFailure[]): string {
	return failures
		.map((failure) => failure.kind === "missing"
			? `${failure.lens}: expected a finding at ${failure.expectation.location}${failure.expectation.minSeverity ? ` (>= ${failure.expectation.minSeverity})` : ""}${failure.expectation.claimPattern ? ` matching /${failure.expectation.claimPattern}/i` : ""}`
			: `${failure.lens}: unexpected finding at ${failure.finding?.location} — ${failure.finding?.claim}`)
		.join("\n");
}

// --- prompt pins --------------------------------------------------------------

/**
 * The exact system prompt a lens runs with, as extensions/nub-ia-review.ts
 * assembles it: the agent instructions followed by the output contract.
 */
export function lensSystemPrompt(instructions: string): string {
	return `${instructions.trim()}\n\n${LENS_OUTPUT_CONTRACT}`;
}

export function lensPromptHash(instructions: string): string {
	return createHash("sha256").update(lensSystemPrompt(instructions)).digest("hex").slice(0, 16);
}

/** Current prompt hash per lens, read from the packaged agent definitions. */
export function currentPromptPins(agentsDir: string): Record<ReviewLens, string> {
	const pins = {} as Record<ReviewLens, string>;
	for (const lens of REVIEW_LENSES) {
		const path = join(agentsDir, `${lens}.md`);
		const parsed = parseAgentDefinition(readFileSync(path, "utf8"), path, "global");
		if ("error" in parsed) throw new Error(`${path}: ${parsed.error}`);
		pins[lens] = lensPromptHash(parsed.instructions);
	}
	return pins;
}

// --- loader -------------------------------------------------------------------

const isLens = (value: string): value is ReviewLens => (REVIEW_LENSES as readonly string[]).includes(value);
const isVerdict = (value: unknown): value is Verdict => typeof value === "string" && ["approve", "warn", "block", "incomplete"].includes(value);

function parseExpectations(name: string, text: string): Pick<ReviewFixture, "description" | "verdict" | "lenses"> {
	const raw = JSON.parse(text) as { description?: unknown; verdict?: unknown; lenses?: unknown };
	if (!isVerdict(raw.verdict)) throw new Error(`${name}: expectations.json needs a verdict (approve|warn|block|incomplete)`);
	if (typeof raw.lenses !== "object" || raw.lenses === null) throw new Error(`${name}: expectations.json needs a lenses object`);
	const lenses: Partial<Record<ReviewLens, LensExpectation>> = {};
	for (const [key, value] of Object.entries(raw.lenses)) {
		if (!isLens(key)) throw new Error(`${name}: unknown lens ${JSON.stringify(key)}`);
		lenses[key] = value as LensExpectation;
	}
	return { description: typeof raw.description === "string" ? raw.description : "", verdict: raw.verdict, lenses };
}

/** Every `<root>/<case>/` directory with a diff.patch and expectations.json. */
export function loadReviewFixtures(root: string): ReviewFixture[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const dir = join(root, name);
			const diff = readFileSync(join(dir, "diff.patch"), "utf8");
			const expectations = parseExpectations(name, readFileSync(join(dir, "expectations.json"), "utf8"));
			const answers: Partial<Record<ReviewLens, string>> = {};
			const answersDir = join(dir, "answers");
			if (existsSync(answersDir)) {
				for (const file of readdirSync(answersDir)) {
					const lens = file.replace(/\.txt$/, "");
					if (isLens(lens)) answers[lens] = readFileSync(join(answersDir, file), "utf8");
				}
			}
			return { name, diff, answers, ...expectations };
		});
}
