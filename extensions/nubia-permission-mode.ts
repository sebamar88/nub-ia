// Permission modes (roadmap T7.7–T7.10): the live dial the human turns with
// Shift+Tab or /nubia:mode. Owns the session's current mode, gates write/edit,
// bash and delegation tool calls through lib/permission-mode-policy.ts,
// appends the per-mode directive, and publishes the mode for the footer and
// the Status card. YOLO stays a separate grant (lib/yolo-session-policy.ts):
// entering the yolo mode asks that policy to turn on, and the mode reads back
// what it says.
//
// The guardrails in nubia-harness.ts run after this handler and are never
// waived by a mode: an "allow" here only means the mode has no objection.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configReadPath, nubIaConfigHome, projectConfigReadPath, readEnv } from "../lib/config-home.ts";
import { delegationDenied, parseDelegationLimits, resolvePermissionModeConfig, tightestLimits, type DelegationLimits, type EffectivePermissionModeConfig } from "../lib/permission-mode-config.ts";
import { AGENTS_STATUS_EVENT, parseAgentsStatus } from "../lib/agents-status-model.ts";
import { ROUTER_STATUS_EVENT, parseRouterStatus } from "../lib/router-status-model.ts";
import {
	capMode,
	childMode,
	decide,
	isPermissionMode,
	isPersistableMode,
	MODE_GLYPH,
	MODE_LABEL,
	nextMode,
	PERMISSION_MODES,
	type PermissionMode,
	serializeStoredMode,
	updateModePrompt,
} from "../lib/permission-mode-policy.ts";
import { discoverYoloUiAdapter, YOLO_DISPLAY } from "../lib/yolo-session-policy.ts";
import { bashWriteTargets, evaluatePaths, mergePathPolicies, parsePathPolicy, type PathPolicy } from "../lib/path-permission-policy.ts";
import { agentToolRule, mergeAgentToolPolicies, parseAgentToolPolicy, type AgentToolPolicy } from "../lib/agent-tool-policy.ts";
import { relative } from "node:path";

export const PERMISSION_MODE_EVENT = "nubia:permission-mode/v1";
/** Trusted inter-extension request: `{ mode, context }` from the shell's customize menu. */
export const PERMISSION_MODE_REQUEST = "nubia:permission-mode:request";
export const PERMISSION_MODE_STATUS_KEY = "nubia:mode";
/** Children read their mode from here (set by the parent before spawning). */
export const PERMISSION_MODE_ENV = "NUB_IA_PERMISSION_MODE";
export const MODE_SHORTCUT = "shift+tab";

export interface PermissionModePayload {
	schema: typeof PERMISSION_MODE_EVENT;
	mode: PermissionMode;
	max?: PermissionMode;
	source: EffectivePermissionModeConfig["sources"];
}

export function parsePermissionModePayload(value: unknown): PermissionModePayload | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.schema !== PERMISSION_MODE_EVENT || !isPermissionMode(record.mode)) return undefined;
	if (record.max !== undefined && !isPermissionMode(record.max)) return undefined;
	const source = typeof record.source === "object" && record.source !== null ? (record.source as PermissionModePayload["source"]) : { initial: "default" as const };
	return { schema: PERMISSION_MODE_EVENT, mode: record.mode, ...(isPermissionMode(record.max) ? { max: record.max } : {}), source };
}

/** Footer chip / status text for a mode: `✎ Accept edits`. */
export function modeChip(mode: PermissionMode, max?: PermissionMode): string {
	return `${MODE_GLYPH[mode]} ${MODE_LABEL[mode]}${max && max !== "yolo" ? ` · max ${MODE_LABEL[max]}` : ""}`;
}

