import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type CatalogModel,
	MODEL_TIERS,
	decideRoute,
	fallbackModel,
	isProviderFailure,
	orderedProviders,
	parseTierCatalog,
	rankCandidates,
	selectModel,
	versionKey,
} from "../lib/model-tier-router.ts";

const catalog = parseTierCatalog(JSON.parse(readFileSync(new URL("../assets/model-tiers.json", import.meta.url), "utf8")))!;

const m = (provider: string, id: string, output = 10): CatalogModel => ({ provider, id, reasoning: true, cost: { output } });

const copilot = [
	m("github-copilot", "claude-haiku-4.5", 5), m("github-copilot", "claude-opus-5", 25), m("github-copilot", "claude-opus-5.5", 20),
	m("github-copilot", "claude-sonnet-5", 10), m("github-copilot", "claude-sonnet-5.5", 10), m("github-copilot", "gpt-5-mini", 2),
	m("github-copilot", "gpt-5.5", 30), m("github-copilot", "gpt-6-astra", 50), m("github-copilot", "gpt-6-luna", 0.5),
	m("github-copilot", "gpt-6-sol", 10), m("github-copilot", "gpt-6.1-sol", 10), m("github-copilot", "grok-4.7", 6),
];
const bedrock = [
	m("amazon-bedrock", "anthropic.claude-opus-5-5", 20), m("amazon-bedrock", "us.anthropic.claude-opus-5-5", 22), m("amazon-bedrock", "global.anthropic.claude-opus-5-5", 20),
	m("amazon-bedrock", "eu.anthropic.claude-opus-5-5", 20), m("amazon-bedrock", "us.anthropic.claude-opus-4-8", 27.5), m("amazon-bedrock", "us.anthropic.claude-fable-5-1", 55),
	m("amazon-bedrock", "us.anthropic.claude-sonnet-5-5", 11), m("amazon-bedrock", "us.anthropic.claude-sonnet-5", 11),
	m("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", 5.5), m("amazon-bedrock", "amazon.nova-pro-v1:0", 3), m("amazon-bedrock", "global.openai.gpt-6-astra", 50),
];
const codex = [
	m("openai-codex", "gpt-5.5", 30), m("openai-codex", "gpt-5.6-luna", 1.2), m("openai-codex", "gpt-5.6-terra", 12),
	m("openai-codex", "gpt-6-astra", 50), m("openai-codex", "gpt-6-luna", 0.5), m("openai-codex", "gpt-6-sol", 10), m("openai-codex", "gpt-6.1-sol", 10),
];
const openaiLegacy = [m("openai", "gpt-4o", 10), m("openai", "o3", 8), m("openai", "gpt-5", 10), m("openai", "gpt-5-mini", 2), m("openai", "gpt-5.5", 30), m("openai", "gpt-6.1-sol", 10), m("openai", "gpt-6-luna", 0.5)];
const virtual = { provider: "nub-ia", id: "strong", api: "pi-virtual" } as CatalogModel;

const pick = (tier: (typeof MODEL_TIERS)[number], available: CatalogModel[], options = {}) => {
	const model = selectModel(tier, available, catalog, options);
	return model ? `${model.provider}/${model.id}` : undefined;
};

test("packaged catalog parses with every tier populated", () => {
	for (const tier of MODEL_TIERS) assert.ok(catalog.tiers[tier].length > 0, tier);
	assert.deepEqual(catalog.providerPriority.slice(0, 4), ["github-copilot", "amazon-bedrock", "openai", "openai-codex"]);
	assert.equal(parseTierCatalog({ tiers: { strong: [] } }), undefined, "a catalog missing a tier is rejected");
	assert.equal(parseTierCatalog("nope"), undefined);
});

