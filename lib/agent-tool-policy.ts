// Per-agent tool rules (roadmap T7.2): what a named subagent may do with each
// tool, declared in the `agents` section of runtime-guardrails.json and applied
// inside the child by the permission-mode extension (the parent passes the
// agent name down in NUB_IA_AGENT_NAME).
//
//   "agents": {
//     "nubia-explore": { "tools": { "write": "deny", "edit": "deny", "bash": "confirm" } },
//     "review-*":      { "tools": { "bash": "deny" } }
//   }
//
// Rules: allow < confirm < deny; layers merge to the strictest; an agent name
// pattern may use `*`. A child is headless, so `confirm` there fails closed
// (the child is told to report back rather than act). The agent's own
// frontmatter `tools:` still applies first; this only ever removes.

export type ToolRule = "allow" | "confirm" | "deny";
const RANK: Record<ToolRule, number> = { allow: 0, confirm: 1, deny: 2 };
const RULES = new Set<string>(["allow", "confirm", "deny"]);

export type AgentToolPolicy = Array<{ agent: string; tools: Record<string, ToolRule> }>;

export function parseAgentToolPolicy(text: string | undefined): AgentToolPolicy {
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as { agents?: Record<string, { tools?: Record<string, unknown> }> };
		if (typeof parsed.agents !== "object" || parsed.agents === null) return [];
		const policy: AgentToolPolicy = [];
		for (const [agent, spec] of Object.entries(parsed.agents)) {
			if (!/^[A-Za-z0-9_*.-]{1,64}$/.test(agent) || typeof spec !== "object" || spec === null || typeof spec.tools !== "object" || spec.tools === null) continue;
			const tools: Record<string, ToolRule> = {};
			for (const [tool, rule] of Object.entries(spec.tools)) if (/^[A-Za-z0-9_*-]{1,64}$/.test(tool) && typeof rule === "string" && RULES.has(rule)) tools[tool] = rule as ToolRule;
			if (Object.keys(tools).length) policy.push({ agent, tools });
		}
		return policy;
	} catch {
		return [];
	}
}

/** Concatenation is enough: evaluation takes the strictest matching rule. */
export function mergeAgentToolPolicies(...layers: AgentToolPolicy[]): AgentToolPolicy {
	return layers.flat();
}

function matchesName(pattern: string, name: string): boolean {
	if (!pattern.includes("*")) return pattern === name;
	return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+^$()|[\]\\?{}]/g, "\\$&")).join(".*")}$`).test(name);
}

/** The strictest rule any matching entry sets for this tool (`*` tool entries apply to every tool). */
export function agentToolRule(policy: AgentToolPolicy, agent: string, tool: string): ToolRule {
	let rule: ToolRule = "allow";
	for (const entry of policy) {
		if (!matchesName(entry.agent, agent)) continue;
		for (const [pattern, candidate] of Object.entries(entry.tools)) {
			if ((pattern === "*" || matchesName(pattern, tool)) && RANK[candidate] > RANK[rule]) rule = candidate;
		}
	}
	return rule;
}
