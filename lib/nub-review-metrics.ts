// Review metrics (roadmap T0.2): the rows the 4R review appends to the local
// `<configHome>/metrics/review-<YYYY-MM>.jsonl` sink after each run. Pure.
//
// What is recorded is what calibration needs (which lens, on which model,
// found how much of what, how fast) and nothing that identifies the code:
// no paths, no claims, no evidence, no diff. The diff hash only lets rows of
// one run be grouped, and lets a later run of the same diff be recognised.
// Schema: lib/nub-review-metrics-schema.json.

import { normalizeRuntimeModel } from "./runtime-metrics.ts";
import { type LensResult, type ReviewLens, type ReviewReport, SEVERITIES, type Severity, type Verdict } from "./nub-review.ts";

export const REVIEW_METRICS_SCHEMA = "nub-ia.review-metrics/v1";

export interface ReviewMetricModel {
	provider: string;
	id: string;
}

export interface ReviewVerdictRow {
	schema: typeof REVIEW_METRICS_SCHEMA;
	kind: "verdict";
	at: string;
	diffHash: string;
	/** "staged" | "working" | "base" — never the ref itself. */
	scope: "staged" | "working" | "base";
	verdict: Verdict;
	diffBytes: number;
	durationMs: number | null;
	findings: Record<Severity, number>;
	lenses: Array<{
		lens: ReviewLens;
		model: ReviewMetricModel;
		outcome: "ok" | "failed";
		findings: number;
		dropped: number;
		durationMs: number | null;
	}>;
}

export interface ReviewFindingRow {
	schema: typeof REVIEW_METRICS_SCHEMA;
	kind: "finding";
	at: string;
	diffHash: string;
	lens: ReviewLens;
	severity: Severity;
	model: ReviewMetricModel;
	/** Whether the lens pointed at a file; the path itself is never recorded. */
	located: boolean;
	hasSuggestion: boolean;
}

export type ReviewMetricRow = ReviewVerdictRow | ReviewFindingRow;

export interface ReviewMetricsInput {
	report: ReviewReport;
	scopeKind: "staged" | "working" | "base";
	diffBytes: number;
	when: Date;
	/** Wall-clock time of the whole run (lenses in parallel), when measured. */
	durationMs?: number;
	/** Per-lens wall-clock time, when measured. */
	lensDurationsMs?: Partial<Record<ReviewLens, number>>;
}

/** "provider/id" as LensResult.model carries it, normalised like runtime rows. */
export function reviewMetricModel(label: string): ReviewMetricModel {
	const slash = label.indexOf("/");
	if (slash <= 0) return normalizeRuntimeModel(undefined, undefined);
	return normalizeRuntimeModel(label.slice(0, slash), label.slice(slash + 1));
}

const round = (value: number | undefined): number | null => (value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.round(value)));

function lensRow(lens: LensResult, durationMs: number | undefined): ReviewVerdictRow["lenses"][number] {
	return {
		lens: lens.lens,
		model: reviewMetricModel(lens.model),
		outcome: lens.error === undefined ? "ok" : "failed",
		findings: lens.findings.length,
		dropped: lens.dropped ?? 0,
		durationMs: round(durationMs),
	};
}

/** One verdict row followed by one row per finding, in report order. */
export function reviewMetricRows(input: ReviewMetricsInput): ReviewMetricRow[] {
	const at = input.when.toISOString();
	const { report } = input;
	const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
	for (const finding of report.findings) counts[finding.severity] += 1;
	const models = new Map(report.lenses.map((lens) => [lens.lens, reviewMetricModel(lens.model)]));
	const verdict: ReviewVerdictRow = {
		schema: REVIEW_METRICS_SCHEMA,
		kind: "verdict",
		at,
		diffHash: report.diffHash,
		scope: input.scopeKind,
		verdict: report.verdict,
		diffBytes: Math.max(0, Math.round(input.diffBytes)),
		durationMs: round(input.durationMs),
		findings: counts,
		lenses: report.lenses.map((lens) => lensRow(lens, input.lensDurationsMs?.[lens.lens])),
	};
	const findings: ReviewFindingRow[] = report.findings.map((finding) => ({
		schema: REVIEW_METRICS_SCHEMA,
		kind: "finding",
		at,
		diffHash: report.diffHash,
		lens: finding.lens,
		severity: finding.severity,
		model: models.get(finding.lens) ?? { provider: "unknown", id: "unknown" },
		located: finding.location !== "(unspecified)",
		hasSuggestion: finding.suggestion !== undefined,
	}));
	return [verdict, ...findings];
}
