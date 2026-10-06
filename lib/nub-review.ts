// Nub-IA review: pure helpers for the in-process 4R code review
// (extensions/nub-ia-review.ts). No Pi imports, no I/O except the git diff
// collector, which takes an injected runner so tests never spawn git.
//
// Model: four lens agents (risk, reliability, resilience, readability) each get
// the same diff and answer with a small JSON findings list. The findings are
// consolidated into one markdown report plus a verdict; the verdict and the
// diff hash are what the push gate checks later.

import { createHash } from "node:crypto";

export const REVIEW_LENSES = ["review-risk", "review-reliability", "review-resilience", "review-readability"] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

export const SEVERITIES = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
	lens: ReviewLens;
	severity: Severity;
	location: string;
	claim: string;
	evidence: string;
	suggestion?: string;
}

export interface LensResult {
	lens: ReviewLens;
	model: string;
	findings: Finding[];
	/** Set when the lens could not be run or its answer could not be parsed. */
	error?: string;
	rawExcerpt?: string;
}

export type Verdict = "approve" | "warn" | "block" | "incomplete";

export interface ReviewReport {
	diffHash: string;
	scope: string;
	verdict: Verdict;
	findings: Finding[];
	lenses: LensResult[];
	markdown: string;
}

// --- diff -------------------------------------------------------------------

export type DiffScope = { kind: "staged" } | { kind: "working" } | { kind: "base"; ref: string };

export interface GitRunner {
	(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function describeScope(scope: DiffScope): string {
	return scope.kind === "base" ? `changes since ${scope.ref}` : scope.kind === "staged" ? "staged changes" : "working tree changes";
}

function diffArgs(scope: DiffScope): string[] {
	const common = ["--no-color", "--no-ext-diff", "-U8", "--find-renames"];
	if (scope.kind === "staged") return ["diff", "--cached", ...common];
	if (scope.kind === "working") return ["diff", "HEAD", ...common];
	return ["diff", `${scope.ref}...HEAD`, ...common];
}

export const DIFF_MAX_BYTES = 400 * 1024;

/**
 * The unified diff for `scope`, or an explanation of why there is nothing to
 * review. "auto" picks staged changes when any exist, else the working tree.
 */
export async function collectDiff(git: GitRunner, scope: DiffScope | { kind: "auto" }): Promise<{ scope: DiffScope; diff: string } | { error: string }> {
	let resolved: DiffScope;
	if (scope.kind === "auto") {
		const staged = await git(["diff", "--cached", "--quiet"]);
		resolved = staged.code === 1 ? { kind: "staged" } : { kind: "working" };
	} else {
		resolved = scope;
	}
	const result = await git(diffArgs(resolved));
	if (result.code !== 0) return { error: `git diff failed: ${result.stderr.trim() || `exit ${result.code}`}` };
	const diff = result.stdout;
	if (diff.trim().length === 0) return { error: `nothing to review: no ${describeScope(resolved)}` };
	if (Buffer.byteLength(diff, "utf8") > DIFF_MAX_BYTES) {
		return { error: `diff is ${Math.round(Buffer.byteLength(diff, "utf8") / 1024)} KiB, above the ${DIFF_MAX_BYTES / 1024} KiB review bound; review a smaller range (nub_review with baseRef) or split the change` };
	}
	return { scope: resolved, diff };
}

export function hashDiff(diff: string): string {
	return createHash("sha256").update(diff).digest("hex").slice(0, 16);
}

// --- lens output ------------------------------------------------------------

/** Appended to every lens agent's instructions so the answer is machine-readable. */
export const LENS_OUTPUT_CONTRACT = `## Output contract

Answer with one JSON object and nothing else (no prose, no markdown fence):

{"findings":[{"severity":"BLOCKER|CRITICAL|WARNING|SUGGESTION","location":"path/to/file.ts:12","claim":"what is wrong, as user impact","evidence":"the exact changed lines or behavior that prove it","suggestion":"optional concrete fix"}]}

Report only what the diff introduces or worsens. Use BLOCKER for must-fix-before-merge, CRITICAL for likely production defects, WARNING for real but non-blocking issues, SUGGESTION for optional improvements. If the change is clean for this lens, answer {"findings":[]}.`;

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error("no JSON object in lens output");
		return JSON.parse(trimmed.slice(start, end + 1));
	}
}

function isSeverity(value: unknown): value is Severity {
	return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/** Parses a lens answer; malformed entries are dropped, a malformed envelope throws. */
export function parseLensOutput(lens: ReviewLens, text: string): Finding[] {
	const parsed = extractJsonObject(text);
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { findings?: unknown }).findings)) {
		throw new Error("lens output lacks a findings array");
	}
	const findings: Finding[] = [];
	for (const entry of (parsed as { findings: unknown[] }).findings) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const severity = typeof record.severity === "string" ? record.severity.toUpperCase() : undefined;
		if (!isSeverity(severity) || typeof record.claim !== "string" || record.claim.trim() === "") continue;
		findings.push({
			lens,
			severity,
			location: typeof record.location === "string" && record.location.trim() !== "" ? record.location.trim() : "(unspecified)",
			claim: record.claim.trim(),
			evidence: typeof record.evidence === "string" ? record.evidence.trim() : "",
			...(typeof record.suggestion === "string" && record.suggestion.trim() !== "" ? { suggestion: record.suggestion.trim() } : {}),
		});
	}
	return findings;
}

