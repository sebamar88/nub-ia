// `nub-ia init` (roadmap T3.1): scaffolds the repository's .pi/nub-ia/ with the
// per-repository policy files Nub-IA reads, each as a commented example that
// changes nothing until edited (every value is the permissive default or
// empty). Existing files are never overwritten. Pure except the writes.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** file name → contents. Keep every default inert: scaffolding must not tighten anything by itself. */
export const REPO_TEMPLATES = {
	"runtime-guardrails.json": `${JSON.stringify({
		"$comment": "Repository guardrails: can only tighten the user's own. guardedCommands: <key>: confirm|block. permissionMode.max caps the permission mode (plan|manual|accept-edits|auto|yolo). paths.deny/confirm are globs the agent must not / must confirm before writing. agents.<name>.tools.<tool>: allow|confirm|deny for subagents. limits bound delegation. See docs/permission-modes.md and docs/governance.md.",
		guardedCommands: {},
		permissionMode: {},
		paths: { deny: [], confirm: [] },
		agents: {},
		limits: {},
	}, null, 2)}\n`,
	// The gate reader accepts exactly {schema, mode}: no comment key here (docs/governance.md explains confirm|strict).
	"review-gate.json": `${JSON.stringify({ schema: "nub-ia.review-gate/v1", mode: "confirm" }, null, 2)}\n`,
	"review-rules.md": [
		"# Review rules for this repository",
		"",
		"Conventions the Nub-IA 4R review checks the diff against (reported as WARNING when broken).",
		"Keep each rule one line and concrete. Examples:",
		"",
		"- Use `lib/logger` instead of `console.log` under `src/`.",
		"- Outbound HTTP goes through `lib/http` (timeouts, retries), never a direct `axios`/`fetch` import.",
		"- Never log customer PII (emails, phone numbers, addresses).",
		"",
	].join("\n"),
	"persona.json": `${JSON.stringify({ "$comment": "Assistant persona for this repository: gentleman | neutral.", mode: "gentleman" }, null, 2)}\n`,
	"model-tiers.json.example": `${JSON.stringify({
		"$comment": "Rename to model-tiers.json to override the team's tier routing for this repository (replaces the packaged routing; budget and allowlist can only tighten). Start from assets/model-tiers.json in the nub-ia package.",
		providerPriority: ["github-copilot", "amazon-bedrock", "openai"],
		tiers: { strong: [], "strong-alt": [], balanced: [], fast: [] },
		allowedProviders: ["github-copilot", "amazon-bedrock", "openai"],
		budget: { dailyUsd: 20, onExceed: "warn" },
	}, null, 2)}\n`,
};

/** Writes the missing templates under <cwd>/.pi/nub-ia; returns what was created and what already existed. */
export function initRepo(cwd, { reviewGate = true } = {}) {
	const dir = join(cwd, ".pi", "nub-ia");
	mkdirSync(dir, { recursive: true });
	const created = [];
	const kept = [];
	for (const [name, content] of Object.entries(REPO_TEMPLATES)) {
		if (name === "review-gate.json" && !reviewGate) continue;
		const path = join(dir, name);
		if (existsSync(path)) { kept.push(name); continue; }
		writeFileSync(path, content, "utf8");
		created.push(name);
	}
	return { dir, created, kept };
}
