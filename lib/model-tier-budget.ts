// Tier budget (roadmap T2.2): an optional spend ceiling in model-tiers.json.
//
//   "budget": { "dailyUsd": 20, "sessionUsd": 5, "onExceed": "degrade" }
//
// Spend is what Pi reports per assistant message (usage.cost.total): the
// session total lives in memory, the daily total in a small per-day ledger
// under <configHome>/metrics/. Once a limit is hit, `warn` only says so and
// `degrade` routes strong/strong-alt → balanced → fast for the rest of the
// day/session. A repository's model-tiers.json can only tighten the packaged
// budget: lower limits, and degrade over warn. Pure helpers; no I/O.

import type { ModelTier } from "./model-tier-router.ts";

export type BudgetAction = "warn" | "degrade";

export interface BudgetPolicy {
	dailyUsd?: number;
	sessionUsd?: number;
	onExceed: BudgetAction;
}

export interface BudgetSpend {
	todayUsd: number;
	sessionUsd: number;
}

export interface BudgetState {
	/** The limit that was crossed first, if any. */
	exceeded?: "daily" | "session";
	/** Spend over limit for the tighter of the two, 0..∞; undefined without limits. */
	ratio?: number;
	degrade: boolean;
}

const money = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

export function parseBudget(value: unknown): BudgetPolicy | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const dailyUsd = money(record.dailyUsd);
	const sessionUsd = money(record.sessionUsd);
	if (dailyUsd === undefined && sessionUsd === undefined) return undefined;
	const onExceed: BudgetAction = record.onExceed === "degrade" ? "degrade" : "warn";
	return { ...(dailyUsd !== undefined ? { dailyUsd } : {}), ...(sessionUsd !== undefined ? { sessionUsd } : {}), onExceed };
}

/** The tighter of two policies: lower limits win, degrade beats warn, and a missing side changes nothing. */
export function tightestBudget(base: BudgetPolicy | undefined, override: BudgetPolicy | undefined): BudgetPolicy | undefined {
	if (!base) return override;
	if (!override) return base;
	const min = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
	const dailyUsd = min(base.dailyUsd, override.dailyUsd);
	const sessionUsd = min(base.sessionUsd, override.sessionUsd);
	return { ...(dailyUsd !== undefined ? { dailyUsd } : {}), ...(sessionUsd !== undefined ? { sessionUsd } : {}), onExceed: base.onExceed === "degrade" || override.onExceed === "degrade" ? "degrade" : "warn" };
}

export function budgetState(policy: BudgetPolicy | undefined, spend: BudgetSpend): BudgetState {
	if (!policy) return { degrade: false };
	const ratios: Array<["daily" | "session", number]> = [];
	if (policy.dailyUsd !== undefined) ratios.push(["daily", spend.todayUsd / policy.dailyUsd]);
	if (policy.sessionUsd !== undefined) ratios.push(["session", spend.sessionUsd / policy.sessionUsd]);
	ratios.sort((a, b) => b[1] - a[1]);
	const [which, ratio] = ratios[0] ?? [undefined, undefined];
	const exceeded = ratio !== undefined && ratio >= 1 ? which : undefined;
	return { ...(exceeded ? { exceeded } : {}), ...(ratio !== undefined ? { ratio } : {}), degrade: exceeded !== undefined && policy.onExceed === "degrade" };
}

/** One step down the ladder; fast stays fast. */
export function degradeTier(tier: ModelTier): ModelTier {
	return tier === "strong" || tier === "strong-alt" ? "balanced" : "fast";
}

export function effectiveTier(tier: ModelTier, state: BudgetState): { tier: ModelTier; degraded: boolean } {
	if (!state.degrade) return { tier, degraded: false };
	const next = degradeTier(tier);
	return { tier: next, degraded: next !== tier };
}

// --- daily ledger (text in, text out; the extension owns the file) ---------------

export function spendLedgerName(date: Date): string {
	return `spend-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}.json`;
}

export function readSpendLedger(text: string | undefined): number {
	if (!text) return 0;
	try {
		const parsed = JSON.parse(text) as { usd?: unknown };
		return money(parsed.usd) ?? 0;
	} catch {
		return 0;
	}
}

export function writeSpendLedger(usd: number): string {
	return `${JSON.stringify({ usd: Math.max(0, Math.round(usd * 1_000_000) / 1_000_000) })}\n`;
}

/** The Status/notice line: "$3.21 / $20 today · $0.80 / $5 session". */
export function describeBudget(policy: BudgetPolicy, spend: BudgetSpend, state: BudgetState): string {
	const usd = (value: number) => `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`;
	const parts = [
		...(policy.dailyUsd !== undefined ? [`${usd(spend.todayUsd)} / ${usd(policy.dailyUsd)} today`] : []),
		...(policy.sessionUsd !== undefined ? [`${usd(spend.sessionUsd)} / ${usd(policy.sessionUsd)} session`] : []),
	];
	const tail = state.exceeded ? (state.degrade ? ` · over ${state.exceeded} budget, routing degraded` : ` · over ${state.exceeded} budget`) : "";
	return `budget ${parts.join(" · ")}${tail}`;
}
