// Nub-IA model router: registers one Pi virtual model per capability tier
// (nub-ia/strong, nub-ia/strong-alt, nub-ia/balanced, nub-ia/fast). Each
// request made with a tier model is dispatched to a physical model chosen from
// whatever providers have credentials on this machine, following the team's
// catalog in assets/model-tiers.json. Packaged agents declare a tier instead
// of a provider-specific model, so the same agent definitions work for a
// teammate on GitHub Copilot, Amazon Bedrock, OpenAI Codex, or any mix, and a
// provider outage or rate limit fails over to the next provider mid-session.
//
// The selection logic itself lives in lib/model-tier-router.ts (pure, tested);
// this file only wires it to Pi.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CatalogModel,
	MODEL_TIERS,
	type ModelTier,
	type RouterState,
	type TierCatalog,
	decideRoute,
	parseTierCatalog,
	tierDoctorLines,
	modelDenied,
	permittedModels,
	tightestAllowlist,
} from "../lib/model-tier-router.ts";
import { ROUTER_STATUS_EVENT, RouterJournal } from "../lib/router-status-model.ts";
import { type BudgetSpend, budgetState, describeBudget, effectiveTier, readSpendLedger, spendLedgerName, tightestBudget, writeSpendLedger } from "../lib/model-tier-budget.ts";
import { nubIaConfigHome } from "../lib/config-home.ts";
import { loadEffectiveOrgPolicy, orgModelTiersText } from "../lib/org-policy.ts";

export const NUB_IA_PROVIDER = "nub-ia";

