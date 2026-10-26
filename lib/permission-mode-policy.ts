// Permission modes (roadmap T7.6–T7.8): one human-controlled dial for how much
// the agent may do without asking, cycled with Shift+Tab or /nubia:mode.
//
//   plan          read-only: analyse and propose, never write, never run anything that mutates
//   manual        every write/edit and every mutating command asks first
//   accept-edits  edits inside the repository go through; mutating commands still ask
//   auto          edits and commands go through; only guardrails (confirm/block) ask   ← default, today's behaviour
//   yolo          auto plus standing permission for commit/push/PR (lib/yolo-session-policy.ts)
//
// Invariants the rest of the harness keeps: guardrail confirm/block decisions,
// the data-loss boundary and ask_user tools are never waived by a mode; a
// policy may cap the reachable mode (maxMode); children inherit at most the
// parent's mode and never yolo; yolo is never persisted and only the YOLO
// session policy can actually grant it. Pure: no I/O, no Pi imports.

import type { AppendableSystemPromptOptions } from "./append-system-prompt.ts";
import { appendSystemPromptOnce } from "./append-system-prompt.ts";
import { cmdSlash } from "./brand.ts";

export const PERMISSION_MODES = ["plan", "manual", "accept-edits", "auto", "yolo"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Modes a default may persist: yolo is a live grant, never a setting. */
export const PERSISTABLE_MODES = ["plan", "manual", "accept-edits", "auto"] as const;
export type PersistableMode = (typeof PERSISTABLE_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PersistableMode = "auto";

export const MODE_LABEL: Record<PermissionMode, string> = { plan: "Plan", manual: "Manual", "accept-edits": "Accept edits", auto: "Auto", yolo: "YOLO" };
export const MODE_GLYPH: Record<PermissionMode, string> = { plan: "⏸", manual: "✋", "accept-edits": "✎", auto: "▶", yolo: "🚀" };
export const MODE_TONE: Record<PermissionMode, "dim" | "text" | "accent" | "warning" | "error"> = { plan: "dim", manual: "text", "accept-edits": "accent", auto: "warning", yolo: "error" };

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}
export function isPersistableMode(value: unknown): value is PersistableMode {
	return typeof value === "string" && (PERSISTABLE_MODES as readonly string[]).includes(value);
}
export const modeRank = (mode: PermissionMode): number => PERMISSION_MODES.indexOf(mode);

/** The mode actually in force under a cap: never above maxMode. */
export function capMode(mode: PermissionMode, maxMode: PermissionMode | undefined): PermissionMode {
	return maxMode !== undefined && modeRank(mode) > modeRank(maxMode) ? maxMode : mode;
}

/** Shift+Tab: the next mode in order, wrapping, skipping what the cap or an unavailable yolo rule out. */
export function nextMode(mode: PermissionMode, options: { maxMode?: PermissionMode; yoloAvailable: boolean }): PermissionMode {
	const reachable = PERMISSION_MODES.filter((candidate) => modeRank(candidate) <= modeRank(options.maxMode ?? "yolo") && (candidate !== "yolo" || options.yoloAvailable));
	if (reachable.length === 0) return "plan";
	const index = reachable.indexOf(mode);
	return reachable[(index + 1) % reachable.length] ?? reachable[0]!;
}

/** What a child may run under: at most the parent's mode, never yolo. */
export function childMode(parent: PermissionMode): PermissionMode {
	return parent === "yolo" ? "auto" : parent;
}

// --- bash classification -------------------------------------------------------

// Commands that only observe. Anything not listed, any redirection, substitution
// or background job makes the whole command "mutating": a false "mutating"
// costs one confirmation, a false "read-only" could cost a file.
const READ_ONLY_COMMANDS = new Set([
	"cat", "head", "tail", "less", "more", "wc", "ls", "ll", "tree", "pwd", "echo", "printf", "true", "false", "type", "which", "whereis", "file", "stat", "du", "df",
	"grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "locate", "awk", "sed", "cut", "sort", "uniq", "tr", "diff", "cmp", "comm", "jq", "yq", "xargs", "env", "printenv", "date", "uname", "whoami", "id", "hostname", "uptime",
	"test", "[", "cd", "basename", "dirname", "realpath", "readlink", "md5sum", "sha256sum", "sha1sum", "base64", "od", "xxd", "strings", "column", "nl", "tac", "rev", "seq", "expr", "bc", "sleep", "time",
	"node", "python", "python3", "ruby", "perl", "deno", "bun", "go", "cargo", "rustc", "tsc", "npx", "pnpx", "pnpm", "npm", "yarn", "bunx", "make", "pytest", "jest", "vitest", "mocha", "eslint", "prettier", "biome", "tsx", "rtk",
	"git", "gh", "docker", "kubectl", "aws", "terraform",
]);
// Interpreters and package managers only count as read-only with a known
// read-only verb; a bare `node script.js` or `pnpm run anything` may write.
const SUBCOMMAND_RULES: Record<string, RegExp> = {
	git: /^(status|log|diff|show|blame|describe|rev-parse|rev-list|ls-files|ls-tree|cat-file|shortlog|whatchanged|reflog|branch|tag|remote|stash\s+list|config\s+(--get|--list|-l|--get-regexp)|grep|fetch|version|help|worktree\s+list|name-rev|merge-base|cherry|count-objects|fsck|var|check-ignore|check-attr)(\s|$)/,
	gh: /^(pr\s+(view|list|diff|checks|status)|issue\s+(view|list|status)|repo\s+view|run\s+(view|list|watch)|api\s+(?!.*--method\s+(POST|PUT|PATCH|DELETE))(?!.*-X\s+(POST|PUT|PATCH|DELETE))|auth\s+status|release\s+(view|list)|search|status|version|help)(\s|$)/,
	docker: /^(ps|images|logs|inspect|version|info|stats|top|port|diff|history|search)(\s|$)/,
	kubectl: /^(get|describe|logs|top|version|explain|api-resources|api-versions|cluster-info|config\s+(view|current-context|get-contexts))(\s|$)/,
	aws: /^(sts\s+get-caller-identity|\S+\s+(describe|list|get)-[a-z-]+)(\s|$)/,
	terraform: /^(plan|show|validate|fmt\s+-check|output|providers|version|state\s+(list|show)|graph)(\s|$)/,
	pnpm: /^(test|run\s+(test|typecheck|lint|check|build:check|test:[\w:-]+|check:[\w:-]+|lint:[\w:-]+)|ls|list|why|outdated|audit|-v|--version|exec\s+(tsc|eslint|prettier|biome|vitest|jest)\b)(\s|$)/,
	npm: /^(test|run\s+(test|typecheck|lint|check|test:[\w:-]+|check:[\w:-]+|lint:[\w:-]+)|ls|list|view|info|outdated|audit|-v|--version)(\s|$)/,
	yarn: /^(test|run\s+(test|typecheck|lint|check)|list|info|why|outdated|audit|-v|--version)(\s|$)/,
	npx: /^(tsc|eslint|prettier\s+(--check|-c)|biome\s+(check|lint)|vitest|jest|mocha)(\s|$)/,
	pnpx: /^(tsc|eslint|vitest|jest)(\s|$)/,
	bunx: /^(tsc|eslint|vitest|jest)(\s|$)/,
	node: /^(--test|--version|-v|--check|-c|-e\s+|--eval\s+|--experimental-strip-types\s+--test)(\s|$)/,
	bun: /^(test|--version)(\s|$)/,
	deno: /^(test|check|lint|fmt\s+--check|--version)(\s|$)/,
	go: /^(test|vet|version|list|doc|env)(\s|$)/,
	cargo: /^(test|check|clippy|doc|tree|metadata|--version)(\s|$)/,
	make: /^(test|check|lint|-n|--dry-run)(\s|$)/,
	python: /^(-m\s+(pytest|unittest|py_compile|json\.tool)|--version|-V|-c\s+)(\s|$)/,
	python3: /^(-m\s+(pytest|unittest|py_compile|json\.tool)|--version|-V|-c\s+)(\s|$)/,
	ruby: /^(-v|--version|-c\s+)(\s|$)/,
	perl: /^(-v|--version|-c\s+)(\s|$)/,
	tsx: /^(--test)(\s|$)/,
	rustc: /^(--version|-V)(\s|$)/,
	tsc: /^(--noEmit|--version|-v|-p\s|--project\s|$)/,
	rtk: /./,
};
const WRAPPERS = new Set(["rtk", "time", "env", "nice", "command", "builtin", "sudo", "doas", "xargs"]);

export type BashClass = "read-only" | "mutating";

/**
 * Conservative read-only detection for the bash tool. Each pipeline segment
 * must start with a known read-only program (and verb, for interpreters and
 * package managers); redirections, substitutions, heredocs, background jobs
 * and `sed -i` all count as mutating.
 */
export function classifyBashCommand(command: string): BashClass {
	const text = command.trim();
	if (text.length === 0) return "read-only";
	// `&&` chains are fine; a lone `&` backgrounds a job we could not observe.
	if (/[^&]&[^&]|^&|&$/.test(text.replace(/&&/g, " AND "))) return "mutating";
	if (/(^|[^<>])>|<<|\$\(|`|\bsed\b[^|;&\n]*\s-[a-zA-Z]*i|\bperl\b[^|;&\n]*\s-[a-zA-Z]*i|\bsudo\b|\bdoas\b|\btee\b/.test(text)) return "mutating";
	const segments = text.split(/\|\||&&|\||;|\n/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
	for (let segment of segments) {
		// Leading variable assignments and wrappers (`FOO=1 rtk git status`) are peeled off.
		for (;;) {
			const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(segment);
			if (assignment) { segment = segment.slice(assignment[0].length); continue; }
			const first = segment.split(/\s+/)[0] ?? "";
			if (WRAPPERS.has(first) && first !== "sudo" && first !== "doas" && first !== "xargs") { segment = segment.slice(first.length).trim(); continue; }
			break;
		}
		const words = segment.split(/\s+/);
		const program = (words[0] ?? "").replace(/^.*\//, "");
		if (program.length === 0 || !READ_ONLY_COMMANDS.has(program)) return "mutating";
		const rule = SUBCOMMAND_RULES[program];
		if (rule && !rule.test(words.slice(1).join(" "))) return "mutating";
		if (program === "git" && /^(branch|tag|remote)$/.test(words[1] ?? "") && /(^|\s)(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force|--edit|--set-upstream|--set-upstream-to|-u|add|rename|remove|rm|set-url|prune|set-head)(\s|$)/.test(words.slice(2).join(" "))) return "mutating";
	}
	return "read-only";
}

// --- the decision -----------------------------------------------------------------

export type ToolKind = "read" | "write" | "bash" | "delegate" | "other";

export function toolKind(toolName: string): ToolKind {
	if (toolName === "write" || toolName === "edit") return "write";
	if (toolName === "bash") return "bash";
	if (toolName === "subagent_run" || toolName === "subagent_continue") return "delegate";
	if (/^(read|grep|find|ls|codegraph(_\w+)?|gentle_review_scope|subagent_(status|result|list_agents|list_tasks)|orchestrator_(list|session_id)|mcp__context7)$/.test(toolName)) return "read";
	return "other";
}

export interface Decision {
	action: "allow" | "ask" | "deny";
	/** Short reason, shown to the model on deny and in the confirmation title on ask. */
	reason: string;
}

export interface DecideInput {
	mode: PermissionMode;
	toolName: string;
	input: unknown;
	/** True when the target path of a write/edit is inside the repository/cwd. */
	insideRepository?: boolean;
	/** Agents whose dispatch counts as read-only exploration (never write). */
	readOnlyAgents?: readonly string[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The mode's verdict for one tool call. Guardrails run separately and after:
 * an "allow" here never bypasses a configured confirm/block.
 */
export function decide(input: DecideInput): Decision {
	const kind = toolKind(input.toolName);
	const mode = input.mode;
	const label = MODE_LABEL[mode];
	if (kind === "read" || kind === "other") return { action: "allow", reason: `${label}: read-only tool` };
	if (kind === "delegate") {
		const agent = record(input.input) && typeof input.input.agent === "string" ? input.input.agent : "";
		const readOnly = (input.readOnlyAgents ?? ["nubia-explore"]).includes(agent) || /explore/i.test(agent);
		if (mode === "plan" && !readOnly) return { action: "deny", reason: `${label} mode: only exploration subagents may run; delegating "${agent || "a writer"}" would change files. Ask the human to switch mode (Shift+Tab or ${cmdSlash("mode")}).` };
		if (mode === "manual" && !readOnly) return { action: "ask", reason: `Delegate to ${agent || "a subagent"}?` };
		return { action: "allow", reason: `${label}: delegation` };
	}
	if (kind === "write") {
		const path = record(input.input) && typeof input.input.path === "string" ? input.input.path : "a file";
		if (mode === "plan") return { action: "deny", reason: `${label} mode is read-only: writing ${path} is not allowed. Propose the change instead, or ask the human to switch mode (Shift+Tab or ${cmdSlash("mode")}).` };
		if (mode === "manual") return { action: "ask", reason: `Write ${path}?` };
		if (mode === "accept-edits" && input.insideRepository === false) return { action: "ask", reason: `Write ${path} (outside the repository)?` };
		return { action: "allow", reason: `${label}: edits accepted` };
	}
	// bash
	const command = record(input.input) && typeof input.input.command === "string" ? input.input.command : "";
	const bashClass = classifyBashCommand(command);
	if (bashClass === "read-only") return { action: "allow", reason: `${label}: read-only command` };
	if (mode === "plan") return { action: "deny", reason: `${label} mode is read-only: this command may change files or state. Describe what you would run, or ask the human to switch mode (Shift+Tab or ${cmdSlash("mode")}).` };
	if (mode === "manual" || mode === "accept-edits") return { action: "ask", reason: "Run this command?" };
	return { action: "allow", reason: `${label}: commands run; guardrails still apply` };
}

// --- system directive (T7.8) ------------------------------------------------------------

const DIRECTIVE_OPEN = "<nubia-permission-mode";
const DIRECTIVE_CLOSE = "</nubia-permission-mode>";

/**
 * One line, only when the mode changes what the agent may do. `auto` is the
 * default behaviour and adds nothing, so the system prompt stays as lean as Pi's.
 */
export function modeDirective(mode: PermissionMode): string | undefined {
	const tail = `The human changes it (Shift+Tab or ${cmdSlash("mode")}); guardrails and ask_user still apply.`;
	switch (mode) {
		case "plan":
			return `${DIRECTIVE_OPEN} mode="plan">Permission mode PLAN: read-only. Analyse and propose as text; write/edit, mutating commands and writer delegation are rejected. ${tail}${DIRECTIVE_CLOSE}`;
		case "manual":
			return `${DIRECTIVE_OPEN} mode="manual">Permission mode MANUAL: writes, mutating commands and writer delegation are confirmed by the human in a dialog; do not also ask in prose. ${tail}${DIRECTIVE_CLOSE}`;
		case "accept-edits":
			return `${DIRECTIVE_OPEN} mode="accept-edits">Permission mode ACCEPT EDITS: edits inside the repository run; mutating commands are confirmed by the human. ${tail}${DIRECTIVE_CLOSE}`;
		case "auto":
			return undefined;
		case "yolo":
			return undefined; // the YOLO session directive already carries the grant
		default:
			return undefined;
	}
}

/** Replaces any previous mode directive with the current one (idempotent, like updateYoloPrompt). */
export function updateModePrompt(options: AppendableSystemPromptOptions | null | undefined, mode: PermissionMode): void {
	if (!options) return;
	const current = options.appendSystemPrompt ?? "";
	const stripped = current.replace(new RegExp(`\\n*${DIRECTIVE_OPEN}[\\s\\S]*?${DIRECTIVE_CLOSE}`, "g"), "");
	options.appendSystemPrompt = stripped;
	const directive = modeDirective(mode);
	if (directive) appendSystemPromptOnce(options, directive);
}

// --- persisted default ------------------------------------------------------------------

export function parseStoredMode(text: string | undefined): PersistableMode | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as { mode?: unknown };
		return isPersistableMode(parsed.mode) ? parsed.mode : undefined;
	} catch {
		return undefined;
	}
}

export function serializeStoredMode(mode: PersistableMode): string {
	return `${JSON.stringify({ mode }, null, 2)}\n`;
}