test("version ordering prefers the newest model and ignores date stamps", () => {
	assert.deepEqual(versionKey("claude-haiku-4-5-20251001-v1:0"), [4, 5, 1, 0]);
	assert.deepEqual(versionKey("gpt-6.1-sol"), [6, 1]);
	const ranked = rankCandidates([m("p", "claude-sonnet-5", 10), m("p", "claude-sonnet-5.5", 10), m("p", "claude-sonnet-4.6", 15)]);
	assert.deepEqual(ranked.map((model) => model.id), ["claude-sonnet-5.5", "claude-sonnet-5", "claude-sonnet-4.6"]);
	const tie = rankCandidates([m("p", "claude-opus-5-5", 22), m("p", "global.claude-opus-5-5", 20)]);
	assert.equal(tie[0].id, "global.claude-opus-5-5", "same version → cheaper output wins");
});

test("Copilot is preferred and Claude beats GPT inside it", () => {
	const all = [...codex, ...bedrock, ...copilot, virtual];
	assert.equal(pick("strong", all), "github-copilot/claude-opus-5.5");
	assert.equal(pick("balanced", all), "github-copilot/claude-sonnet-5.5");
	assert.equal(pick("fast", all), "github-copilot/claude-haiku-4.5");
	assert.equal(pick("strong-alt", all), "github-copilot/gpt-6-astra", "no Fable on Copilot → the alternate strong model is gpt-6-astra, never the same Opus as strong");
});

test("Bedrock alone resolves to us.* Claude inference profiles, newest version first", () => {
	assert.equal(pick("strong", bedrock), "amazon-bedrock/us.anthropic.claude-opus-5-5");
	assert.equal(pick("strong-alt", bedrock), "amazon-bedrock/us.anthropic.claude-fable-5-1");
	assert.equal(pick("balanced", bedrock), "amazon-bedrock/us.anthropic.claude-sonnet-5-5");
	assert.equal(pick("fast", bedrock), "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0");
	assert.equal(pick("strong", bedrock.filter((model) => !model.id.startsWith("us."))), "amazon-bedrock/anthropic.claude-opus-5-5", "bare id before global.*, eu.* never");
});

test("OpenAI providers only use the newest generation, with gpt-5.x as last resort", () => {
	assert.equal(pick("strong", codex), "openai-codex/gpt-6-astra");
	assert.equal(pick("balanced", codex), "openai-codex/gpt-6.1-sol");
	assert.equal(pick("fast", codex), "openai-codex/gpt-6-luna");
	assert.equal(pick("balanced", openaiLegacy), "openai/gpt-6.1-sol", "gpt-4o/o3/gpt-5 never match");
	assert.equal(pick("strong", openaiLegacy), "openai/gpt-5.5", "no gpt-6-astra → gpt-5.5 as the fallback strong");
	assert.equal(pick("fast", codex.filter((model) => !model.id.startsWith("gpt-6"))), "openai-codex/gpt-5.6-luna");
});

test("provider order honours the preferred provider, then priority, then excludes", () => {
	const all = [...codex, ...bedrock, ...copilot];
	assert.deepEqual(orderedProviders(all, catalog), ["github-copilot", "amazon-bedrock", "openai-codex"]);
	assert.deepEqual(orderedProviders(all, catalog, { preferredProvider: "amazon-bedrock" }), ["amazon-bedrock", "github-copilot", "openai-codex"]);
	assert.deepEqual(orderedProviders(all, catalog, { excludedProviders: ["github-copilot"] }), ["amazon-bedrock", "openai-codex"]);
	assert.deepEqual(orderedProviders([m("groq", "llama"), ...copilot], catalog), ["github-copilot", "groq"], "unlisted providers come last");
	assert.equal(pick("strong", all, { preferredProvider: "amazon-bedrock" }), "amazon-bedrock/us.anthropic.claude-opus-5-5");
});

test("virtual models are never routing targets and unknown catalogs fall back to the cheapest reasoning model", () => {
	assert.equal(pick("strong", [virtual]), undefined);
	const groq = [m("groq", "llama-3.1-8b-instant", 0.08), { ...m("groq", "llama-70b", 0.8), reasoning: false }];
	const fallback = fallbackModel([virtual, ...groq], catalog);
	assert.equal(fallback?.id, "llama-3.1-8b-instant");
});

