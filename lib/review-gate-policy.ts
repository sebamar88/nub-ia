// Review gate policy for Nub-IA: whether `git push` is gated on a `nub_review`
// of the changes being delivered, and how hard. Replaces the gentle-ai
// `review mode` switch with the same ergonomics (status | enable | disable) on
// the in-process review. No Pi imports; file I/O only through the config home
// helpers so the legacy ~/.pi/gentle-ai location keeps being honoured.
//
//   confirm  (default) unreviewed/blocked changes ask for confirmation before the push
//   strict             they are refused; run nub_review until APPROVE/WARN, then push
//   off                the push is never gated
//
// Resolution: the user's choice is the global file, then NUB_IA_REVIEW_GATE,
// then the default. A project file `.pi/nub-ia/review-gate.json` is
// repository content (it may come from a clone, or be written by the model
// through the write tool), so it may only TIGHTEN the user's choice: a
// project `strict` wins over a user `confirm`, a project `off` never turns a
// user's gate off. A malformed file fails closed to `confirm` and stays
// attributed to that file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import { configReadPath, projectConfigReadPath } from "./config-home.ts";

export const REVIEW_GATE_MODES = ["confirm", "strict", "off"] as const;
export type ReviewGateMode = (typeof REVIEW_GATE_MODES)[number];
export const REVIEW_GATE_SCHEMA = "nub-ia.review-gate/v1";
export const REVIEW_GATE_FILE = "review-gate.json";
export const REVIEW_GATE_ENV = "NUB_IA_REVIEW_GATE";
export const DEFAULT_REVIEW_GATE_MODE: ReviewGateMode = "confirm";

export type ReviewGateSource = "project_file" | "global_file" | "environment" | "default";

export interface ReviewGateResolution {
	mode: ReviewGateMode;
	source: ReviewGateSource;
	malformed: boolean;
	projectFile: string;
	globalFile: string;
}

export function isReviewGateMode(value: unknown): value is ReviewGateMode {
	return typeof value === "string" && (REVIEW_GATE_MODES as readonly string[]).includes(value);
}

/** Strict decode of {"schema":"nub-ia.review-gate/v1","mode":"confirm"|"strict"|"off"}. */
export function parseReviewGateFile(raw: string): ReviewGateMode | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.schema !== REVIEW_GATE_SCHEMA || !isReviewGateMode(record.mode) || Object.keys(record).length !== 2) return undefined;
	return record.mode;
}

export interface ResolveReviewGateOptions {
	configHome?: string;
	env?: Record<string, string | undefined>;
}

const STRICTNESS: Record<ReviewGateMode, number> = { off: 0, confirm: 1, strict: 2 };

function readModeFile(path: string): { present: boolean; mode?: ReviewGateMode; malformed: boolean } {
	if (!existsSync(path)) return { present: false, malformed: false };
	try {
		const mode = parseReviewGateFile(readFileSync(path, "utf8"));
		return { present: true, mode, malformed: mode === undefined };
	} catch {
		return { present: true, malformed: true };
	}
}

export function resolveReviewGate(cwd: string, options: ResolveReviewGateOptions = {}): ReviewGateResolution {
	const env = options.env ?? process.env;
	const configHome = options.configHome ?? gentlePiConfigHome();
	const projectFile = projectConfigReadPath(cwd, REVIEW_GATE_FILE);
	const globalFile = configReadPath(configHome, REVIEW_GATE_FILE, env);

	// The user's own decision.
	const global = readModeFile(globalFile);
	let user: { mode: ReviewGateMode; source: ReviewGateSource; malformed: boolean };
	if (global.present) user = { mode: global.mode ?? DEFAULT_REVIEW_GATE_MODE, source: "global_file", malformed: global.malformed };
	else if (isReviewGateMode(env[REVIEW_GATE_ENV])) user = { mode: env[REVIEW_GATE_ENV] as ReviewGateMode, source: "environment", malformed: false };
	else user = { mode: DEFAULT_REVIEW_GATE_MODE, source: "default", malformed: false };

	// Repository content can only raise the bar.
	const project = readModeFile(projectFile);
	if (project.present && project.mode === undefined) {
		// Malformed: fail closed to at least confirm, attributed to the file.
		const mode: ReviewGateMode = user.mode === "off" ? "confirm" : user.mode;
		return { mode, source: "project_file", malformed: true, projectFile, globalFile };
	}
	if (project.present && project.mode !== undefined && STRICTNESS[project.mode] > STRICTNESS[user.mode]) {
		return { mode: project.mode, source: "project_file", malformed: false, projectFile, globalFile };
	}
	return { ...user, projectFile, globalFile };
}

/** Writes the global policy file (always the nub-ia config home), returning its path. */
export function writeGlobalReviewGate(mode: ReviewGateMode, configHome: string = gentlePiConfigHome()): string {
	mkdirSync(configHome, { recursive: true });
	const path = join(configHome, REVIEW_GATE_FILE);
	writeFileSync(path, `${JSON.stringify({ schema: REVIEW_GATE_SCHEMA, mode }, null, 2)}\n`);
	return path;
}

export function describeReviewGate(resolution: ReviewGateResolution): string {
	const where =
		resolution.source === "project_file" ? `project file ${resolution.projectFile}`
		: resolution.source === "global_file" ? `global file ${resolution.globalFile}`
		: resolution.source === "environment" ? `${REVIEW_GATE_ENV} environment variable`
		: "default";
	const broken = resolution.malformed ? " (file malformed: failed closed to confirm)" : "";
	const note = resolution.source === "project_file" ? " A repository file can only tighten your setting, never relax it." : "";
	return `Review gate: ${resolution.mode} — decided by ${where}${broken}.${note}`;
}

/** The `/nubia:review-mode` sub-actions mapped to modes; `enable` restores the default confirm mode. */
export const REVIEW_MODE_ACTIONS: Readonly<Record<string, ReviewGateMode>> = { enable: "confirm", confirm: "confirm", strict: "strict", disable: "off", off: "off" };