function readText(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function loadConfig(cwd: string, env: NodeJS.ProcessEnv): EffectivePermissionModeConfig {
	const home = nubIaConfigHome(env);
	return resolvePermissionModeConfig({
		userModeFile: readText(join(home, "permission-mode.json")),
		userGuardrails: readText(configReadPath(home, "runtime-guardrails.json", env)),
		projectGuardrails: readText(projectConfigReadPath(cwd, "runtime-guardrails.json")),
	});
}

/** `paths` of the user's and the repository's guardrails files: the union (a repo can only add). */
function loadPathPolicy(cwd: string, env: NodeJS.ProcessEnv): PathPolicy {
	const home = nubIaConfigHome(env);
	return mergePathPolicies(parsePathPolicy(readText(configReadPath(home, "runtime-guardrails.json", env))), parsePathPolicy(readText(projectConfigReadPath(cwd, "runtime-guardrails.json"))));
}

function loadDelegationLimits(cwd: string, env: NodeJS.ProcessEnv): DelegationLimits {
	const home = nubIaConfigHome(env);
	return tightestLimits(parseDelegationLimits(readText(configReadPath(home, "runtime-guardrails.json", env))), parseDelegationLimits(readText(projectConfigReadPath(cwd, "runtime-guardrails.json"))));
}

function loadAgentToolPolicy(cwd: string, env: NodeJS.ProcessEnv): AgentToolPolicy {
	const home = nubIaConfigHome(env);
	return mergeAgentToolPolicies(parseAgentToolPolicy(readText(configReadPath(home, "runtime-guardrails.json", env))), parseAgentToolPolicy(readText(projectConfigReadPath(cwd, "runtime-guardrails.json"))));
}

/** Repository-relative form of a tool path (absolute or cwd-relative); outside the worktree it is returned as given. */
function repoRelative(cwd: string, path: string): string {
	const root = worktreeRoot(cwd);
	const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	const rel = relative(root, target);
	return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** The paths a tool call would write, repository-relative, for the path policy. */
export function writtenPaths(cwd: string, toolName: string, input: unknown): string[] {
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	if (toolName === "write" || toolName === "edit") return typeof record.path === "string" ? [repoRelative(cwd, record.path)] : [];
	if (toolName === "bash" && typeof record.command === "string") return bashWriteTargets(record.command).map((target) => repoRelative(cwd, target));
	return [];
}

function worktreeRoot(cwd: string): string {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || cwd;
	} catch {
		return cwd;
	}
}

function insideRepository(cwd: string, path: unknown): boolean | undefined {
	if (typeof path !== "string" || path.length === 0) return undefined;
	const root = worktreeRoot(cwd);
	const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export default function registerPermissionMode(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	// A delegated child runs under what its parent handed down, never more.
	const isChild = readEnv(env, "NUB_IA_AGENTS_CHILD") === "1";
	let config: EffectivePermissionModeConfig = { initial: "auto", sources: { initial: "default" } };
	let mode: PermissionMode = "auto";
	let context: ExtensionContext | undefined;

	const payload = (): PermissionModePayload => ({ schema: PERMISSION_MODE_EVENT, mode, ...(config.max ? { max: config.max } : {}), source: config.sources });
	const publish = (ctx: ExtensionContext | undefined) => {
		env[PERMISSION_MODE_ENV] = childMode(mode);
		pi.events.emit(PERMISSION_MODE_EVENT, payload());
		if (ctx?.hasUI) { try { ctx.ui.setStatus(PERMISSION_MODE_STATUS_KEY, isChild ? undefined : modeChip(mode, config.max)); } catch { /* display only */ } }
	};

	const initialise = (ctx: ExtensionContext) => {
		context = ctx;
		config = loadConfig(ctx.cwd, env);
		if (isChild) {
			const inherited = readEnv(env, PERMISSION_MODE_ENV);
			mode = capMode(isPermissionMode(inherited) ? childMode(inherited) : "auto", config.max);
		} else {
			mode = config.initial;
		}
		publish(ctx);
	};

	// Entering/leaving yolo goes through the YOLO session policy's own trusted
	// adapter, so every requirement it enforces (interactive TUI, live session,
	// identifiable Git clone) still decides; the mode mirrors the outcome.
	const syncYolo = async (ctx: ExtensionContext, wanted: boolean): Promise<boolean> => {
		const adapter = await discoverYoloUiAdapter(pi, ctx);
		if (!adapter) return false;
		try {
			const state = await adapter.read();
			if (state === YOLO_DISPLAY.unavailable) return !wanted;
			const on = state === YOLO_DISPLAY.on;
			if (on !== wanted) { await adapter.toggle(); return (await adapter.read()) === (wanted ? YOLO_DISPLAY.on : YOLO_DISPLAY.off); }
			return true;
		} finally {
			adapter.dispose();
		}
	};

	const setMode = async (ctx: ExtensionContext, next: PermissionMode, how: "shortcut" | "command" | "menu"): Promise<void> => {
		if (isChild) { ctx.ui.notify("A delegated subagent cannot change the permission mode.", "warning"); return; }
		config = loadConfig(ctx.cwd, env);
		const capped = capMode(next, config.max);
		if (capped !== next) { ctx.ui.notify(`${MODE_LABEL[next]} is above this repository's cap (${MODE_LABEL[config.max!]}, from ${config.sources.max ?? "policy"}).`, "warning"); return; }
		if (next === "yolo") {
			if (how === "shortcut" && !(await ctx.ui.confirm("Permission mode → YOLO", "Standing permission for scoped commits, pushes and PRs this session. Destructive confirmations remain. Enable?"))) return;
			if (!(await syncYolo(ctx, true))) { ctx.ui.notify("YOLO is unavailable here (needs an interactive primary session in a Git clone); mode unchanged.", "warning"); return; }
		} else if (mode === "yolo") {
			await syncYolo(ctx, false);
		}
		mode = next;
		publish(ctx);
		ctx.ui.notify(`Permission mode: ${modeChip(mode, config.max)}`, "info");
	};

	// Delegation limits (T7.4): live counts come from the agents and router channels.
	let activeSubagents = 0;
	let startedThisTurn = 0;
	let overBudget = false;
	pi.events.on(AGENTS_STATUS_EVENT, (payload) => { const parsed = parseAgentsStatus(payload); if (parsed) activeSubagents = parsed.running + parsed.queued + parsed.waiting; });
	pi.events.on(ROUTER_STATUS_EVENT, (payload) => { const parsed = parseRouterStatus(payload); if (parsed) overBudget = parsed.budget?.exceeded === true; });
	pi.on("turn_start", () => { startedThisTurn = 0; });

	pi.on("session_start", (_event, ctx) => initialise(ctx));
	pi.on("session_shutdown", () => { mode = config.initial; });

	// The directive rides on the system prompt and is swapped on every change.
	pi.on("before_agent_start", (event) => {
		updateModePrompt(event.systemPromptOptions, mode);
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input;
		const agentName = readEnv(env, "NUB_IA_AGENT_NAME");
		// A delegated child: the per-agent tool rules apply before anything else.
		// Children are headless, so confirm fails closed with a report-back hint.
		if (isChild && agentName) {
			const rule = agentToolRule(loadAgentToolPolicy(ctx.cwd, env), agentName, event.toolName);
			if (rule === "deny") return { block: true, reason: `Policy: the ${agentName} agent may not use ${event.toolName} (agents.${agentName}.tools in runtime-guardrails.json). Report what you would do instead of doing it.` };
			if (rule === "confirm") return { block: true, reason: `Policy: ${event.toolName} by the ${agentName} agent requires the human's confirmation, which a subagent cannot obtain. Report the exact action back to the orchestrator.` };
		}
		if (event.toolName === "subagent_run" && !isChild) {
			const denied = delegationDenied(loadDelegationLimits(ctx.cwd, env), { active: activeSubagents, startedThisTurn, overBudget });
			if (denied) return { block: true, reason: `Delegation limit: ${denied}` };
			startedThisTurn += 1;
		}
		// Path policy first: it is independent of the mode and never waived by it.
		const hit = evaluatePaths(loadPathPolicy(ctx.cwd, env), writtenPaths(ctx.cwd, event.toolName, input));
		if (hit?.rule === "deny") return { block: true, reason: `Path policy: ${hit.path} matches "${hit.glob}" (paths.deny in runtime-guardrails.json) and must not be changed by the agent. Leave it alone or ask the human to edit it.` };
		const decision = decide({
			mode,
			toolName: event.toolName,
			input,
			insideRepository: event.toolName === "write" || event.toolName === "edit" ? insideRepository(ctx.cwd, (input as { path?: unknown } | undefined)?.path) : undefined,
		});
		if (decision.action === "deny") return { block: true, reason: decision.reason };
		const ask = decision.action === "ask" ? decision.reason : hit?.rule === "confirm" ? `${hit.path} is protected (paths.confirm: "${hit.glob}")` : undefined;
		if (ask === undefined) return undefined;
		if (!ctx.hasUI) return { block: true, reason: `${hit?.rule === "confirm" && decision.action === "allow" ? "The path policy" : `${MODE_LABEL[mode]} mode`} needs the human to confirm this ${event.toolName} call, and this session has no UI. Ask for the mode or the policy to be changed.` };
		const requestId = randomUUID();
		const emit = (state: "waiting" | "approved" | "denied") => pi.events.emit("pi-permission-system:permission-request", { requestId, state, source: "tool_call", message: `${MODE_LABEL[mode]} mode asks before this tool call.`, toolName: event.toolName });
		emit("waiting");
		let approved = false;
		try {
			const preview = event.toolName === "bash" ? String((input as { command?: unknown })?.command ?? "").slice(0, 400) : String((input as { path?: unknown })?.path ?? "");
			approved = (await ctx.ui.confirm(`${MODE_GLYPH[mode]} ${MODE_LABEL[mode]} · ${ask}`, `${preview}\n\n(Shift+Tab or /nubia:mode changes the mode)`)) === true;
		} finally {
			emit(approved ? "approved" : "denied");
		}
		return approved ? undefined : { block: true, reason: `The human declined this ${event.toolName} call${hit?.rule === "confirm" ? ` (protected path ${hit.path})` : ` in ${MODE_LABEL[mode]} mode`}. Do not retry it; propose an alternative or ask what to do.` };
	});

	// Shift+Tab (the isolated home moves Pi's thinking-cycle to Ctrl+Alt+T so
	// this key is free; elsewhere Pi keeps the key and /nubia:mode remains).
	pi.registerShortcut(MODE_SHORTCUT as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Cycle the permission mode (plan → manual → accept edits → auto → yolo)",
		handler: async (ctx) => {
			const next = nextMode(mode, { maxMode: config.max, yoloAvailable: true });
			await setMode(ctx, next, "shortcut");
		},
	});

	pi.registerCommand("nubia:mode", {
		description: "Show or set the permission mode: plan | manual | accept-edits | auto | yolo | status | default <mode> (saves the startup mode). No argument opens a menu. Shift+Tab cycles.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			let action = tokens[0] ?? "";
			if (action === "" && ctx.hasUI && typeof ctx.ui.select === "function") {
				const options = PERMISSION_MODES.filter((candidate) => !config.max || PERMISSION_MODES.indexOf(candidate) <= PERMISSION_MODES.indexOf(config.max)).map((candidate) => `${candidate}${candidate === mode ? " (current)" : ""}`);
				const selected = await ctx.ui.select(`Permission mode (current: ${modeChip(mode, config.max)})`, [...options, "status"]);
				if (!selected) return;
				action = selected.replace(/ \(current\)$/, "");
			}
			if (action === "" || action === "status") {
				const lines = [
					`Permission mode: ${modeChip(mode, config.max)}`,
					`Startup mode: ${MODE_LABEL[config.initial]} (${config.sources.initial})${config.max ? ` · cap: ${MODE_LABEL[config.max]} (${config.sources.max})` : ""}`,
					"plan: read-only · manual: every write/command asks · accept-edits: edits run, commands ask · auto: guardrails only · yolo: + commits/push/PR",
					`Shift+Tab cycles (isolated home); /nubia:mode <mode> sets; /nubia:mode default <mode> saves the startup mode in ${join(nubIaConfigHome(env), "permission-mode.json")}.`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (action === "default") {
				const wanted = tokens[1];
				if (!isPersistableMode(wanted)) { ctx.ui.notify("Use /nubia:mode default plan|manual|accept-edits|auto (yolo is never a default).", "warning"); return; }
				const path = join(nubIaConfigHome(env), "permission-mode.json");
				try {
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, serializeStoredMode(wanted), { encoding: "utf8", mode: 0o600 });
					config = loadConfig(ctx.cwd, env);
					publish(ctx);
					ctx.ui.notify(`Startup permission mode saved: ${MODE_LABEL[wanted]} (${path}). Current session unchanged.`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not save the default mode: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (!isPermissionMode(action)) { ctx.ui.notify(`Unknown mode "${action}". Use plan, manual, accept-edits, auto, yolo, status, or default <mode>.`, "warning"); return; }
			await setMode(ctx, action, "command");
		},
	});

	// The shell's customize menu asks here; the context proves it is a live UI request.
	pi.events.on(PERMISSION_MODE_REQUEST, (request: unknown) => {
		if (typeof request !== "object" || request === null) return;
		const { mode: wanted, context: ctx } = request as { mode?: unknown; context?: ExtensionContext };
		if (!isPermissionMode(wanted) || !ctx || !ctx.hasUI || ctx !== context) return;
		void setMode(ctx, wanted, "menu");
	});

}
