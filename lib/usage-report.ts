import { brand } from "./brand.ts";
// Usage report (roadmap T3.2): what the local metrics say about a month, from
// the runtime rows (tokens per agent class, provider and model), the daily
// spend ledgers (USD), the review rows and the audit trail. Pure: text in,
// summary out; the launcher and the shell read the files.

export interface UsageByKey { key: string; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number }

export interface UsageReport {
	month: string;
	runtimeRows: number;
	skipped: number;
	responses: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	byAgentClass: UsageByKey[];
	byModel: UsageByKey[];
	errors: Record<string, number>;
	/** From spend-<date>.json ledgers, in date order. */
	spendByDay: Array<{ date: string; usd: number }>;
	spendUsd: number;
	reviews?: { count: number; verdicts: Record<string, number> };
	audit?: { rows: number; approved: number; denied: number };
}

type TokenCell = { sum?: unknown } | undefined;
const cell = (value: TokenCell): number => (typeof value?.sum === "number" && Number.isFinite(value.sum) ? value.sum : 0);

export function parseRuntimeRows(text: string): { rows: Record<string, unknown>[]; skipped: number } {
	const rows: Record<string, unknown>[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed === "object" && parsed !== null && typeof parsed.tokens === "object") rows.push(parsed);
			else skipped += 1;
		} catch { skipped += 1; }
	}
	return { rows, skipped };
}

function accumulate(map: Map<string, UsageByKey>, key: string, row: Record<string, unknown>): void {
	const tokens = (row.tokens ?? {}) as Record<string, TokenCell>;
	const entry = map.get(key) ?? { key, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	entry.responses += typeof row.responses === "number" ? row.responses : 0;
	entry.input += cell(tokens.input);
	entry.output += cell(tokens.output);
	entry.cacheRead += cell(tokens.cacheRead);
	entry.cacheWrite += cell(tokens.cacheWrite);
	entry.total += cell(tokens.totalTokens);
	map.set(key, entry);
}

export function buildUsageReport(input: {
	month: string;
	runtimeText: string;
	spend: Array<{ date: string; text: string }>;
	reviewText?: string;
	auditText?: string;
}): UsageReport {
	const { rows, skipped } = parseRuntimeRows(input.runtimeText);
	const byAgentClass = new Map<string, UsageByKey>();
	const byModel = new Map<string, UsageByKey>();
	const errors: Record<string, number> = {};
	const totals = { key: "all", responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const all = new Map<string, UsageByKey>([["all", totals]]);
	for (const row of rows) {
		accumulate(all, "all", row);
		accumulate(byAgentClass, String(row.agentClass ?? "unknown"), row);
		const provider = String(row.provider ?? row.selectedProvider ?? "unknown");
		const model = String(row.observedModelId !== "unknown" && row.observedModelId !== "custom" ? row.observedModelId : row.responseModelId !== "unknown" ? row.responseModelId : row.modelFamily ?? "unknown");
		accumulate(byModel, `${provider}/${model}`, row);
		const error = String(row.error ?? "none");
		if (error !== "none") errors[error] = (errors[error] ?? 0) + 1;
	}
	const spendByDay = input.spend
		.map(({ date, text }) => { try { const usd = (JSON.parse(text) as { usd?: unknown }).usd; return { date, usd: typeof usd === "number" && Number.isFinite(usd) ? usd : 0 }; } catch { return { date, usd: 0 }; } })
		.filter((entry) => entry.date.startsWith(input.month))
		.sort((a, b) => a.date.localeCompare(b.date));
	const report: UsageReport = {
		month: input.month,
		runtimeRows: rows.length,
		skipped,
		responses: totals.responses,
		tokens: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, total: totals.total },
		byAgentClass: [...byAgentClass.values()].sort((a, b) => b.total - a.total),
		byModel: [...byModel.values()].sort((a, b) => b.total - a.total),
		errors,
		spendByDay,
		spendUsd: spendByDay.reduce((sum, entry) => sum + entry.usd, 0),
	};
	if (input.reviewText !== undefined) {
		const verdicts: Record<string, number> = {};
		let count = 0;
		for (const line of input.reviewText.split("\n")) {
			if (!line.trim()) continue;
			try { const row = JSON.parse(line) as { kind?: string; verdict?: string }; if (row.kind === "verdict" && row.verdict) { count += 1; verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1; } } catch { /* skip */ }
		}
		report.reviews = { count, verdicts };
	}
	if (input.auditText !== undefined) {
		let total = 0, approved = 0, denied = 0;
		for (const line of input.auditText.split("\n")) {
			if (!line.trim()) continue;
			try { const row = JSON.parse(line) as { outcome?: string }; total += 1; if (row.outcome === "approved") approved += 1; if (row.outcome === "denied" || row.outcome === "blocked") denied += 1; } catch { /* skip */ }
		}
		report.audit = { rows: total, approved, denied };
	}
	return report;
}

const k = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value));
const usd = (value: number): string => `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`;

export function renderUsageReport(report: UsageReport, source: string): string {
	if (report.runtimeRows === 0 && report.spendByDay.length === 0) return `No usage recorded for ${report.month} (${source}).`;
	const lines = [
		`${brand.name} usage · ${report.month} · ${report.responses} response${report.responses === 1 ? "" : "s"} · ${k(report.tokens.total)} tokens (in ${k(report.tokens.input)} · out ${k(report.tokens.output)} · cache read ${k(report.tokens.cacheRead)} · cache write ${k(report.tokens.cacheWrite)})${report.spendByDay.length ? ` · ${usd(report.spendUsd)}` : ""}`,
		"",
	];
	if (report.byAgentClass.length) {
		lines.push("By agent:");
		for (const entry of report.byAgentClass.slice(0, 12)) lines.push(`  ${entry.key.padEnd(18)} ${String(entry.responses).padStart(5)} resp  ${k(entry.total).padStart(8)} tokens`);
	}
	if (report.byModel.length) {
		lines.push("", "By model:");
		for (const entry of report.byModel.slice(0, 12)) lines.push(`  ${entry.key.padEnd(44)} ${String(entry.responses).padStart(5)} resp  ${k(entry.total).padStart(8)} tokens`);
	}
	if (report.spendByDay.length) {
		lines.push("", "Spend by day:");
		for (const entry of report.spendByDay) lines.push(`  ${entry.date}  ${usd(entry.usd)}`);
	}
	if (Object.keys(report.errors).length) lines.push("", `Errors: ${Object.entries(report.errors).map(([kind, count]) => `${kind} ${count}`).join(" · ")}`);
	if (report.reviews) lines.push("", `Reviews: ${report.reviews.count}${report.reviews.count ? ` (${Object.entries(report.reviews.verdicts).map(([verdict, count]) => `${count} ${verdict}`).join(", ")})` : ""}`);
	if (report.audit) lines.push(`Audit: ${report.audit.rows} rows · ${report.audit.approved} approved · ${report.audit.denied} denied/blocked`);
	if (report.skipped) lines.push("", `(${report.skipped} unreadable runtime row${report.skipped === 1 ? "" : "s"} skipped)`);
	lines.push("", `Source: ${source} (local only; NUB_IA_METRICS=off disables collection)`);
	return lines.join("\n");
}
