// Review calibration (roadmap T1.7): what the local review metrics say about
// each lens, and how the packaged fixtures fare against the real models. Pure
// helpers; the review extension owns the I/O and the `/nubia:review stats|eval`
// commands.

import type { ReviewFindingRow, ReviewMetricRow, ReviewVerdictRow } from "./nub-review-metrics.ts";
import { REVIEW_LENSES, type ReviewLens, SEVERITIES, type Severity } from "./nub-review.ts";

export interface LensCalibration {
	lens: ReviewLens;
	runs: number;
	failed: number;
	findings: Record<Severity, number>;
	dropped: number;
	/** Mean wall-clock per run over the runs that measured it; null when none did. */
	meanDurationMs: number | null;
	/** Distinct normalised models that answered for this lens. */
	models: string[];
}

export interface ReviewCalibration {
	reviews: number;
	verdicts: Record<"approve" | "warn" | "block" | "incomplete", number>;
	lenses: LensCalibration[];
	/** Rows that were not valid review metric rows (schema drift, corruption). */
	skipped: number;
}

const isVerdictRow = (row: unknown): row is ReviewVerdictRow => typeof row === "object" && row !== null && (row as { kind?: unknown }).kind === "verdict" && Array.isArray((row as { lenses?: unknown }).lenses);
const isFindingRow = (row: unknown): row is ReviewFindingRow => typeof row === "object" && row !== null && (row as { kind?: unknown }).kind === "finding" && typeof (row as { lens?: unknown }).lens === "string";

/** Parses JSONL text leniently: a bad line is counted, never fatal. */
export function parseMetricRows(text: string): { rows: ReviewMetricRow[]; skipped: number } {
	const rows: ReviewMetricRow[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (isVerdictRow(parsed) || isFindingRow(parsed)) rows.push(parsed);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { rows, skipped };
}

export function calibrate(rows: readonly ReviewMetricRow[], skipped = 0): ReviewCalibration {
	const verdicts = { approve: 0, warn: 0, block: 0, incomplete: 0 };
	const perLens = new Map<ReviewLens, { runs: number; failed: number; findings: Record<Severity, number>; dropped: number; durations: number[]; models: Set<string> }>();
	const bucket = (lens: ReviewLens) => {
		let entry = perLens.get(lens);
		if (!entry) {
			entry = { runs: 0, failed: 0, findings: Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>, dropped: 0, durations: [], models: new Set() };
			perLens.set(lens, entry);
		}
		return entry;
	};
	let reviews = 0;
	for (const row of rows) {
		if (row.kind === "verdict") {
			reviews += 1;
			if (row.verdict in verdicts) verdicts[row.verdict] += 1;
			for (const lens of row.lenses) {
				if (!(REVIEW_LENSES as readonly string[]).includes(lens.lens)) continue;
				const entry = bucket(lens.lens);
				entry.runs += 1;
				if (lens.outcome === "failed") entry.failed += 1;
				entry.dropped += lens.dropped;
				if (typeof lens.durationMs === "number") entry.durations.push(lens.durationMs);
				if (lens.model.id !== "unknown") entry.models.add(`${lens.model.provider}/${lens.model.id}`);
			}
		} else if ((REVIEW_LENSES as readonly string[]).includes(row.lens) && (SEVERITIES as readonly string[]).includes(row.severity)) {
			bucket(row.lens).findings[row.severity] += 1;
		}
	}
	const lenses = REVIEW_LENSES.filter((lens) => perLens.has(lens)).map((lens) => {
		const entry = perLens.get(lens)!;
		return {
			lens,
			runs: entry.runs,
			failed: entry.failed,
			findings: entry.findings,
			dropped: entry.dropped,
			meanDurationMs: entry.durations.length ? Math.round(entry.durations.reduce((a, b) => a + b, 0) / entry.durations.length) : null,
			models: [...entry.models].sort(),
		};
	});
	return { reviews, verdicts, lenses, skipped };
}

const pct = (part: number, whole: number): string => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);

/** Compact human report for `/nubia:review stats`. */
export function renderCalibration(calibration: ReviewCalibration, source: string): string {
	if (calibration.reviews === 0) return `No review metrics yet in ${source}. Run /nubia:review a few times first.`;
	const v = calibration.verdicts;
	const lines = [
		`Nub-IA review calibration · ${calibration.reviews} review${calibration.reviews === 1 ? "" : "s"} in ${source}`,
		`Verdicts: ${v.approve} approve · ${v.warn} warn · ${v.block} block · ${v.incomplete} incomplete`,
		"",
	];
	for (const lens of calibration.lenses) {
		const total = SEVERITIES.reduce((sum, severity) => sum + lens.findings[severity], 0);
		lines.push(
			`${lens.lens.replace("review-", "").padEnd(12)} runs ${String(lens.runs).padStart(3)} · failed ${pct(lens.failed, lens.runs)} · findings/run ${lens.runs ? (total / lens.runs).toFixed(1) : "–"} (${SEVERITIES.map((severity) => `${lens.findings[severity]} ${severity[0]}`).join(" ")}) · dropped ${lens.dropped} · mean ${lens.meanDurationMs === null ? "–" : `${Math.round(lens.meanDurationMs / 1000)}s`}${lens.models.length ? ` · ${lens.models.join(", ")}` : ""}`,
		);
	}
	const noisy = calibration.lenses.filter((lens) => lens.runs >= 5 && (lens.findings.BLOCKER + lens.findings.CRITICAL) / lens.runs > 1.5).map((lens) => lens.lens);
	const flaky = calibration.lenses.filter((lens) => lens.runs >= 5 && lens.failed / lens.runs > 0.2).map((lens) => lens.lens);
	if (noisy.length) lines.push("", `Possibly over-severe (> 1.5 BLOCKER/CRITICAL per run): ${noisy.join(", ")} — check their findings before tightening the gate.`);
	if (flaky.length) lines.push("", `Failing often (> 20% of runs): ${flaky.join(", ")} — look at provider availability or the tier routing.`);
	if (calibration.skipped) lines.push("", `(${calibration.skipped} unreadable row${calibration.skipped === 1 ? "" : "s"} skipped)`);
	return lines.join("\n");
}
