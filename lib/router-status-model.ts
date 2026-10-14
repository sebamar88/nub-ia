// Router state for the Status card (roadmap T2.1). The tier router decides per
// request inside Pi's virtual-model hook; this journal remembers, per session,
// the last physical model each tier resolved to and which providers were
// excluded after a failure (and why), and ships it to the shell over
// `pi.events` like the subagents block does. Pure; the extension owns time.

import { type ModelTier, MODEL_TIERS, type RouteDecision } from "./model-tier-router.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export const ROUTER_STATUS_EVENT = "nubia:router-status/v1";

export interface RouterExclusion {
	provider: string;
	/** Short cause, e.g. "429" or "overloaded"; never the raw error text. */
	cause: string;
	at: number;
}

export interface RouterStatusPayload {
	schema: typeof ROUTER_STATUS_EVENT;
	/** Last physical model per tier that routed in this session, "provider/id". */
	resolved: Partial<Record<ModelTier, string>>;
	excluded: RouterExclusion[];
	/** Tiers that could not find any model the last time they were asked. */
	unroutable: ModelTier[];
}

const CAUSES: Array<[RegExp, string]> = [
	[/\b429\b|rate.?limit|too many requests|quota/i, "rate limit"],
	[/overloaded|capacity|temporarily|unavailable|\b503\b|\b529\b/i, "overloaded"],
	[/\b5\d\d\b/i, "server error"],
	[/timed? ?out/i, "timeout"],
	[/\b401\b|\b403\b|unauthori[sz]ed|forbidden|credential|expired/i, "auth"],
	[/ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i, "network"],
];

/** A one-word cause for the Status card; the error text itself never leaves the router. */
export function classifyCause(errorMessage: string | undefined): string {
	for (const [pattern, cause] of CAUSES) if (errorMessage && pattern.test(errorMessage)) return cause;
	return "provider failure";
}

export class RouterJournal {
	private resolved: Partial<Record<ModelTier, string>> = {};
	private excluded = new Map<string, RouterExclusion>();
	private unroutable = new Set<ModelTier>();

	reset(): void {
		this.resolved = {};
		this.excluded.clear();
		this.unroutable.clear();
	}

	record(tier: ModelTier, decision: RouteDecision, failed: { provider: string; errorMessage?: string } | undefined, now: number): void {
		if (decision.model) {
			this.resolved[tier] = `${decision.model.provider}/${decision.model.id}`;
			this.unroutable.delete(tier);
		} else this.unroutable.add(tier);
		const excludedNow = new Set(decision.state?.excludedProviders ?? []);
		// A provider enters the list when a decision first excludes it; it leaves
		// when a later decision on this session no longer carries it (new branch).
		for (const provider of excludedNow) {
			if (!this.excluded.has(provider)) this.excluded.set(provider, { provider, cause: failed?.provider === provider ? classifyCause(failed.errorMessage) : "provider failure", at: now });
		}
		if (decision.state) for (const provider of [...this.excluded.keys()]) if (!excludedNow.has(provider)) this.excluded.delete(provider);
	}

	payload(): RouterStatusPayload {
		return { schema: ROUTER_STATUS_EVENT, resolved: { ...this.resolved }, excluded: [...this.excluded.values()].sort((a, b) => a.at - b.at), unroutable: MODEL_TIERS.filter((tier) => this.unroutable.has(tier)) };
	}
}

const isTier = (value: unknown): value is ModelTier => typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);

export function parseRouterStatus(value: unknown): RouterStatusPayload | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.schema !== ROUTER_STATUS_EVENT || typeof record.resolved !== "object" || record.resolved === null || !Array.isArray(record.excluded) || !Array.isArray(record.unroutable)) return undefined;
	const resolved: Partial<Record<ModelTier, string>> = {};
	for (const [tier, model] of Object.entries(record.resolved as Record<string, unknown>)) {
		if (!isTier(tier) || typeof model !== "string") return undefined;
		resolved[tier] = sanitizeTerminalText(model).slice(0, 120);
	}
	const excluded: RouterExclusion[] = [];
	for (const entry of record.excluded) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const item = entry as Record<string, unknown>;
		if (typeof item.provider !== "string" || typeof item.cause !== "string" || typeof item.at !== "number" || !Number.isFinite(item.at)) return undefined;
		excluded.push({ provider: sanitizeTerminalText(item.provider).slice(0, 40), cause: sanitizeTerminalText(item.cause).slice(0, 40), at: item.at });
	}
	if (!record.unroutable.every(isTier)) return undefined;
	return { schema: ROUTER_STATUS_EVENT, resolved, excluded, unroutable: record.unroutable };
}

export interface RouterStatusLines {
	headline: string;
	tone: "ok" | "warn" | "bad" | "none";
	items: string[];
}

function ago(at: number, now: number): string {
	const minutes = Math.round(Math.max(0, now - at) / 60_000);
	return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** The Status card "Router" block. `undefined` means no tier routed yet this session. */
export function routerStatusLines(payload: RouterStatusPayload | undefined, now: number): RouterStatusLines {
	const resolved = payload ? MODEL_TIERS.filter((tier) => payload.resolved[tier]) : [];
	if (!payload || (resolved.length === 0 && payload.excluded.length === 0 && payload.unroutable.length === 0)) return { headline: "No tier routed yet", tone: "none", items: [] };
	const items = resolved.map((tier) => `${tier} → ${payload.resolved[tier]}`);
	for (const tier of payload.unroutable) items.push(`${tier} → no model available`);
	for (const exclusion of payload.excluded) items.push(`excluded ${exclusion.provider} · ${exclusion.cause} · ${ago(exclusion.at, now)}`);
	const headline = payload.unroutable.length ? `${payload.unroutable.length} tier${payload.unroutable.length === 1 ? "" : "s"} unroutable` : payload.excluded.length ? `${payload.excluded.length} provider${payload.excluded.length === 1 ? "" : "s"} excluded this session` : `${resolved.length} tier${resolved.length === 1 ? "" : "s"} routed`;
	return { headline, tone: payload.unroutable.length ? "bad" : payload.excluded.length ? "warn" : "ok", items };
}
