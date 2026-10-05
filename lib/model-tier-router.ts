// Nub-IA model tier router: pure selection logic shared by the virtual-model
// extension (extensions/nub-ia-router.ts) and its tests. No Pi imports, no I/O.
//
// A tier ("strong", "strong-alt", "balanced", "fast") names a capability/cost
// band instead of one physical model. The catalog (assets/model-tiers.json)
// maps each tier to ordered regex patterns over `provider/id`, and lists the
// team's provider priority. Selection walks providers in priority order
// (optionally starting from a preferred provider, to keep prompt caches
// warm), and within a provider walks the tier patterns in order (so, e.g.,
// Claude is preferred over GPT on GitHub Copilot). Among the models one
// pattern matches, the newest version wins, then the cheapest output price.

export const MODEL_TIERS = ["strong", "strong-alt", "balanced", "fast"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function isModelTier(value: unknown): value is ModelTier {
	return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

/** The subset of a Pi catalog model the router needs. */
export interface CatalogModel {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
	cost?: { input?: number; output?: number };
}

export interface TierCatalog {
	/** Providers in preference order. Providers not listed come last, alphabetically. */
	providerPriority: readonly string[];
	/** Ordered regex sources matched against `provider/id` (case-insensitive). */
	tiers: Record<ModelTier, readonly string[]>;
}

export interface SelectModelOptions {
	/** Try this provider first, before the catalog's priority order. */
	preferredProvider?: string;
	/** Providers to skip entirely (for example, one that just failed). */
	excludedProviders?: readonly string[];
}

/** Pi's own virtual models never qualify as physical routing targets. */
export const VIRTUAL_MODEL_API = "pi-virtual";

export function physicalModels(models: readonly CatalogModel[]): CatalogModel[] {
	return models.filter((model) => model.api !== VIRTUAL_MODEL_API);
}

/** Numeric sequence of a model id, for "newest version first" ordering. */
export function versionKey(id: string): number[] {
	// Drop date stamps such as 20251001 so "haiku-4-5-20251001-v1:0" compares as [4, 5, 1, 0].
	return (id.match(/\d+/g) ?? []).map(Number).filter((n) => n < 10000);
}

function compareVersionDesc(a: string, b: string): number {
	const av = versionKey(a);
	const bv = versionKey(b);
	for (let i = 0; i < Math.max(av.length, bv.length); i++) {
		const diff = (bv[i] ?? -1) - (av[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

function outputCost(model: CatalogModel): number {
	const cost = model.cost?.output;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

/** Newest version first, then cheapest output, then stable by id. */
export function rankCandidates(models: readonly CatalogModel[]): CatalogModel[] {
	return [...models].sort((a, b) => compareVersionDesc(a.id, b.id) || outputCost(a) - outputCost(b) || a.id.localeCompare(b.id));
}

export function orderedProviders(available: readonly CatalogModel[], catalog: TierCatalog, options: SelectModelOptions = {}): string[] {
	const excluded = new Set(options.excludedProviders ?? []);
	const present = new Set(available.map((model) => model.provider));
	const ordered: string[] = [];
	const push = (provider: string | undefined) => {
		if (provider === undefined || excluded.has(provider) || !present.has(provider) || ordered.includes(provider)) return;
		ordered.push(provider);
	};
	push(options.preferredProvider);
	for (const provider of catalog.providerPriority) push(provider);
	for (const provider of [...present].sort()) push(provider);
	return ordered;
}

function compilePatterns(sources: readonly string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const source of sources) {
		try {
			compiled.push(new RegExp(source, "i"));
		} catch {
			// A malformed pattern in the catalog is skipped rather than taking the router down.
		}
	}
	return compiled;
}

/**
 * The physical model a tier resolves to, or undefined when no available model
 * matches any of the tier's patterns.
 */
export function selectModel(tier: ModelTier, available: readonly CatalogModel[], catalog: TierCatalog, options: SelectModelOptions = {}): CatalogModel | undefined {
	const physical = physicalModels(available);
	const patterns = compilePatterns(catalog.tiers[tier] ?? []);
	for (const provider of orderedProviders(physical, catalog, options)) {
		const ofProvider = physical.filter((model) => model.provider === provider);
		for (const pattern of patterns) {
			const matches = ofProvider.filter((model) => pattern.test(`${model.provider}/${model.id}`));
			if (matches.length > 0) return rankCandidates(matches)[0];
		}
	}
	return undefined;
}

/**
 * Last resort when no tier pattern matches anything: the cheapest reasoning
 * model of the first provider in order, so a request still gets answered.
 */
export function fallbackModel(available: readonly CatalogModel[], catalog: TierCatalog, options: SelectModelOptions = {}): CatalogModel | undefined {
	const physical = physicalModels(available);
	for (const provider of orderedProviders(physical, catalog, options)) {
		const ofProvider = physical.filter((model) => model.provider === provider);
		const reasoning = ofProvider.filter((model) => model.reasoning === true);
		const pool = reasoning.length > 0 ? reasoning : ofProvider;
		if (pool.length > 0) return [...pool].sort((a, b) => outputCost(a) - outputCost(b) || a.id.localeCompare(b.id))[0];
	}
	return undefined;
}

/**
 * Whether a failed request's error looks like a provider-side problem
 * (overload, rate limit, outage, auth) that another provider could avoid,
 * as opposed to a request-side problem (context overflow, bad input) where
 * switching providers would not help.
 */
export function isProviderFailure(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	if (/context|too many tokens|maximum.*tokens|prompt is too long|invalid request|400/i.test(errorMessage) && !/429|rate/i.test(errorMessage)) return false;
	return /overloaded|rate.?limit|too many requests|\b429\b|\b5\d\d\b|quota|capacity|unavailable|temporarily|timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|\b401\b|\b403\b|unauthori[sz]ed|forbidden|credential|expired/i.test(errorMessage);
}

export interface RouterState {
	/** Providers that failed on this session branch; skipped until the branch ends. */
	excludedProviders: string[];
}

export interface RouteDecision {
	model: CatalogModel | undefined;
	state: RouterState | undefined;
	/** Human-readable reason, for diagnostics. */
	why: string;
}

export interface RouteInput {
	tier: ModelTier;
	reason: "user" | "continuation" | "retry" | "direct";
	available: readonly CatalogModel[];
	catalog: TierCatalog;
	previous?: CatalogModel;
	failed?: { model: CatalogModel; errorMessage?: string };
	state?: RouterState;
}

/**
 * Pure routing decision for one request. Mirrors Pi's guidance: continuations
 * and non-provider retries stay on the model that handled the turn (prompt
 * cache, thinking signatures); a provider failure excludes that provider for
 * the branch and re-selects the tier elsewhere; a fresh user turn prefers the
 * provider already in use so caches stay warm.
 */
export function decideRoute(input: RouteInput): RouteDecision {
	const physical = physicalModels(input.available);
	const state = input.state;
	const excluded = new Set(state?.excludedProviders ?? []);
	const stillAvailable = (model: CatalogModel | undefined) =>
		model !== undefined && !excluded.has(model.provider) && physical.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);

	if (input.reason === "retry" && input.failed) {
		if (isProviderFailure(input.failed.errorMessage)) {
			const nextExcluded = [...excluded, input.failed.model.provider].filter((provider, index, all) => all.indexOf(provider) === index);
			const nextState: RouterState = { excludedProviders: nextExcluded };
			const options: SelectModelOptions = { excludedProviders: nextExcluded };
			const model = selectModel(input.tier, physical, input.catalog, options) ?? fallbackModel(physical, input.catalog, options);
			return { model, state: nextState, why: `provider ${input.failed.model.provider} failed; failing over` };
		}
		if (stillAvailable(input.failed.model)) return { model: input.failed.model, state, why: "retry on the same model" };
	}

	if (input.reason === "continuation" && stillAvailable(input.previous)) {
		return { model: input.previous, state, why: "continuation stays on the turn's model" };
	}

	const options: SelectModelOptions = {
		preferredProvider: stillAvailable(input.previous) ? input.previous?.provider : undefined,
		excludedProviders: [...excluded],
	};
	const model = selectModel(input.tier, physical, input.catalog, options) ?? fallbackModel(physical, input.catalog, options);
	return { model, state, why: model ? `tier ${input.tier} → ${model.provider}/${model.id}` : `no available model for tier ${input.tier}` };
}

/** Validates a parsed catalog file; returns undefined when its shape is unusable. */
export function parseTierCatalog(value: unknown): TierCatalog | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const priority = Array.isArray(record.providerPriority) ? record.providerPriority.filter((entry): entry is string => typeof entry === "string") : [];
	const tiersRaw = typeof record.tiers === "object" && record.tiers !== null && !Array.isArray(record.tiers) ? (record.tiers as Record<string, unknown>) : undefined;
	if (!tiersRaw) return undefined;
	const tiers = {} as Record<ModelTier, readonly string[]>;
	for (const tier of MODEL_TIERS) {
		const sources = tiersRaw[tier];
		if (!Array.isArray(sources)) return undefined;
		tiers[tier] = sources.filter((entry): entry is string => typeof entry === "string");
	}
	return { providerPriority: priority, tiers };
}
