// Permission-mode configuration (roadmap T7.6/T8.1 hook): the user's saved
// default and the optional cap, with the usual precedence — a repository can
// only tighten what the user chose. Pure parsing; the extension reads files.
//
//   <configHome>/permission-mode-default.json   { "mode": "accept-edits" }   user default (named apart from
//   upstream nubia-shell's permission-mode.json, which carries its own 3-mode schema)
//   <configHome>/runtime-guardrails.json        { "permissionMode": { "max": "auto", "default": "manual" } }
//   <repo>/.pi/nub-ia/runtime-guardrails.json   { "permissionMode": { "max": "accept-edits" } }   tighten-only

import { DEFAULT_PERMISSION_MODE, isPermissionMode, isPersistableMode, modeRank, parseStoredMode, type PermissionMode, type PersistableMode } from "./permission-mode-policy.ts";

export interface PermissionModeLayer {
	max?: PermissionMode;
	default?: PersistableMode;
}

export interface EffectivePermissionModeConfig {
	/** The mode a session starts in (already capped). */
	initial: PermissionMode;
	/** Highest reachable mode, when any layer caps it. */
	max?: PermissionMode;
	/** Where each value came from, for /nubia:mode status and the Status card. */
	sources: { initial: "user-file" | "user-guardrails" | "project-guardrails" | "org-policy" | "default"; max?: "user-guardrails" | "project-guardrails" | "org-policy" };
}

/** The `permissionMode` section of a runtime-guardrails.json text; unknown or malformed values are ignored. */
export function parsePermissionModeLayer(text: string | undefined): PermissionModeLayer {
	if (!text) return {};
	try {
		const parsed = JSON.parse(text) as { permissionMode?: { max?: unknown; default?: unknown } };
		const section = parsed.permissionMode;
		if (typeof section !== "object" || section === null) return {};
		return { ...(isPermissionMode(section.max) ? { max: section.max } : {}), ...(isPersistableMode(section.default) ? { default: section.default } : {}) };
	} catch {
		return {};
	}
}

export function resolvePermissionModeConfig(input: { userModeFile?: string; userGuardrails?: string; projectGuardrails?: string; orgPolicy?: string }): EffectivePermissionModeConfig {
	const user = parsePermissionModeLayer(input.userGuardrails);
	const project = parsePermissionModeLayer(input.projectGuardrails);
	const org = parsePermissionModeLayer(input.orgPolicy);
	const stored = parseStoredMode(input.userModeFile);
	// Cap: the lowest of the layers that set one (org > repo > user, all tighten-only).
	let max: PermissionMode | undefined;
	let maxSource: EffectivePermissionModeConfig["sources"]["max"];
	if (user.max) { max = user.max; maxSource = "user-guardrails"; }
	if (project.max && (max === undefined || modeRank(project.max) < modeRank(max))) { max = project.max; maxSource = "project-guardrails"; }
	if (org.max && (max === undefined || modeRank(org.max) < modeRank(max))) { max = org.max; maxSource = "org-policy"; }
	// Default: the user's choice (file, then guardrails); a project default only
	// applies when it is stricter than what the user chose.
	let initial: PermissionMode = DEFAULT_PERMISSION_MODE;
	let initialSource: EffectivePermissionModeConfig["sources"]["initial"] = "default";
	if (user.default) { initial = user.default; initialSource = "user-guardrails"; }
	if (stored) { initial = stored; initialSource = "user-file"; }
	if (project.default && modeRank(project.default) < modeRank(initial)) { initial = project.default; initialSource = "project-guardrails"; }
	if (org.default && modeRank(org.default) < modeRank(initial)) { initial = org.default; initialSource = "org-policy"; }
	if (max !== undefined && modeRank(initial) > modeRank(max)) { initial = max; initialSource = maxSource ?? initialSource; }
	return { initial, ...(max !== undefined ? { max } : {}), sources: { initial: initialSource, ...(maxSource ? { max: maxSource } : {}) } };
}

// --- delegation limits (roadmap T7.4) -------------------------------------------------
//
//   "limits": { "maxConcurrentSubagents": 3, "maxSubagentsPerTurn": 6, "blockDelegationOverBudget": true }
//
// Each layer may only lower a number or switch the flag on.

export interface DelegationLimits {
	maxConcurrentSubagents?: number;
	maxSubagentsPerTurn?: number;
	blockDelegationOverBudget?: boolean;
}

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

export function parseDelegationLimits(text: string | undefined): DelegationLimits {
	if (!text) return {};
	try {
		const parsed = JSON.parse(text) as { limits?: Record<string, unknown> };
		const section = parsed.limits;
		if (typeof section !== "object" || section === null) return {};
		const maxConcurrentSubagents = positive(section.maxConcurrentSubagents);
		const maxSubagentsPerTurn = positive(section.maxSubagentsPerTurn);
		return {
			...(maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents } : {}),
			...(maxSubagentsPerTurn !== undefined ? { maxSubagentsPerTurn } : {}),
			...(section.blockDelegationOverBudget === true ? { blockDelegationOverBudget: true } : {}),
		};
	} catch {
		return {};
	}
}

export function tightestLimits(...layers: DelegationLimits[]): DelegationLimits {
	const min = (key: "maxConcurrentSubagents" | "maxSubagentsPerTurn") => layers.map((layer) => layer[key]).filter((value): value is number => value !== undefined).reduce<number | undefined>((acc, value) => (acc === undefined ? value : Math.min(acc, value)), undefined);
	const maxConcurrentSubagents = min("maxConcurrentSubagents");
	const maxSubagentsPerTurn = min("maxSubagentsPerTurn");
	return {
		...(maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents } : {}),
		...(maxSubagentsPerTurn !== undefined ? { maxSubagentsPerTurn } : {}),
		...(layers.some((layer) => layer.blockDelegationOverBudget) ? { blockDelegationOverBudget: true } : {}),
	};
}

/** Why a new delegation must not start now, or undefined. */
export function delegationDenied(limits: DelegationLimits, state: { active: number; startedThisTurn: number; overBudget: boolean }): string | undefined {
	if (limits.maxConcurrentSubagents !== undefined && state.active >= limits.maxConcurrentSubagents) return `limits.maxConcurrentSubagents = ${limits.maxConcurrentSubagents} reached (${state.active} active). Wait for a subagent to finish (subagent_status) or do the work inline.`;
	if (limits.maxSubagentsPerTurn !== undefined && state.startedThisTurn >= limits.maxSubagentsPerTurn) return `limits.maxSubagentsPerTurn = ${limits.maxSubagentsPerTurn} reached this turn. Finish with what is running; the human can raise the limit in runtime-guardrails.json.`;
	if (limits.blockDelegationOverBudget && state.overBudget) return "the session or daily model budget is exceeded (limits.blockDelegationOverBudget); no new subagents until it resets. Continue inline or ask the human.";
	return undefined;
}
