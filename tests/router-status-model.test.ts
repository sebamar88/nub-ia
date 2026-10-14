// Router block of the Status card (roadmap T2.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTER_STATUS_EVENT, RouterJournal, classifyCause, parseRouterStatus, routerStatusLines } from "../lib/router-status-model.ts";

const model = (provider: string, id: string) => ({ provider, id, name: id, api: "x", contextWindow: 1, inputPrice: 0, outputPrice: 0 });
const NOW = 10 * 60_000;

test("classifyCause: one word per failure family, never the raw text", () => {
	assert.equal(classifyCause("HTTP 429 Too Many Requests: slow down user@corp.com"), "rate limit");
	assert.equal(classifyCause("overloaded_error"), "overloaded");
	assert.equal(classifyCause("502 Bad Gateway"), "server error");
	assert.equal(classifyCause("request timed out"), "timeout");
	assert.equal(classifyCause("401 unauthorized"), "auth");
	assert.equal(classifyCause("ECONNRESET"), "network");
	assert.equal(classifyCause(undefined), "provider failure");
});

test("RouterJournal: remembers the last model per tier, exclusions with cause and time, and unroutable tiers; reset clears", () => {
	const journal = new RouterJournal();
	journal.record("balanced", { model: model("github-copilot", "claude-sonnet-5.5"), state: undefined, why: "" }, undefined, NOW - 120_000);
	journal.record("balanced", { model: model("amazon-bedrock", "us.anthropic.claude-sonnet-5-5"), state: { excludedProviders: ["github-copilot"] }, why: "" }, { provider: "github-copilot", errorMessage: "429 rate limited" }, NOW - 60_000);
	journal.record("strong", { model: undefined, state: { excludedProviders: ["github-copilot"] }, why: "" }, undefined, NOW);
	const payload = journal.payload();
	assert.deepEqual(payload.resolved, { balanced: "amazon-bedrock/us.anthropic.claude-sonnet-5-5" });
	assert.deepEqual(payload.excluded, [{ provider: "github-copilot", cause: "rate limit", at: NOW - 60_000 }]);
	assert.deepEqual(payload.unroutable, ["strong"]);
	// A later decision whose state no longer excludes the provider (new branch) drops it.
	journal.record("strong", { model: model("github-copilot", "claude-opus-5.5"), state: { excludedProviders: [] }, why: "" }, undefined, NOW);
	assert.deepEqual(journal.payload().excluded, []);
	assert.deepEqual(journal.payload().unroutable, []);
	journal.reset();
	assert.deepEqual(journal.payload(), { schema: ROUTER_STATUS_EVENT, resolved: {}, excluded: [], unroutable: [] });
});

test("parseRouterStatus: round-trips its own payload and rejects off-shape input", () => {
	const journal = new RouterJournal();
	journal.record("fast", { model: model("openai", "gpt-6-luna"), state: { excludedProviders: ["nvidia"] }, why: "" }, { provider: "nvidia", errorMessage: "503" }, NOW);
	const payload = journal.payload();
	assert.deepEqual(parseRouterStatus(JSON.parse(JSON.stringify(payload))), payload);
	assert.equal(parseRouterStatus({ ...payload, schema: "x" }), undefined);
	assert.equal(parseRouterStatus({ ...payload, resolved: { nope: "a/b" } }), undefined);
	assert.equal(parseRouterStatus({ ...payload, excluded: [{ provider: "p" }] }), undefined);
	assert.equal(parseRouterStatus({ ...payload, unroutable: ["huge"] }), undefined);
});

test("routerStatusLines: headline and tone follow unroutable > excluded > routed; items list tiers then exclusions", () => {
	assert.deepEqual(routerStatusLines(undefined, NOW), { headline: "No tier routed yet", tone: "none", items: [] });
	const journal = new RouterJournal();
	journal.record("balanced", { model: model("github-copilot", "claude-sonnet-5.5"), state: undefined, why: "" }, undefined, NOW);
	assert.deepEqual(routerStatusLines(journal.payload(), NOW), { headline: "1 tier routed", tone: "ok", items: ["balanced → github-copilot/claude-sonnet-5.5"] });
	journal.record("strong", { model: model("amazon-bedrock", "us.anthropic.claude-opus-5-5"), state: { excludedProviders: ["github-copilot"] }, why: "" }, { provider: "github-copilot", errorMessage: "overloaded" }, NOW - 3 * 60_000);
	const lines = routerStatusLines(journal.payload(), NOW);
	assert.equal(lines.headline, "1 provider excluded this session");
	assert.equal(lines.tone, "warn");
	assert.deepEqual(lines.items, ["strong → amazon-bedrock/us.anthropic.claude-opus-5-5", "balanced → github-copilot/claude-sonnet-5.5", "excluded github-copilot · overloaded · 3 min ago"]);
	journal.record("fast", { model: undefined, state: { excludedProviders: ["github-copilot"] }, why: "" }, undefined, NOW);
	const bad = routerStatusLines(journal.payload(), NOW);
	assert.equal(bad.headline, "1 tier unroutable");
	assert.equal(bad.tone, "bad");
	assert.ok(bad.items.includes("fast → no model available"));
});
