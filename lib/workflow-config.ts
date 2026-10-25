// Development Workflow: how intent is shaped and decomposed before it is executed.
//   none = request-oriented adaptive execution (the historical behavior)
//   sdd  = Spec -> Design -> Tasks -> delegated execution
//   svsd = Spec -> Backlog -> Story -> Pair (story-oriented paired execution)
// Not a permission mode and not a policy: it never widens or narrows what the
// agent may do, so a repository may choose it (like the prompt profile) and the
// tighten-only rule of docs/governance.md does not apply. Permission modes,
// guardrails, review and push gates apply identically under every workflow.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppendableSystemPromptOptions } from "./append-system-prompt.ts";
import { appendSystemPromptOnce } from "./append-system-prompt.ts";
import { nubIaConfigHome } from "./config-home.ts";

export const WORKFLOWS = ["none", "sdd", "svsd"] as const;
export type DevelopmentWorkflow = (typeof WORKFLOWS)[number];
/** Existing repositories must not suddenly enter a multi-step planning flow. */
export const DEFAULT_WORKFLOW: DevelopmentWorkflow = "none";
export const WORKFLOW_SCHEMA = "nub-ia.workflow/v1";
export const WORKFLOW_FILE = "workflow.json";
export const WORKFLOW_ENV = "NUB_IA_WORKFLOW";

export function isWorkflow(value: unknown): value is DevelopmentWorkflow {
	return typeof value === "string" && (WORKFLOWS as readonly string[]).includes(value);
}

/** Strict decoder: exactly `{schema, default}` with a known workflow, anything else is ignored. */
export function parseWorkflowFile(text: string | undefined): DevelopmentWorkflow | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		const keys = Object.keys(parsed);
		if (parsed.schema !== WORKFLOW_SCHEMA || keys.length !== 2 || !keys.includes("default")) return undefined;
		return isWorkflow(parsed.default) ? parsed.default : undefined;
	} catch {
		return undefined;
	}
}

export interface WorkflowResolution {
	workflow: DevelopmentWorkflow;
	source: "session" | "environment" | "project-file" | "user-file" | "default";
}

/** Environment (one session) > repository file > user file > default `none`. */
export function resolveWorkflow(input: { env?: NodeJS.ProcessEnv; cwd?: string; configHome?: string; read?: (path: string) => string | undefined } = {}): WorkflowResolution {
	const env = input.env ?? process.env;
	const read = input.read ?? ((path: string) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } });
	if (isWorkflow(env[WORKFLOW_ENV])) return { workflow: env[WORKFLOW_ENV] as DevelopmentWorkflow, source: "environment" };
	if (input.cwd) {
		const project = parseWorkflowFile(read(join(input.cwd, ".pi", "nub-ia", WORKFLOW_FILE)));
		if (project) return { workflow: project, source: "project-file" };
	}
	const user = parseWorkflowFile(read(join(input.configHome ?? nubIaConfigHome(env), WORKFLOW_FILE)));
	if (user) return { workflow: user, source: "user-file" };
	return { workflow: DEFAULT_WORKFLOW, source: "default" };
}

/** Persists the user-level default. Repo-level files are written by the user or `nub-ia init`, never by the agent. */
export function writeWorkflow(workflow: DevelopmentWorkflow, configHome: string = nubIaConfigHome()): string {
	mkdirSync(configHome, { recursive: true });
	const path = join(configHome, WORKFLOW_FILE);
	writeFileSync(path, `${JSON.stringify({ schema: WORKFLOW_SCHEMA, default: workflow }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

// --- system directive ---------------------------------------------------------------------
// Same shape as the permission-mode directive: tag-delimited, idempotent, absent for `none`.
// The method itself lives in lazily loaded skills, never in the always-on prompt.

const DIRECTIVE_OPEN = "<nubia-workflow";
const DIRECTIVE_CLOSE = "</nubia-workflow>";
const DIRECTIVE_TAIL = "Trivial requests skip this ceremony. Permission mode, review and push gates are unchanged.";

export function workflowDirective(workflow: DevelopmentWorkflow): string | undefined {
	switch (workflow) {
		case "sdd":
			return `${DIRECTIVE_OPEN} workflow="sdd">Development workflow SDD: shape non-trivial feature work as Spec, Design, Tasks, then execute Task by Task (delegation allowed). Get the human's go-ahead before moving to the next phase. Method: skill nubia-spec-design-tasks. ${DIRECTIVE_TAIL}${DIRECTIVE_CLOSE}`;
		case "svsd":
			return `${DIRECTIVE_OPEN} workflow="svsd">Development workflow SVSD: Spec, Backlog, Story, Pair. The Story is the unit of value and execution: never split it into horizontal phases (database, backend, frontend, tests). Do not invent requirements; refine one Story at a time; implement in small verified steps where the human navigates and you drive. Never cross a phase boundary without the human's explicit go-ahead. Load only the current phase's skill: nubia-svsd-spec, nubia-svsd-backlog, nubia-svsd-story or nubia-svsd-pair. ${DIRECTIVE_TAIL}${DIRECTIVE_CLOSE}`;
		default:
			return undefined;
	}
}

/** Replaces any previous workflow directive with the current one. */
export function updateWorkflowPrompt(options: AppendableSystemPromptOptions | null | undefined, workflow: DevelopmentWorkflow): void {
	if (!options) return;
	options.appendSystemPrompt = (options.appendSystemPrompt ?? "").replace(new RegExp(`\\n*${DIRECTIVE_OPEN}[\\s\\S]*?${DIRECTIVE_CLOSE}`, "g"), "");
	const directive = workflowDirective(workflow);
	if (directive) appendSystemPromptOnce(options, directive);
}
