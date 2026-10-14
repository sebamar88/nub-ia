// Permission-mode configuration (roadmap T7.6/T8.1 hook): the user's saved
// default and the optional cap, with the usual precedence — a repository can
// only tighten what the user chose. Pure parsing; the extension reads files.
//
//   <configHome>/permission-mode.json           { "mode": "accept-edits" }        user default
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
	sources: { initial: "user-file" | "user-guardrails" | "project-guardrails" | "default"; max?: "user-guardrails" | "project-guardrails" };
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

export function resolvePermissionModeConfig(input: { userModeFile?: string; userGuardrails?: string; projectGuardrails?: string }): EffectivePermissionModeConfig {
	const user = parsePermissionModeLayer(input.userGuardrails);
	const project = parsePermissionModeLayer(input.projectGuardrails);
	const stored = parseStoredMode(input.userModeFile);
	// Cap: the lowest of the layers that set one.
	let max: PermissionMode | undefined;
	let maxSource: EffectivePermissionModeConfig["sources"]["max"];
	if (user.max) { max = user.max; maxSource = "user-guardrails"; }
	if (project.max && (max === undefined || modeRank(project.max) < modeRank(max))) { max = project.max; maxSource = "project-guardrails"; }
	// Default: the user's choice (file, then guardrails); a project default only
	// applies when it is stricter than what the user chose.
	let initial: PermissionMode = DEFAULT_PERMISSION_MODE;
	let initialSource: EffectivePermissionModeConfig["sources"]["initial"] = "default";
	if (user.default) { initial = user.default; initialSource = "user-guardrails"; }
	if (stored) { initial = stored; initialSource = "user-file"; }
	if (project.default && modeRank(project.default) < modeRank(initial)) { initial = project.default; initialSource = "project-guardrails"; }
	if (max !== undefined && modeRank(initial) > modeRank(max)) { initial = max; initialSource = maxSource ?? initialSource; }
	return { initial, ...(max !== undefined ? { max } : {}), sources: { initial: initialSource, ...(maxSource ? { max: maxSource } : {}) } };
}
