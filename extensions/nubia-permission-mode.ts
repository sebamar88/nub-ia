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
import { resolvePermissionModeConfig, type EffectivePermissionModeConfig } from "../lib/permission-mode-config.ts";
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

	pi.on("session_start", (_event, ctx) => initialise(ctx));
	pi.on("session_shutdown", () => { mode = config.initial; });

	// The directive rides on the system prompt and is swapped on every change.
	pi.on("before_agent_start", (event) => {
		updateModePrompt(event.systemPromptOptions, mode);
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input;
		const decision = decide({
			mode,
			toolName: event.toolName,
			input,
			insideRepository: event.toolName === "write" || event.toolName === "edit" ? insideRepository(ctx.cwd, (input as { path?: unknown } | undefined)?.path) : undefined,
		});
		if (decision.action === "allow") return undefined;
		if (decision.action === "deny") return { block: true, reason: decision.reason };
		if (!ctx.hasUI) return { block: true, reason: `${MODE_LABEL[mode]} mode needs the human to confirm this ${event.toolName} call, and this session has no UI. Ask for the mode to be changed.` };
		const requestId = randomUUID();
		const emit = (state: "waiting" | "approved" | "denied") => pi.events.emit("pi-permission-system:permission-request", { requestId, state, source: "tool_call", message: `${MODE_LABEL[mode]} mode asks before this tool call.`, toolName: event.toolName });
		emit("waiting");
		let approved = false;
		try {
			const preview = event.toolName === "bash" ? String((input as { command?: unknown })?.command ?? "").slice(0, 400) : String((input as { path?: unknown })?.path ?? "");
			approved = (await ctx.ui.confirm(`${MODE_GLYPH[mode]} ${MODE_LABEL[mode]} · ${decision.reason}`, `${preview}\n\n(Shift+Tab or /nubia:mode changes the mode)`)) === true;
		} finally {
			emit(approved ? "approved" : "denied");
		}
		return approved ? undefined : { block: true, reason: `The human declined this ${event.toolName} call in ${MODE_LABEL[mode]} mode. Do not retry it; propose an alternative or ask what to do.` };
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