test("provider failures are recognised; request-side errors are not", () => {
	for (const message of ["429 Too Many Requests", "overloaded_error: Overloaded", "503 Service Unavailable", "rate limit exceeded", "ECONNRESET", "401 Unauthorized: token expired"]) {
		assert.ok(isProviderFailure(message), message);
	}
	for (const message of [undefined, "", "prompt is too long: 210000 tokens > 200000 maximum context length", "400 invalid request: unsupported parameter"]) {
		assert.equal(isProviderFailure(message), false, String(message));
	}
});

test("decideRoute: continuation and non-provider retries stay on the turn's model", () => {
	const all = [...codex, ...bedrock, ...copilot];
	const previous = m("amazon-bedrock", "us.anthropic.claude-sonnet-5-5");
	const cont = decideRoute({ tier: "balanced", reason: "continuation", available: all, catalog, previous });
	assert.equal(`${cont.model!.provider}/${cont.model!.id}`, "amazon-bedrock/us.anthropic.claude-sonnet-5-5");
	const overflow = decideRoute({ tier: "balanced", reason: "retry", available: all, catalog, failed: { model: previous, errorMessage: "prompt is too long" } });
	assert.equal(overflow.model!.id, previous.id);
	assert.equal(overflow.state, undefined, "no exclusion recorded");
});

test("decideRoute: a provider failure fails over and the exclusion persists across the branch", () => {
	const all = [...codex, ...bedrock, ...copilot];
	const failed = m("github-copilot", "claude-opus-5.5");
	const first = decideRoute({ tier: "strong", reason: "retry", available: all, catalog, failed: { model: failed, errorMessage: "429 rate limit" } });
	assert.equal(`${first.model!.provider}/${first.model!.id}`, "amazon-bedrock/us.anthropic.claude-opus-5-5");
	assert.deepEqual(first.state, { excludedProviders: ["github-copilot"] });
	const later = decideRoute({ tier: "fast", reason: "user", available: all, catalog, state: first.state });
	assert.equal(later.model!.provider, "amazon-bedrock", "later turns on the branch keep avoiding the failed provider");
	const second = decideRoute({ tier: "strong", reason: "retry", available: all, catalog, state: first.state, failed: { model: first.model!, errorMessage: "503" } });
	assert.deepEqual(second.state, { excludedProviders: ["github-copilot", "amazon-bedrock"] });
	assert.equal(second.model!.provider, "openai-codex");
	const exhausted = decideRoute({ tier: "strong", reason: "retry", available: all, catalog, state: second.state, failed: { model: second.model!, errorMessage: "503" } });
	assert.equal(exhausted.model, undefined, "every provider excluded → nothing to route to");
});

test("decideRoute: a fresh user turn keeps the provider already in use for cache warmth", () => {
	const all = [...codex, ...bedrock, ...copilot];
	const previous = m("openai-codex", "gpt-6.1-sol");
	const turn = decideRoute({ tier: "strong", reason: "user", available: all, catalog, previous });
	assert.equal(`${turn.model!.provider}/${turn.model!.id}`, "openai-codex/gpt-6-astra");
	const fresh = decideRoute({ tier: "strong", reason: "user", available: all, catalog });
	assert.equal(fresh.model!.provider, "github-copilot");
});

test("packaged agents declare nub-ia tiers, two distinct strong models for the judges", () => {
	const read = (name: string) => readFileSync(new URL(`../assets/agents/${name}.md`, import.meta.url), "utf8").match(/^model: (\S+)$/m)?.[1];
	assert.equal(read("review-risk"), "nub-ia/strong");
	assert.equal(read("jd-judge-b"), "nub-ia/strong");
	assert.equal(read("jd-judge-a"), "nub-ia/strong-alt");
	for (const name of ["gentle-ai-explore", "gentle-ai-worker", "gentle-ai-verify", "jd-fix-agent", "review-readability", "review-reliability", "review-resilience"]) {
		assert.equal(read(name), "nub-ia/balanced", name);
	}
});
