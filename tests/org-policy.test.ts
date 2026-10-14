// Organisation policy document (roadmap T8.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOrgPolicy, ORG_POLICY_SCHEMA, orgModelTiersText, orgReviewGate, parseOrgPolicy, parseOrgPolicySource, sectionText } from "../lib/org-policy.ts";
import { parsePathPolicy } from "../lib/path-permission-policy.ts";
import { parsePermissionModeLayer, parseDelegationLimits } from "../lib/permission-mode-config.ts";
import { parseAgentToolPolicy } from "../lib/agent-tool-policy.ts";
import { parseTierCatalog } from "../lib/model-tier-router.ts";

const doc = {
	schema: ORG_POLICY_SCHEMA,
	name: "Nubiral",
	fetched: { source: "https://github.com/nubiral/nub-ia-policy.git", commit: "abcdef1234567890", at: "2026-05-21T10:00:00Z" },
	permissionMode: { max: "auto", default: "accept-edits" },
	paths: { deny: [".github/**"] },
	agents: { "nubia-explore": { tools: { write: "deny" } } },
	limits: { maxConcurrentSubagents: 4 },
	reviewGate: "strict",
	modelTiers: { allowedProviders: ["amazon-bedrock"], budget: { dailyUsd: 30, onExceed: "warn" } },
	approvedPackages: ["npm:@dietrichgebert/ponytail"],
	ignored: true,
};

test("parseOrgPolicy: schema-gated, keeps known sections only, carries provenance", () => {
	const policy = parseOrgPolicy(JSON.stringify(doc))!;
	assert.equal(policy.name, "Nubiral");
	assert.deepEqual(Object.keys(policy.sections).sort(), ["agents", "approvedPackages", "limits", "modelTiers", "paths", "permissionMode", "reviewGate"]);
	assert.equal(policy.fetched?.commit, "abcdef1234567890");
	assert.equal(parseOrgPolicy(JSON.stringify({ ...doc, schema: "other" })), undefined);
	assert.equal(parseOrgPolicy("nope"), undefined);
	assert.equal(parseOrgPolicy(undefined), undefined);
});

test("sectionText feeds the existing per-policy parsers unchanged", () => {
	const policy = parseOrgPolicy(JSON.stringify(doc));
	assert.deepEqual(parsePathPolicy(sectionText(policy, "paths")), { deny: [".github/**"], confirm: [] });
	assert.deepEqual(parsePermissionModeLayer(sectionText(policy, "permissionMode")), { max: "auto", default: "accept-edits" });
	assert.deepEqual(parseDelegationLimits(sectionText(policy, "limits")), { maxConcurrentSubagents: 4 });
	assert.deepEqual(parseAgentToolPolicy(sectionText(policy, "agents")), [{ agent: "nubia-explore", tools: { write: "deny" } }]);
	assert.equal(sectionText(policy, "roles"), undefined);
	assert.equal(sectionText(undefined, "paths"), undefined);
	const tiers = parseTierCatalog(JSON.parse(orgModelTiersText(policy)!))!;
	assert.deepEqual(tiers.allowedProviders, ["amazon-bedrock"]);
	assert.deepEqual(tiers.budget, { dailyUsd: 30, onExceed: "warn" });
	assert.deepEqual(tiers.tiers.strong, [], "the org never sets routing patterns");
	assert.equal(orgReviewGate(policy), "strict");
	assert.equal(orgReviewGate(parseOrgPolicy(JSON.stringify({ schema: ORG_POLICY_SCHEMA, reviewGate: "off" }))), undefined, "an org cannot switch the gate off");
});

test("describeOrgPolicy and parseOrgPolicySource", () => {
	const policy = parseOrgPolicy(JSON.stringify(doc));
	assert.match(describeOrgPolicy(policy, "/x")[0]!, /Org policy: Nubiral · from https:\/\/github\.com\/nubiral\/nub-ia-policy\.git@abcdef1 at 2026/);
	assert.match(describeOrgPolicy(undefined, "/x/org-policy.json")[0]!, /none \(\/x\/org-policy\.json absent/);
	assert.deepEqual(parseOrgPolicySource("git:github.com/nubiral/nub-ia-policy"), { repository: "https://github.com/nubiral/nub-ia-policy.git", path: "org-policy.json" });
	assert.deepEqual(parseOrgPolicySource("git:github.com/nubiral/policy#main:policies/nub-ia.json"), { repository: "https://github.com/nubiral/policy.git", path: "policies/nub-ia.json", ref: "main" });
	assert.deepEqual(parseOrgPolicySource("git@github.com:nubiral/policy.git"), { repository: "git@github.com:nubiral/policy.git", path: "org-policy.json" });
	assert.deepEqual(parseOrgPolicySource('{"repository":"/srv/policy","path":"p.json","ref":"v1"}'), { repository: "/srv/policy", path: "p.json", ref: "v1" });
	assert.equal(parseOrgPolicySource("whatever"), undefined);
	assert.equal(parseOrgPolicySource(""), undefined);
});
