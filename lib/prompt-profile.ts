// Prompt profile (roadmap T5.0): how much Nub-IA appends to Pi's own system
// prompt. `minimal` (default) keeps the identity, the persona and the ODD
// discipline in a short block; `full` appends the complete harness text
// (identity, workflow steps, principles and assets/orchestrator.md) as before.
// Nothing here is a permission: the tool guardrails, modes and policies apply
// regardless of how much the model is told about them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nubIaConfigHome } from "./config-home.ts";

export const PROMPT_PROFILES = ["minimal", "full"] as const;
export type PromptProfile = (typeof PROMPT_PROFILES)[number];
export const DEFAULT_PROMPT_PROFILE: PromptProfile = "minimal";
export const PROMPT_PROFILE_FILE = "prompt-profile.json";
export const PROMPT_PROFILE_ENV = "NUB_IA_PROMPT_PROFILE";

export function isPromptProfile(value: unknown): value is PromptProfile {
	return typeof value === "string" && (PROMPT_PROFILES as readonly string[]).includes(value);
}

export function parsePromptProfile(text: string | undefined): PromptProfile | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as { profile?: unknown };
		return isPromptProfile(parsed.profile) ? parsed.profile : undefined;
	} catch {
		return undefined;
	}
}

export interface PromptProfileResolution {
	profile: PromptProfile;
	source: "environment" | "project-file" | "user-file" | "default";
}

/** Environment (for one session) > repository file > user file > default. A repository may choose either: this is about verbosity, not permission. */
export function resolvePromptProfile(input: { env?: NodeJS.ProcessEnv; cwd?: string; configHome?: string; read?: (path: string) => string | undefined } = {}): PromptProfileResolution {
	const env = input.env ?? process.env;
	const read = input.read ?? ((path: string) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } });
	if (isPromptProfile(env[PROMPT_PROFILE_ENV])) return { profile: env[PROMPT_PROFILE_ENV] as PromptProfile, source: "environment" };
	if (input.cwd) {
		const project = parsePromptProfile(read(join(input.cwd, ".pi", "nub-ia", PROMPT_PROFILE_FILE)));
		if (project) return { profile: project, source: "project-file" };
	}
	const user = parsePromptProfile(read(join(input.configHome ?? nubIaConfigHome(env), PROMPT_PROFILE_FILE)));
	if (user) return { profile: user, source: "user-file" };
	return { profile: DEFAULT_PROMPT_PROFILE, source: "default" };
}

export function writePromptProfile(profile: PromptProfile, configHome: string = nubIaConfigHome()): string {
	mkdirSync(configHome, { recursive: true });
	const path = join(configHome, PROMPT_PROFILE_FILE);
	writeFileSync(path, `${JSON.stringify({ profile }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

// --- the minimal prompt ------------------------------------------------------------------

export interface MinimalPromptInput {
	persona: "gentleman" | "neutral";
	personaPrompt: string;
	languageBoundary: string;
	/** Whether the subagent tools are registered in this session. */
	subagentsAvailable: boolean;
	/** Whether the in-process review tool is registered. */
	reviewAvailable: boolean;
}

/**
 * The whole Nub-IA addition in minimal mode: identity, persona, and ODD as
 * eight rules. Everything else (routing detail, tracking format, memory,
 * skills catalogue) stays in assets/ and the `nubia` skill for on-demand
 * reading, and in the runtime: guardrails, modes and policies enforce
 * themselves on the tool calls.
 */
export function buildMinimalPrompt(input: MinimalPromptInput): string {
	const delegation = input.subagentsAvailable
		? "- Delegate with `subagent_run` only when it buys something: an exploration you will not read yourself, a writer for 2+ non-trivial files or parallel disjoint edits, an independent verifier for risky changes. One parent orchestrates; children never spawn children. Always pass a short `label`."
		: "- No subagents in this session: do the work inline.";
	const review = input.reviewAvailable
		? "- Before delivering a non-trivial change, run `nub_review` on the diff and fix its BLOCKER/CRITICAL findings; the push gate asks when changes were not reviewed."
		: "";
	return [
		"## Nub-IA",
		"",
		`You are Nub-IA, the Nubiral team's Pi coding-agent harness (persona: ${input.persona}). When asked who you are, say so: a Pi-specific harness for controlled development with a senior-architect persona that runs Organic Driven Development and coordinates subagents; not a generic chatbot. Never claim persistent memory unless a memory tool is actually available.`,
		"",
		input.personaPrompt.trim(),
		"",
		input.languageBoundary,
		"",
		"Organic Driven Development, every request:",
		"- Authorize: investigation, review, comparison and proposal requests are read-only; ambiguous change intent gets one clarifying question, then wait.",
		"- Explore first, proportionately; read what you need before proposing or writing.",
		"- Classify: small work (understood, contained, resumable from the request plus `git diff`) stays inline with no task artifacts; large work gets `odd/tasks/<feature>.md` (Specs quoting the user verbatim, Tasks, Log) and a visible `todo` list before the first write, and closes each task with a Conventional Commit on a feature branch. Push, PR and merge are the user's decisions.",
		"- Behavior changes with runnable deterministic tests use test-first (observe RED, GREEN, refactor); otherwise verify proportionately and say how.",
		delegation,
		review,
		"- Close by reporting what was verified, what failed or was skipped, and the next step. Partial or blocked proof becomes one \"Needs your decision\" item, not more ceremony.",
		"- Protect the human reviewer: avoid oversized multi-area diffs; ask before growing one task into many.",
		"",
		"Detail when needed: the `nubia` skill and `assets/orchestrator*.md` in the Nub-IA package.",
	].filter((line) => line !== review || review !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}
