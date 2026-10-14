// Per-agent tool rules (roadmap T7.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentToolRule, mergeAgentToolPolicies, parseAgentToolPolicy } from "../lib/agent-tool-policy.ts";

test("parseAgentToolPolicy: valid names and rules only", () => {
	const policy = parseAgentToolPolicy(JSON.stringify({ agents: { "nubia-explore": { tools: { write: "deny", bash: "confirm", nope: "maybe" } }, "review-*": { tools: { bash: "deny" } }, "bad name!": { tools: { write: "deny" } }, empty: { tools: {} }, nottools: {} } }));
	assert.deepEqual(policy, [{ agent: "nubia-explore", tools: { write: "deny", bash: "confirm" } }, { agent: "review-*", tools: { bash: "deny" } }]);
	assert.deepEqual(parseAgentToolPolicy("x"), []);
	assert.deepEqual(parseAgentToolPolicy(JSON.stringify({ paths: {} })), []);
});

test("agentToolRule: strictest matching rule wins across layers, name and tool patterns", () => {
	const user = parseAgentToolPolicy(JSON.stringify({ agents: { "nubia-explore": { tools: { write: "confirm" } } } }));
	const project = parseAgentToolPolicy(JSON.stringify({ agents: { "nubia-*": { tools: { write: "deny", "codegraph_*": "deny" } }, "review-*": { tools: { "*": "deny", read: "allow" } } } }));
	const merged = mergeAgentToolPolicies(user, project);
	assert.equal(agentToolRule(merged, "nubia-explore", "write"), "deny");
	assert.equal(agentToolRule(merged, "nubia-explore", "edit"), "allow");
	assert.equal(agentToolRule(merged, "nubia-worker", "codegraph_search"), "deny");
	assert.equal(agentToolRule(merged, "review-risk", "bash"), "deny");
	assert.equal(agentToolRule(merged, "review-risk", "read"), "deny", "allow never relaxes a deny from `*`");
	assert.equal(agentToolRule(merged, "jd-fix-agent", "write"), "allow");
	assert.equal(agentToolRule([], "anyone", "bash"), "allow");
});
