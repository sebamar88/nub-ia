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
import { existsSync, readFileSync } from "node:fs";
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
} from "../lib/model-tier-router.ts";

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
	if (project) {
		// Repository content decides which provider receives prompts and code
		// (only providers the user holds credentials for, but still): say so once.
		if (!warnedProjectCatalogs.has(projectPath)) {
			warnedProjectCatalogs.add(projectPath);
			warn(`nub-ia: model routing for this repository comes from ${projectPath} (it overrides the packaged catalog)`);
		}
		return project;
	}
	return readCatalogFile(PACKAGED_CATALOG_PATH) ?? EMPTY_CATALOG;
}

export function toCatalogModel(model: { provider: string; id: string; api?: string; reasoning?: boolean; cost?: { input?: number; output?: number } }): CatalogModel {
	return { provider: model.provider, id: model.id, api: model.api, reasoning: model.reasoning, cost: model.cost };
}

function availableModels(ctx: ExtensionContext): CatalogModel[] {
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
	for (const tier of MODEL_TIERS) {
		pi.registerVirtualModel<RouterState>({
			provider: NUB_IA_PROVIDER,
			id: tier,
			name: TIER_NAMES[tier],
			thinkingLevels: THINKING_LEVELS,
			route(request, ctx) {
				const catalog = loadTierCatalog(ctx.cwd);
				const decision = decideRoute({
					tier,
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
