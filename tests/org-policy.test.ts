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

// --- roles (roadmap T8.2) ---------------------------------------------------------------

import { applyRole, parseRoles, resolveRole } from "../lib/org-policy.ts";

const withRoles = parseOrgPolicy(JSON.stringify({
	schema: ORG_POLICY_SCHEMA,
	permissionMode: { max: "auto" },
	reviewGate: "strict",
	roles: {
		default: "developer",
		members: { "Lead@Nubiral.com": "lead", "*@contractor.example": "contractor", "ghost@x.y": "undefined-role" },
		definitions: {
			lead: { permissionMode: { max: "yolo" }, reviewGate: "confirm" },
			developer: {},
			contractor: { permissionMode: { max: "accept-edits" }, limits: { maxConcurrentSubagents: 1 }, roles: "ignored", approvedPackages: ["ignored"] },
			"bad name!": { permissionMode: {} },
		},
	},
}))!;

test("parseRoles: definitions, members (lower-cased, only known roles) and default", () => {
	const roles = parseRoles(withRoles)!;
	assert.deepEqual(Object.keys(roles.definitions).sort(), ["contractor", "developer", "lead"]);
	assert.deepEqual(roles.members, { "lead@nubiral.com": "lead", "*@contractor.example": "contractor" });
	assert.equal(roles.default, "developer");
	assert.deepEqual(Object.keys(roles.definitions.contractor!), ["permissionMode", "limits"], "a role never nests roles or approvedPackages");
	assert.equal(parseRoles(parseOrgPolicy(JSON.stringify({ schema: ORG_POLICY_SCHEMA }))), undefined);
});

test("resolveRole: env, exact member, domain wildcard, default; unknown env role is ignored", () => {
	const roles = parseRoles(withRoles);
	assert.deepEqual(resolveRole(roles, { envRole: "lead" }), { role: "lead", source: "env" });
	assert.deepEqual(resolveRole(roles, { envRole: "admin", email: "someone@contractor.example" }), { role: "contractor", source: "domain" });
	assert.deepEqual(resolveRole(roles, { email: "LEAD@nubiral.com" }), { role: "lead", source: "member" });
	assert.deepEqual(resolveRole(roles, { email: "dev@nubiral.com" }), { role: "developer", source: "default" });
	assert.equal(resolveRole(undefined, { email: "x@y" }), undefined);
});

test("applyRole: a role's sections replace the org-level ones of the same name; everything else stays", () => {
	const lead = applyRole(withRoles, { role: "lead", source: "member" })!;
	assert.deepEqual(lead.sections.permissionMode, { max: "yolo" });
	assert.equal(lead.sections.reviewGate, "confirm");
	const contractor = applyRole(withRoles, { role: "contractor", source: "domain" })!;
	assert.deepEqual(contractor.sections.permissionMode, { max: "accept-edits" });
	assert.equal(contractor.sections.reviewGate, "strict", "untouched org sections remain");
	assert.deepEqual(contractor.sections.limits, { maxConcurrentSubagents: 1 });
	assert.equal(applyRole(withRoles, undefined), withRoles);
	assert.equal(applyRole(withRoles, { role: "nope", source: "env" }), withRoles);
});