const TIER_NAMES: Record<ModelTier, string> = {
	strong: "Nub-IA Strong",
	"strong-alt": "Nub-IA Strong (alt)",
	balanced: "Nub-IA Balanced",
	fast: "Nub-IA Fast",
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGED_CATALOG_PATH = join(PACKAGE_ROOT, "assets", "model-tiers.json");

/** An empty catalog still routes: `fallbackModel` picks something sensible. */
const EMPTY_CATALOG: TierCatalog = { providerPriority: [], tiers: { strong: [], "strong-alt": [], balanced: [], fast: [] } };

function readCatalogFile(path: string): TierCatalog | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseTierCatalog(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

const warnedProjectCatalogs = new Set<string>();

/**
 * The effective catalog: a repository override at `.pi/nub-ia/model-tiers.json`
 * wins over the packaged default, so one team repo can pin a different policy.
 * Because that is repository content, its use is announced once per path.
 */
export function loadTierCatalog(cwd: string, warn: (message: string) => void = (message) => console.warn(message)): TierCatalog {
	const projectPath = join(cwd, ".pi", "nub-ia", "model-tiers.json");
	const project = readCatalogFile(projectPath);
	let packaged = readCatalogFile(PACKAGED_CATALOG_PATH) ?? EMPTY_CATALOG;
	// The organisation policy's modelTiers (allowlist and budget only) tightens the packaged catalog first.
	const orgText = orgModelTiersText(loadEffectiveOrgPolicy(process.env, cwd).policy);
	const org = orgText ? parseTierCatalog(JSON.parse(orgText)) : undefined;
	if (org) {
		const budget = tightestBudget(packaged.budget, org.budget);
		packaged = { ...packaged, ...(budget ? { budget } : {}), ...tightestAllowlist(packaged, org) };
	}
	if (project) {
		// Repository content decides which provider receives prompts and code
		// (only providers the user holds credentials for, but still): say so once.
		if (!warnedProjectCatalogs.has(projectPath)) {
			warnedProjectCatalogs.add(projectPath);
			warn(`nub-ia: model routing for this repository comes from ${projectPath} (it overrides the packaged catalog)`);
		}
		// Routing is replaced; the budget and the allowlist can only get tighter than the team's.
		const budget = tightestBudget(packaged.budget, project.budget);
		return { ...project, ...(budget ? { budget } : {}), ...tightestAllowlist(packaged, project) };
	}
	return packaged;
}

// --- spend tracking (roadmap T2.2) --------------------------------------------------

const SPEND_DIR = (env: NodeJS.ProcessEnv = process.env) => join(nubIaConfigHome(env), "metrics");

function readTodaySpend(now: Date): number {
	try {
		return readSpendLedger(readFileSync(join(SPEND_DIR(), spendLedgerName(now)), "utf8"));
	} catch {
		return 0;
	}
}

function addTodaySpend(usd: number, now: Date): number {
	const total = readTodaySpend(now) + usd;
	try {
		mkdirSync(SPEND_DIR(), { recursive: true });
		writeFileSync(join(SPEND_DIR(), spendLedgerName(now)), writeSpendLedger(total), { encoding: "utf8", mode: 0o600 });
	} catch {
		// Spend tracking is advisory: a read-only home must never break routing.
	}
	return total;
}

export function toCatalogModel(model: { provider: string; id: string; api?: string; reasoning?: boolean; cost?: { input?: number; output?: number } }): CatalogModel {
	return { provider: model.provider, id: model.id, api: model.api, reasoning: model.reasoning, cost: model.cost };
}

/** `/nubia:doctor` lines: tier resolution against the providers signed in right now. */
export function routerDoctorLines(ctx: ExtensionContext): string[] {
	const catalog = loadTierCatalog(ctx.cwd, () => {});
	const lines = tierDoctorLines(availableModels(ctx), catalog);
	if (catalog.allowedProviders) lines.push(`pass: Allowed providers: ${catalog.allowedProviders.join(", ")}`);
	if (catalog.deniedModels?.length) lines.push(`pass: Denied model patterns: ${catalog.deniedModels.join(", ")}`);
	return lines;
}

/** Models the session may use: the registry's, minus what the allowlist excludes. */
function availableModels(ctx: ExtensionContext): CatalogModel[] {
	return permittedModels(rawAvailableModels(ctx), loadTierCatalog(ctx.cwd, () => {}));
}

function rawAvailableModels(ctx: ExtensionContext): CatalogModel[] {
	const registry = ctx.modelRegistry;
	if (!registry) return [];
	try {
		const raw: unknown = registry.getAvailable();
		return Array.isArray(raw) ? (raw as Parameters<typeof toCatalogModel>[0][]).map(toCatalogModel) : [];
	} catch {
		return [];
	}
}

function errorMessageOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as { errorMessage?: unknown; stopReason?: unknown };
	if (typeof record.errorMessage === "string") return record.errorMessage;
	return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

export default function registerNubIaRouter(pi: ExtensionAPI): void {
	// Status card "Router" block: last model per tier, excluded providers and
	// why (lib/router-status-model.ts). Per session; the shell reads the channel.
	const journal = new RouterJournal();
	const publish = () => pi.events.emit(ROUTER_STATUS_EVENT, journal.payload());
	// Spend: Pi prices each assistant message (usage.cost.total); the session
	// total lives here, the day's total in the ledger shared by every session.
	let sessionUsd = 0;
	let warnedBudget: string | undefined;
	const spend = (): BudgetSpend => ({ todayUsd: readTodaySpend(new Date()), sessionUsd });
	pi.on("session_start", () => { journal.reset(); sessionUsd = 0; warnedBudget = undefined; publish(); });
	// /model (or a cycle) onto a denied model: put the session back on the
	// previous permitted model, else the balanced tier, and say why.
	const guardSelection = async (ctx: ExtensionContext, model: { provider: string; id: string }, previous: { provider: string; id: string } | undefined) => {
		if (model.provider === NUB_IA_PROVIDER) return;
		const catalog = loadTierCatalog(ctx.cwd, () => {});
		const reason = modelDenied(model, catalog);
		if (!reason) return;
		const fallback = (previous && !modelDenied(previous, catalog) && previous.provider !== model.provider ? ctx.modelRegistry?.find(previous.provider, previous.id) : undefined) ?? ctx.modelRegistry?.find(NUB_IA_PROVIDER, "balanced");
		if (fallback) await pi.setModel(fallback as never);
		if (ctx.hasUI) ctx.ui.notify(`Model policy: ${reason}; using ${fallback ? `${fallback.provider}/${fallback.id}` : "no model"} instead (see ${PACKAGED_CATALOG_PATH} or .pi/nub-ia/model-tiers.json).`, "warning");
	};
	pi.on("model_select", (event, ctx) => { void guardSelection(ctx, event.model, event.previousModel); });
	pi.on("message_end", (event, ctx) => {
		const message = (event as { message?: { role?: unknown; usage?: { cost?: { total?: unknown } } } }).message;
		const cost = message?.role === "assistant" ? message.usage?.cost?.total : undefined;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return;
		sessionUsd += cost;
		const today = addTodaySpend(cost, new Date());
		const policy = loadTierCatalog(ctx.cwd).budget;
		if (!policy) return;
		const current = { todayUsd: today, sessionUsd };
		const state = budgetState(policy, current);
		journal.budget(describeBudget(policy, current, state), state.exceeded !== undefined);
		publish();
		// One notice per crossed limit per session; the Status card keeps the line.
		if (state.exceeded && warnedBudget !== state.exceeded && ctx.hasUI) {
			warnedBudget = state.exceeded;
			ctx.ui.notify(`Nub-IA ${describeBudget(policy, current, state)}. Edit the budget in ${PACKAGED_CATALOG_PATH} (or .pi/nub-ia/model-tiers.json).`, "warning");
		}
	});
	for (const tier of MODEL_TIERS) {
		pi.registerVirtualModel<RouterState>({
			provider: NUB_IA_PROVIDER,
			id: tier,
			name: TIER_NAMES[tier],
			thinkingLevels: THINKING_LEVELS,
			route(request, ctx) {
				const catalog = loadTierCatalog(ctx.cwd);
				// Over budget with onExceed=degrade: route one tier down. Continuations
				// are untouched by decideRoute anyway (they stay on the turn's model).
				const routed = effectiveTier(tier, budgetState(catalog.budget, spend()));
				const decision = decideRoute({
					tier: routed.tier,
					reason: request.reason,
					available: availableModels(ctx),
					catalog,
					previous: request.previous ? toCatalogModel(request.previous.model) : undefined,
					failed: request.failed ? { model: toCatalogModel(request.failed.model), errorMessage: errorMessageOf(request.failed.message) } : undefined,
					state: request.state,
				});
				if (process.env.NUB_IA_ROUTER_DEBUG) {
					const available = availableModels(ctx);
					console.error(`[nub-ia-router] ${tier} reason=${request.reason} previous=${request.previous ? `${request.previous.model.provider}/${request.previous.model.id}` : "-"} failed=${request.failed ? `${request.failed.model.provider}/${request.failed.model.id}` : "-"} providers=${[...new Set(available.map((m) => m.provider))].join(",")} → ${decision.why}`);
				}
				journal.record(tier, decision, request.failed ? { provider: request.failed.model.provider, errorMessage: errorMessageOf(request.failed.message) } : undefined, Date.now(), routed.degraded ? routed.tier : undefined);
				publish();
				if (!decision.model) {
					throw new Error(`nub-ia/${tier}: no provider with credentials offers a model for this tier. Run /login, or edit ${PACKAGED_CATALOG_PATH}.`);
				}
				const physical = ctx.modelRegistry?.find(decision.model.provider, decision.model.id);
				if (!physical) throw new Error(`nub-ia/${tier}: ${decision.model.provider}/${decision.model.id} disappeared from the catalog.`);
				return { model: physical, thinkingLevel: request.thinkingLevel, state: decision.state };
			},
		});
	}
}