// --- consolidation ----------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { BLOCKER: 0, CRITICAL: 1, WARNING: 2, SUGGESTION: 3 };

export function computeVerdict(lenses: readonly LensResult[]): Verdict {
	const findings = lenses.flatMap((lens) => lens.findings);
	if (findings.some((finding) => finding.severity === "BLOCKER" || finding.severity === "CRITICAL")) return "block";
	if (lenses.some((lens) => lens.error !== undefined)) return "incomplete";
	return findings.some((finding) => finding.severity === "WARNING") ? "warn" : "approve";
}

const VERDICT_LABEL: Record<Verdict, string> = {
	approve: "APPROVE — no blocking findings",
	warn: "WARN — review the warnings before merging",
	block: "BLOCK — fix the BLOCKER/CRITICAL findings before pushing",
	incomplete: "INCOMPLETE — a lens did not answer; rerun or review that area by hand",
};

export function buildReport(input: { scope: DiffScope; diff: string; lenses: LensResult[]; when?: Date }): ReviewReport {
	const findings = input.lenses.flatMap((lens) => lens.findings).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.location.localeCompare(b.location));
	const verdict = computeVerdict(input.lenses);
	const diffHash = hashDiff(input.diff);
	const when = (input.when ?? new Date()).toISOString();
	const counts = SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const).filter(([, count]) => count > 0);
	const lines: string[] = [
		`# Nub-IA review · ${describeScope(input.scope)}`,
		"",
		`- Verdict: **${VERDICT_LABEL[verdict]}**`,
		`- Diff: ${diffHash} · ${when}`,
		`- Findings: ${counts.length === 0 ? "none" : counts.map(([severity, count]) => `${count} ${severity}`).join(", ")}`,
		`- Lenses: ${input.lenses.map((lens) => `${lens.lens.replace("review-", "")} (${lens.model}${lens.error ? ", failed" : ""})`).join(", ")}`,
		"",
	];
	for (const severity of SEVERITIES) {
		const group = findings.filter((finding) => finding.severity === severity);
		if (group.length === 0) continue;
		lines.push(`## ${severity}`, "");
		for (const finding of group) {
			lines.push(`### ${finding.location} — ${finding.claim}`, `- Lens: ${finding.lens.replace("review-", "")}`);
			if (finding.evidence) lines.push(`- Evidence: ${finding.evidence}`);
			if (finding.suggestion) lines.push(`- Suggestion: ${finding.suggestion}`);
			lines.push("");
		}
	}
	const failed = input.lenses.filter((lens) => lens.error !== undefined);
	if (failed.length > 0) {
		lines.push("## Lens failures", "");
		for (const lens of failed) {
			lines.push(`- ${lens.lens}: ${lens.error}${lens.rawExcerpt ? ` — output started: ${JSON.stringify(lens.rawExcerpt)}` : ""}`);
		}
		lines.push("");
	}
	return { diffHash, scope: describeScope(input.scope), verdict, findings, lenses: input.lenses, markdown: lines.join("\n") };
}

/** One-paragraph summary for the tool result / notification. */
export function summarizeReport(report: ReviewReport, reportPath?: string): string {
	const head = `${VERDICT_LABEL[report.verdict]} (${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} across ${report.lenses.length} lenses, diff ${report.diffHash})`;
	const top = report.findings.slice(0, 5).map((finding) => `- [${finding.severity}] ${finding.location}: ${finding.claim}`);
	return [head, ...top, ...(report.findings.length > 5 ? [`- …and ${report.findings.length - 5} more`] : []), ...(reportPath ? [`Full report: ${reportPath}`] : [])].join("\n");
}

// --- push gate ----------------------------------------------------------------

export interface LastReview {
	diffHash: string;
	verdict: Verdict;
	reportPath: string;
	when: string;
}

export function isGitPush(command: string): boolean {
	// `git [global options] push …` at the start of any shell segment; global
	// options cover -C <dir>, -c key=val, --git-dir=…, --no-pager, and the like.
	return /(^|[;&|]\s*|\bsh -c\s+['"])\s*git(?:\s+(?:-[Cc]\s+\S+|--?[a-z-]+(?:=\S+)?))*\s+push\b/.test(command);
}

/**
 * What the push gate should do: `undefined` lets the push through, a string
 * is the question to confirm. `currentHash` is the hash of the diff the push
 * would deliver (base..HEAD), `last` the most recent review on record.
 */
export function pushGateQuestion(last: LastReview | undefined, currentHash: string | undefined): string | undefined {
	if (currentHash === undefined) return undefined; // nothing to deliver, or not a repository
	if (last === undefined) return "No Nub-IA review on record for these changes. Push anyway? (run nub_review first to review them)";
	if (last.diffHash !== currentHash) return `The last Nub-IA review (${last.verdict}, ${last.when}) covered a different diff. Push the unreviewed changes anyway?`;
	if (last.verdict === "block") return `The Nub-IA review of these changes found BLOCKER/CRITICAL findings (${last.reportPath}). Push anyway?`;
	if (last.verdict === "incomplete") return `The Nub-IA review of these changes was incomplete (a lens failed). Push anyway?`;
	return undefined;
}
