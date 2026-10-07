import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import { recognizeDestructiveCommands } from "../lib/destructive-command-guard.ts";
import { blockChildDestructiveCommand } from "./child-safety.ts";
import { canonicalHash } from "../lib/canonical-hash.ts";
import { allowedEditSurfaces as hasTaskScopedAllowedEditSurfaces, rejectUnscopedBoundedWriterDispatch } from "../lib/bounded-writer-admission.ts";
import { isOddPhase, oddPhaseRegistry, ODD_PHASES } from "../lib/odd-phase.ts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import {
	access,
	mkdir,
	readFile,
	readdir,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, isKeyRelease, matchesKey, truncateToWidth, type KeybindingsManager, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { resolveGentlePiAgentHome, gentlePiConfigHome } from "../lib/agent-home.ts";
import {
	BACKGROUND_SUBAGENTS_FILE,
	BACKGROUND_SUBAGENTS_SCHEMA,
	loadBackgroundSubagentsPolicy,
	parseBackgroundSubagentsPolicyFile,
	resolveBackgroundSubagentsPolicy,
	type BackgroundSubagentsPolicy,
	type BackgroundSubagentsResolution,
} from "../lib/background-subagents-policy.ts";
import { installPackageAssets, getPackageAssetOwner, type PackageAssetOwner, isPackageManagedSddAsset, updatePackageManagedSddAgentOwnership } from "../lib/agent-assets.ts";
import {
	THINKING_LEVELS,
	normalizeModelConfig,
	isThinkingLevel,
	normalizeModelId,
	normalizeRoutingEntry,
	readSavedModelConfig as readModelRoutingAuthority,
	readSavedModelConfigAsync as readModelRoutingAuthorityAsync,
	type AgentModelConfig,
	type AgentRoutingEntry,
	type ModelConfigFileResult,
	type ThinkingLevel,
} from "../lib/model-routing-authority.ts";
import {
	bootstrapProfilesFile,
	buildProfileListItems,
	createProfile,
	deleteProfile,
	duplicateProfile,
	formatOrchestratorSelection,
	formatRoutingRow,
	isProfileOrchestratorKey,
	parseProfileExportTextWithDrops,
	PROFILE_ORCHESTRATOR_KEY,
	profileExportPath,
	profileExportReadPath,
	profilesReadFilePath,
	profileRoutingRows,
	profilesFilePath,
	readProfileOrchestrator,
	readProfilesFileResult,
	renameProfile,
	routingColumnWidths,
	serializeProfileExport,
	setActiveProfile,
	updateProfile,
	writeProfilesFileSync,
	type AgentProfilesFile,
	type ProfileListItem,
	type ProfileRoutingRow,
	type ProfilesFileReadResult,
	type ProfilesParseDrops,
} from "../lib/agent-profiles.ts";
import {
	clearProfilePinSync,
	evaluateProfilePin,
	readProfilePinStatus,
	REPO_PROFILE_DECLARATION_GITIGNORE_RULES,
	resolveProfilePin,
	writeProfilePinSync,
	type ProfilePinEvaluation,
	type ProfilePinSource,
	type ProfilePinStatus,
} from "../lib/agent-profile-pin.ts";
import { bindSessionProfile, readSessionProfileBinding } from "../lib/session-profile-binding.ts";
import {
	applyOrchestratorSettings,
	readOrchestratorSettings,
	restoreOrchestratorSettings,
	type OrchestratorSettingsReadResult,
	parseOrchestratorModelRef,
} from "../lib/profiles-orchestrator.ts";
import { measureAgentsViewLayout, type AgentsViewLayout } from "../lib/agents-view-layout.ts";
import { NativeChoiceList } from "../lib/native-choice-list.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import { sanitizeTerminalText, stripAnsi } from "../lib/terminal-theme.ts";
import { registerYoloSessionPolicy, updateYoloPrompt } from "../lib/yolo-session-policy.ts";
import { configReadPath, projectConfigReadPath, projectConfigWritePath, readEnv, setLegacyHintNotifier } from "../lib/config-home.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = join(PACKAGE_ROOT, "assets");

function gentlePiAgentHome(): string {
	return resolveGentlePiAgentHome();
}

function packageAssetAudit(owner: PackageAssetOwner): { stale: number; overrides: number } {
	let stale = 0;
	let overrides = 0;
	for (const [assetSubdir, installedSubdir, ownershipPrefix] of [
		["agents", "agents", "agents"],
		["chains", "chains", "chains"],
		["support", join("gentle-ai", "support"), "gentle-ai/support"],
	] as const) {
		const assetDir = join(ASSETS_DIR, assetSubdir);
		if (!existsSync(assetDir)) continue;
		for (const entry of readdirSync(assetDir, { withFileTypes: true })) {
			if (!entry.isFile() || getPackageAssetOwner(`${ownershipPrefix}/${entry.name}`) !== owner) continue;
			const installedPath = join(gentlePiAgentHome(), installedSubdir, entry.name);
			try {
				if (!existsSync(installedPath)) {
					stale += 1;
					continue;
				}
				if (
					!isPackageManagedSddAsset(
						installedPath,
						`${ownershipPrefix}/${entry.name}`,
					)
				) {
					overrides += 1;
					continue;
				}
				const packaged = readFileSync(join(assetDir, entry.name), "utf8");
				const installed = readFileSync(installedPath, "utf8");
				const comparablePackaged =
					assetSubdir === "agents"
						? updateFrontmatterRouting(packaged, undefined)
						: packaged;
				const comparableInstalled =
					assetSubdir === "agents"
						? updateFrontmatterRouting(installed, undefined)
						: installed;
				if (comparablePackaged !== comparableInstalled) {
					stale += 1;
				}
			} catch {
				stale += 1;
			}
		}
	}
	return { stale, overrides };
}

function packageAssetDiagnosticLines(cwd: string): string[] {
	return (["delegation", "review"] as const).flatMap((owner) => {
		const label = owner;
		const { stale, overrides } = packageAssetAudit(owner);
		const local = localAgentOverrideCount(cwd, owner);
		const lines = [`${stale > 0 ? "warn" : "pass"}: Global ${label} assets stale: ${stale} file(s)`];
		if (stale > 0) {
			lines[0] += ` — run /nubia:install-${owner} --force to refresh managed assets`;
		}
		if (overrides > 0) {
			lines.push(`info: Global ${label} user overrides: ${overrides} file(s); preserved, not package drift`);
		}
		if (local > 0) {
			lines.push(`warn: Active ${label} agent overrides: ${local} file(s) — active non-builtin ${label} agents shadow package assets; keep only intentional overrides`);
		}
		return lines;
	});
}

function localAgentOverrideCount(cwd: string, owner: PackageAssetOwner): number {
	const packageSddAgentsDir = join(ASSETS_DIR, "agents");
	const packageSddAgentNames = new Set(
		listAgentsFromDir(packageSddAgentsDir, "builtin")
			.filter((agent) =>
				getPackageAssetOwner(
					`agents/${relative(packageSddAgentsDir, agent.filePath).split(sep).join("/")}`,
				) === owner,
			)
			.map((agent) => agent.name),
	);
	let count = 0;
	for (const { dir, source, packageManaged } of discoverableNonBuiltinAgentRoots(cwd)) {
		if (packageManaged || !existsSync(dir)) continue;
		for (const agent of listAgentsFromDir(dir, source)) {
			if (packageSddAgentNames.has(agent.name)) count += 1;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Background subagents policy — project > global > env > default off
//
// The pure resolver (parseBackgroundSubagentsPolicyFile,
// resolveBackgroundSubagentsPolicy, loadBackgroundSubagentsPolicy, and their
// types/constants) lives in lib/background-subagents-policy.ts so the
// runtime side (extensions/gentle-agents.ts) can read the effective policy
// without importing the pi extension surface. Everything below this point
// (capability probing, report rendering, the global-file writer) stays here
// because it is specific to this extension's UI-facing surface.
// ---------------------------------------------------------------------------

type BackgroundSubagentsCapability = "ready" | "absent";

interface BackgroundSubagentsRendering {
	policy: BackgroundSubagentsPolicy;
	capability: BackgroundSubagentsCapability;
	singleShot?: boolean;
}

const DEFAULT_BACKGROUND_SUBAGENTS_RENDERING: BackgroundSubagentsRendering = {
	policy: "off",
	capability: "absent",
};

/** Write the global policy file, creating the config home when needed. */
function writeGlobalBackgroundSubagentsPolicy(
	policy: BackgroundSubagentsPolicy,
	configHome: string = gentleAiConfigHome(),
): string {
	const path = join(configHome, BACKGROUND_SUBAGENTS_FILE);
	mkdirSync(configHome, { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ schema: BACKGROUND_SUBAGENTS_SCHEMA, policy }, null, 2)}\n`,
	);
	return path;
}

function describeBackgroundSubagentsSource(
	resolution: BackgroundSubagentsResolution,
): string {
	switch (resolution.source) {
		case "project_file":
			return `project file ${resolution.projectFile}`;
		case "global_file":
			return `global file ${resolution.globalFile}`;
		case "environment":
			return "GENTLE_PI_BACKGROUND_SUBAGENTS";
		default:
			return "built-in default";
	}
}

/**
 * Report the effective policy, the source that decided it, and the resolved
 * capability, plus whatever the user needs to know about the sources that did
 * NOT decide. `wrote` names a policy this invocation just wrote to the global
 * file; a write that a higher-priority file outranks must never be reported as
 * if it had taken effect.
 */
function renderBackgroundSubagentsReport(
	resolution: BackgroundSubagentsResolution,
	capability: BackgroundSubagentsCapability,
	wrote?: BackgroundSubagentsPolicy,
): { message: string; type: "info" | "warning" } {
	const lines = [
		`background subagents: ${resolution.policy} (decided by ${describeBackgroundSubagentsSource(resolution)}; capability: ${capability})`,
	];
	if (wrote !== undefined) {
		lines.push(`Wrote ${wrote} to the global file ${resolution.globalFile}.`);
	}
	if (resolution.malformed) {
		const path =
			resolution.source === "project_file" ? resolution.projectFile : resolution.globalFile;
		lines.push(
			`${path} is present but malformed, so the policy fails closed to off and no lower-priority source is consulted.`,
		);
	}
	const outranksTheWrite = wrote !== undefined && resolution.source === "project_file";
	if (outranksTheWrite) {
		lines.push(
			`That global write does not take effect here: the project file ${resolution.projectFile} outranks it. Edit or remove that project file to let the global setting decide.`,
		);
	} else if (
		wrote === undefined &&
		resolution.source === "project_file" &&
		resolution.globalFileExists
	) {
		lines.push(
			`The global file ${resolution.globalFile} exists but is outranked by that project file.`,
		);
	}
	if (resolution.envValue !== undefined && resolution.source !== "environment") {
		lines.push(
			resolution.envValue === "on" || resolution.envValue === "off"
				? `GENTLE_PI_BACKGROUND_SUBAGENTS=${resolution.envValue} is set, but both files outrank it and it outranks the built-in default; it decides only when neither file exists.`
				: `GENTLE_PI_BACKGROUND_SUBAGENTS="${resolution.envValue}" is not a recognized value ("on" or "off"), so it is ignored.`,
		);
	}
	lines.push(
		"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
	);
	return {
		message: lines.join("\n"),
		type: resolution.malformed || outranksTheWrite ? "warning" : "info",
	};
}

const SUBAGENTS_PACKAGE_NAMES = ["pi-subagents-j0k3r", "pi-subagents"] as const;
const SUBAGENT_RUN_TOOL = "subagent_run";
const JUDGMENT_DAY_FIX_AGENT_NAME = "jd-fix-agent";
const JUDGMENT_DAY_ACTIVATION_HEADING = "## Judgment Day activation";
const JUDGMENT_DAY_ACTIVATION_SENTENCE = "User explicitly requested Judgment Day.";
const JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING = "## Exact authorized severe IDs";
const JUDGMENT_DAY_CORRECTION_BATCH_HEADING = "## Judgment Day correction batch";
const JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING = "## Exact frozen finding rows";
function hasJudgmentDayFixAgentReference(input: Record<string, unknown>): boolean {
	return input.agent === JUDGMENT_DAY_FIX_AGENT_NAME ||
		(Array.isArray(input.agent) && input.agent.includes(JUDGMENT_DAY_FIX_AGENT_NAME)) ||
		input.agents === JUDGMENT_DAY_FIX_AGENT_NAME ||
		(Array.isArray(input.agents) && input.agents.includes(JUDGMENT_DAY_FIX_AGENT_NAME));
}

function canonicalJudgmentDaySectionBodies(value: unknown, heading: string): string[][] {
	if (typeof value !== "string") return [];
	const headingPattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm");
	return [...value.matchAll(headingPattern)].map((match) => {
		const body = value.slice((match.index ?? 0) + match[0].length);
		const nextHeading = body.search(/^ {0,3}#{1,6} /m);
		return body
			.slice(0, nextHeading === -1 ? undefined : nextHeading)
			.split(/\r?\n/)
			.filter((line) => line.length > 0);
	});
}

const JUDGMENT_DAY_SEVERE_ID_ENTRY = /^- `(JD-[A-Z][A-Z0-9]*-\d+)`$/;
const JUDGMENT_DAY_CORRECTION_ROUND_ENTRY = /^Round: [12] of 2\.$/;
const JUDGMENT_DAY_FROZEN_LEDGER_SHA256_ENTRY = /^Frozen ledger SHA-256: `([0-9a-f]{64})`$/;
const JUDGMENT_DAY_FROZEN_ROW_FIELDS = [
	"id",
	"lens",
	"location",
	"severity",
	"status_at_freeze",
	"evidence_class",
	"evidence_claim",
] as const;
const JUDGMENT_DAY_FIX_SECTION_HEADINGS = [
	JUDGMENT_DAY_ACTIVATION_HEADING,
	JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING,
	JUDGMENT_DAY_CORRECTION_BATCH_HEADING,
	JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING,
	"## Allowed edit surfaces",
] as const;

function canonicalJudgmentDaySevereIds(entries: readonly string[]): string[] | undefined {
	const ids = entries.map((entry) => entry.match(JUDGMENT_DAY_SEVERE_ID_ENTRY)?.[1]);
	return ids.length > 0 && ids.every((id): id is string => id !== undefined) && new Set(ids).size === ids.length
		? ids
		: undefined;
}

function canonicalJudgmentDayCorrectionBatchHash(entries: readonly string[]): string | undefined {
	if (entries.length !== 2 || !JUDGMENT_DAY_CORRECTION_ROUND_ENTRY.test(entries[0]!)) return undefined;
	return entries[1]!.match(JUDGMENT_DAY_FROZEN_LEDGER_SHA256_ENTRY)?.[1];
}

function isNonEmptyJudgmentDayFrozenField(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseCanonicalJudgmentDayFrozenRows(
	entries: readonly string[],
	authorizedIds: readonly string[],
): Record<string, unknown>[] | undefined {
	if (entries.length !== authorizedIds.length) return undefined;
	const rows: Record<string, unknown>[] = [];
	const rowIds: string[] = [];
	for (const entry of entries) {
		let row: unknown;
		try {
			row = JSON.parse(entry) as unknown;
		} catch {
			return undefined;
		}
		if (!isRecord(row)) return undefined;
		const keys = Object.keys(row);
		if (keys.length !== JUDGMENT_DAY_FROZEN_ROW_FIELDS.length ||
			!JUDGMENT_DAY_FROZEN_ROW_FIELDS.every((field) => field in row) ||
			!isNonEmptyJudgmentDayFrozenField(row.id) ||
			!JUDGMENT_DAY_SEVERE_ID_ENTRY.test(`- \`${row.id}\``) ||
			row.lens !== "judgment-day" ||
			!isNonEmptyJudgmentDayFrozenField(row.location) ||
			(row.severity !== "BLOCKER" && row.severity !== "CRITICAL") ||
			row.status_at_freeze !== "open" ||
			!isNonEmptyJudgmentDayFrozenField(row.evidence_class) ||
			!isNonEmptyJudgmentDayFrozenField(row.evidence_claim)
		) return undefined;
		rows.push(row);
		rowIds.push(row.id);
	}
	return new Set(rowIds).size === rowIds.length &&
		rowIds.every((id, index) => id === authorizedIds[index])
		? rows
		: undefined;
}

function hasCanonicalJudgmentDayFixSectionOrder(...values: unknown[]): boolean {
	const dispatch = values.filter((value): value is string => typeof value === "string").join("\n");
	let previousPosition = -1;
	for (const heading of JUDGMENT_DAY_FIX_SECTION_HEADINGS) {
		const matches = [...dispatch.matchAll(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm"))];
		if (matches.length !== 1 || (matches[0]!.index ?? -1) <= previousPosition) return false;
		previousPosition = matches[0]!.index ?? -1;
	}
	return true;
}

function hasCanonicalJudgmentDayFixActivation(...values: unknown[]): boolean {
	const hasMalformedHeading = values.some((value) =>
		typeof value === "string" && value.split(/\r?\n/).some((line) => {
			const candidate = line.match(/^ {0,3}#{1,6} (Judgment Day activation|Exact authorized severe IDs|Judgment Day correction batch|Exact frozen finding rows)[ \t]*$/i);
			return candidate !== null &&
				line !== JUDGMENT_DAY_ACTIVATION_HEADING &&
				line !== JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING &&
				line !== JUDGMENT_DAY_CORRECTION_BATCH_HEADING &&
				line !== JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING;
		}),
	);
	const activationBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_ACTIVATION_HEADING),
	);
	const severeIdBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING),
	);
	const correctionBatchBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_CORRECTION_BATCH_HEADING),
	);
	const frozenFindingRowBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING),
	);
	const authorizedIds = severeIdBodies.length === 1
		? canonicalJudgmentDaySevereIds(severeIdBodies[0]!)
		: undefined;
	const correctionBatchHash = correctionBatchBodies.length === 1
		? canonicalJudgmentDayCorrectionBatchHash(correctionBatchBodies[0]!)
		: undefined;
	const frozenFindingRows = authorizedIds !== undefined && frozenFindingRowBodies.length === 1
		? parseCanonicalJudgmentDayFrozenRows(frozenFindingRowBodies[0]!, authorizedIds)
		: undefined;
	return !hasMalformedHeading && hasCanonicalJudgmentDayFixSectionOrder(...values) &&
		activationBodies.length === 1 &&
		activationBodies[0]!.length === 1 &&
		activationBodies[0]![0] === JUDGMENT_DAY_ACTIVATION_SENTENCE &&
		authorizedIds !== undefined && correctionBatchHash !== undefined &&
		frozenFindingRows !== undefined && correctionBatchHash === canonicalHash(frozenFindingRows);
}

const JUDGMENT_DAY_FIX_DISPATCH_REJECTION =
	"Judgment Day fix dispatch requires exactly one `agent: \"jd-fix-agent\"`, one exact `## Judgment Day activation` section containing only `User explicitly requested Judgment Day.`, one non-empty unique canonical `## Exact authorized severe IDs` section, one exact `## Judgment Day correction batch` section with `Round: 1 of 2.` or `Round: 2 of 2.` and the matching canonical lowercase SHA-256 of one exact `## Exact frozen finding rows` section whose BLOCKER/CRITICAL open Judgment Day rows equal the authorized IDs in the same order, and the existing exact `## Allowed edit surfaces` guard. The parent must provide the canonical bounded dispatch; do not infer activation, authorization, or frozen findings.";

function rejectInvalidJudgmentDayFixDispatch(input: unknown): { block: true; reason: string } | undefined {
	if (!isRecord(input) || !hasJudgmentDayFixAgentReference(input)) return undefined;
	if (
		input.agent === JUDGMENT_DAY_FIX_AGENT_NAME &&
		!("agents" in input) &&
		hasCanonicalJudgmentDayFixActivation(input.task, input.context) &&
		hasTaskScopedAllowedEditSurfaces(input.task, input.context)
	) {
		return undefined;
	}
	return { block: true, reason: JUDGMENT_DAY_FIX_DISPATCH_REJECTION };
}

/**
 * Roots where an installed subagents package may live. These are the same
 * roots builtinAgentDirs() walks, minus its `/agents` suffix.
 *
 * builtinAgentDirs() looks for markdown agent definitions, which the package
 * legitimately may not ship. Capability is a different question, so it must
 * not reuse that path: pi-subagents-j0k3r v1.5.2 ships index.ts, src/, skills/
 * and scripts/ and no agents/ directory at all, so an agents-dir probe reports
 * "absent" on every real install and leaves the background policy inert.
 */
function subagentsPackageRoots(cwd: string): string[] {
	return SUBAGENTS_PACKAGE_NAMES.flatMap((packageName) => [
		join(PACKAGE_ROOT, "..", packageName),
		join(cwd, ".pi", "npm", "node_modules", packageName),
		join(homedir(), ".local", "lib", "node_modules", packageName),
	]);
}

/** A package root counts as installed only when it carries its own manifest. */
function hasInstalledSubagentsPackage(cwd: string): boolean {
	return subagentsPackageRoots(cwd).some((root) =>
		existsSync(join(root, "package.json")),
	);
}

function hasSubagentRunTool(activeTools: readonly string[]): boolean {
	return activeTools.some(
		(name) => name === SUBAGENT_RUN_TOOL || name.endsWith(`.${SUBAGENT_RUN_TOOL}`),
	);
}

/**
 * Read the live pi tool registry, or undefined when it carries no signal.
 *
 * An absent handle, a non-array result, a throwing registry, and an empty list
 * are all "no signal" rather than "no subagents": reporting absent from an
 * uninformative registry would reproduce the very defect this probe fixes.
 */
function readActiveToolNames(pi: unknown): readonly string[] | undefined {
	try {
		const getActiveTools = (pi as { getActiveTools?: () => unknown })
			?.getActiveTools;
		if (typeof getActiveTools !== "function") return undefined;
		const tools = getActiveTools.call(pi);
		if (!Array.isArray(tools)) return undefined;
		const names = tools
			.map((tool) =>
				typeof tool === "string"
					? tool
					: isRecord(tool) && typeof tool.name === "string"
						? tool.name
						: "",
			)
			.filter((name) => name.length > 0);
		return names.length > 0 ? names : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `subagent_run` availability probe.
 *
 * The live tool registry answers the question directly and wins whenever it
 * carries any signal. Without it -- prompt rendering outside a session, or a
 * runtime with no getActiveTools -- capability falls back to the presence of
 * an installed subagents package.
 */
function resolveBackgroundSubagentsCapability(
	cwd: string,
	activeTools?: readonly string[],
): BackgroundSubagentsCapability {
	try {
		if (activeTools !== undefined && activeTools.length > 0) {
			return hasSubagentRunTool(activeTools) ? "ready" : "absent";
		}
		return hasInstalledSubagentsPackage(cwd) ? "ready" : "absent";
	} catch {
		return "absent";
	}
}

function renderBackgroundSubagentsStatusLine(
	background: BackgroundSubagentsRendering,
): string {
	if (background.singleShot) return `Background subagent policy: off (single-shot mode)`;
	return `Background subagent policy: ${background.policy} (capability: ${background.capability})`;
}

// gentle-shell#1731 T27: `pi -p` and `pi --mode json` run one prompt and then
// dispose the runtime, so background results can never arrive. Mirrors
// isSingleShotMode in extensions/gentle-agents.ts, which rejects the launch.
function isSingleShotHostMode(mode: string | undefined): boolean {
	return mode === "print" || mode === "json";
}

// Rendered prompts are memoized per background policy/capability key for the
// process lifetime; the asset bytes are read once per key.
const orchestratorPromptCache = new Map<string, string>();
function getOrchestratorPrompt(
	cwd: string = process.cwd(),
	activeTools?: readonly string[],
	hostMode?: string,
): string {
	const background: BackgroundSubagentsRendering = {
		policy: loadBackgroundSubagentsPolicy(cwd),
		capability: resolveBackgroundSubagentsCapability(cwd, activeTools),
		singleShot: isSingleShotHostMode(hostMode),
	};
	const cacheKey = `${background.policy}:${background.capability}:${background.singleShot}`;
	let prompt = orchestratorPromptCache.get(cacheKey);
	if (prompt === undefined) {
		prompt = renderOrchestratorPrompt(ASSETS_DIR, background);
		orchestratorPromptCache.set(cacheKey, prompt);
	}
	return prompt;
}

function renderOrchestratorPrompt(
	assetsDir: string,
	background: BackgroundSubagentsRendering = DEFAULT_BACKGROUND_SUBAGENTS_RENDERING,
): string {
	const backgroundPolicyBlock = renderBackgroundSubagentsStatusLine(background);
	return readFileSync(join(assetsDir, "orchestrator.md"), "utf8")
		.replaceAll("{{GENTLE_PI_ASSETS_ROOT}}", assetsDir)
		.replaceAll(
			"{{GENTLE_PI_BACKGROUND_POLICY}}",
			backgroundPolicyBlock,
		)
		.trim();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

type PersonaMode = "gentleman" | "neutral";

const PERSONA_OPTIONS = ["gentleman", "neutral"] as const;

const GENTLEMAN_PERSONA_PROMPT = `Persona:
- Be direct, technical, and concise.
- Always respond in the same language the user writes in.
- When the user writes Spanish, answer in natural Rioplatense Spanish with voseo.
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.`;

const NEUTRAL_PERSONA_PROMPT = `Persona:
- Be direct, technical, concise, warm, and professional.
- Always respond in the same language the user writes in.
- Do not use slang or regional expressions.
- When the user writes Spanish, use neutral/professional Spanish. Do NOT use voseo (vos tenés, vos querés, hacé, andá, etc.) or any regional conjugations.
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.`;

function buildGentlePrompt(
	persona: PersonaMode,
	cwd: string = process.cwd(),
	activeTools?: readonly string[],
	hostMode?: string,
): string {
	const personaPrompt =
		persona === "neutral" ? NEUTRAL_PERSONA_PROMPT : GENTLEMAN_PERSONA_PROMPT;
	const languageBoundary =
		persona === "neutral"
			? "Language: neutral/professional Spanish when the user writes Spanish. Do NOT use voseo or Rioplatense regional expressions."
			: "Language: natural Rioplatense Spanish with voseo when the user writes Spanish.";
	return `## Nub-IA Identity and Harness

Current persona mode: ${persona}

You are Nub-IA: the Nubiral team's Pi coding-agent harness for controlled development work.

Identity contract:
- When the user asks who or what you are, answer as Nub-IA, not as a generic assistant, and never introduce yourself as only "your assistant" or "the default assistant". Convey this meaning, translated into the user's language: "I am Nub-IA: a Pi-specific coding-agent harness for controlled development, with a senior architect persona. I run Organic Driven Development, coordinate subagents, track substantial work, run commands, and edit files. I am not a generic chatbot."
- Follow the currently selected persona mode.
- Mention ODD as the development workflow and subagents as a core capability.
- Mention memory only when memory packages or callable memory tools are actually active; never invent persistent memory.
- Do not claim portability outside the Pi runtime.

${personaPrompt}

${languageBoundary}

Default workflow: Organic Driven Development (MANDATORY)
Organic Driven Development (ODD) is the predefined workflow of this orchestrator. Every request enters it, without the user asking for a workflow, a plan, or task tracking. Never describe this workflow only when asked about it: run it. Run these steps in this order on every request:
1. **Authorize.** Investigation, explanation, review, comparison, and proposal-only requests stay read-only: no writer, apply, or implementation artifacts. Ambiguous or conditional change intent (unclear whether a change is authorized at all) gets one clarification; stop and wait. A user saying they may stop you or resume later asks for notes and separate commits, not a stop.
2. **Explore.** Explore existing code and requirements first, proportionately to the request, before proposing or writing anything. Do not delegate exploration of files you will read anyway to work inline; explore only for a map you need to decide or route.
3. **Resolve uncertainty.** Recommend optional research only for a named uncertainty; ask one focused user question only for a real unresolved product decision, then stop and wait; use at most one scoped read-only assumption challenge for a high-consequence unproven premise.
4. **Classify.** Size the task by the orchestrator's Task Size section: small when understood, risk is contained, and the work could be resumed from the original request and \`git diff\` alone; large only when that resume test fails. Never classify by counting files, commands, tests, fixes, or a requested todo list. Small work stays inline and creates no durable task artifacts.
5. **Track before the first write.** For large authorized implementation, create \`odd/tasks/<feature-name>.md\` and its Engram mirror \`odd/<feature-name>/tasks\` automatically, then create or rebuild the visible \`todo\` list from the reconciled feature tasks, all before the first source write and without asking permission for tasks or storage. Tell the user in one line which feature document was created and how many tasks it holds. The document is the specification subagents read, in this order: a two- or three-line header; \`## Specs\` with numbered \`S#\` that quote the user's exact strings, error messages, and examples verbatim, never summarized and never adding unrequested requirements; \`## Tasks\` with one line per task (ID, linked \`S#\`, route, commit); \`## Log\` last, where \`L1\` is the user's original request verbatim and later user corrections, evidence, and decisions are appended. A requirement change appends its verbatim Log entry, rewrites only the affected \`S#\`, and reopens only its task.
6. **Implement task by task.** Hand off by reference, never by paraphrase: name the document, task, and specs (for example \`Spec: odd/tasks/<feature>.md, T2, S3-S4\`), tell workers to read until \`## Log\`, and ask which \`S#\` were covered. Without a feature document, include the user's request verbatim. Verify reads the whole document, runs the spec's examples the parent authorized, against isolated state when they mutate data, and returns a verdict per \`S#\`. When the user reports a failure, reproduce it before deciding it already works. Each test asserts every observable effect of the rule it covers (exit code, exact stdout and stderr, and that rejected input leaves stored data and counters unchanged), covers the cases the rule itself names (its examples, boundaries, and errors), and checks through the public interface, never internal storage. When you add or change a command, option, or message, update the help text and docs that describe it. Route each task through the orchestrator's Mechanisms, honoring its mandatory delegation triggers, with applicable test-first development and checks. These triggers are mandatory, not advisory: executing past a fired trigger inline is a routing defect even if the work succeeds. Check an item off only after its outcome and checks were observed; update the file, mirror, and visible \`todo\` projection after every task transition and material plan change. Every tracked task closes with at least one work-unit commit on the feature branch, branch first when on the default branch, with tests and docs alongside the behavior, using a Conventional Commit message; record the commit identity in the feature document as evidence. Work-unit commits on the feature branch are part of authorized large ODD implementation; push, pull request creation, and merge remain the user's decisions.
7. **Close.** Report the verified outcome, every failed, skipped, or pending check, and the next step. Before writing \`Risk: none\`, check whether your diff changes code that existing behavior the request did not mention also uses (shared options, parsers, helpers); if it does, that is item 3. Never end with a tracked task pending unless you quote the user's explicit stop. An applicable quick check runs once; an unavailable verifier or subagent is reported as unavailable, never retried or escalated into extra ceremony. Partial, blocked, unavailable, or exhausted proof becomes one **Needs your decision** result naming the open blockers or missing proof, never more verification; that result is a valid stop, hedged wording is not. For a non-trivial change, run \`nub_review\` over the diff before delivery and address its BLOCKER/CRITICAL findings; the push gate asks for confirmation when changes were not reviewed or were blocked.
Phase reporting: the Gentle Shell prompt label is inferred automatically from the primary session's tool activity (reads show \`exploring\`, edits \`implementing\`, test runs \`checking\`, user questions \`deciding\`). When the \`gentle_odd_phase\` tool is available, use it to refine that label with phases tools cannot show (\`authorizing\`, \`researching\`, \`deciding\`, \`closing\`): call \`gentle_odd_phase\` only when the primary session's ODD phase actually changes, never per tool call or on a fixed cadence, and never from a subagent. It drives the Gentle Shell prompt label only.
Resume an interrupted feature with \`mem_context\`, then project- and feature-scoped \`mem_search\`, then \`mem_get_observation\` for the full document, then the task file itself; reconcile before continuing the next unfinished task. Detail for steps 3–7: \`orchestrator-delegation.md\` and \`orchestrator-memory.md\`.

Harness principles:
- Nub-IA is not prompt engineering. It is runtime discipline around powerful agents.
- Organic Driven Development (ODD) is the predefined workflow for every request: authorize, explore, resolve uncertainty, classify, track large work before the first write, implement task by task with proportionate checks, close each tracked task with a work-unit commit, and close.
- Clarify scope, constraints, acceptance criteria, and non-goals before implementation.
- Use subagents when available for exploration, planning, implementation, and review, while keeping one parent session responsible for orchestration.
- Parallel writers only with disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees.
- For behavior changes with applicable runnable deterministic tests and a clear expected outcome, use test-first by default: observe RED, GREEN, then refactor with focused checks. Write one RED test per requested rule. For every existing command or option the change touches, add one test proving its previous behavior still holds; add no other cases. An existing behavior counts as touched when it shares the code you changed (options, parsers, helpers, validation). Test presence alone does not establish applicability; no chat or TUI toggle activates it. For passive documentation, non-testable changes, an unavailable runner, or no meaningful RED, explain why and run proportionate ordinary functional or structural verification. Never invent lifecycle evidence or skip checks. Follow orchestrator-delegation.md for ODD forwarding and evidence.
- Protect the human reviewer: avoid oversized changes, surface review workload risk, and ask before turning one task into a large multi-area change.
- Never claim persistent memory is available because of this package. Memory is provided by separate packages or MCP tools when installed and callable.

${getOrchestratorPrompt(cwd, activeTools, hostMode)}`;
}

// Matches `git [global-flags] push` — tolerates flags like -C /repo or --work-tree=/tmp
// between `git` and the subcommand. Short flags may be followed by a separate value token.
const GIT_GLOBAL_FLAGS_SRC = String.raw`(?:\s+--?\S+(?:\s+[^-\s]\S*)?)* `;
const GIT_PUSH_RE = new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS_SRC}(push)\b`);

const DENIED_BASH_PATTERNS: RegExp[] = [
	// Block rm -rf targeting /, ~ or ~/subdir, $HOME or $HOME/subdir, .. or .
	/\brm\s+-rf\s+(?:\/(?:\s|$)|~(?:\/|\s|$)|[$]HOME(?:\/|\s|$)|\.\.?(?:\s|$))/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b(?=[^\n]*(?:-[^\n]*f|--force))(?=[^\n]*(?:-[^\n]*d|--directories))/,
	// Force-push deny: tolerates git global flags (e.g. -C /repo) before the subcommand
	new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS_SRC}push\b(?=[^\r\n;&|]*\s--force(?:-with-lease)?\b)`),
	new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS_SRC}push\b(?=[^\r\n;&|]*\s-[^\s-]*f)`),
	/\bchmod\s+-R\s+777\b/,
	/\bchown\s+-R\b/,
];

// ---------------------------------------------------------------------------
// Autonomous guard — runtime guardrails config
// ---------------------------------------------------------------------------

const GUARD_ACTION = {
	ALLOW: "allow",
	CONFIRM: "confirm",
	BLOCK: "block",
} as const;

type GuardAction = (typeof GUARD_ACTION)[keyof typeof GUARD_ACTION];
type GuardClassification = GuardAction | "not-guarded";

interface GuardMatch {
	key: GuardedCommandKey;
	action: GuardAction;
	triggerIndex: number;
}

interface GuardEvaluation {
	action: GuardClassification;
	dataLoss?: boolean;
	key?: GuardedCommandKey;
	triggerIndex: number;
	matches: GuardMatch[];
}

const GUARDED_COMMAND_KEY = {
	GIT_PUSH: "gitPush",
	GIT_REBASE: "gitRebase",
	GIT_BRANCH_DELETE_FORCE: "gitBranchDeleteForce",
	NPM_PUBLISH: "npmPublish",
	PI_REMOVE: "piRemove",
} as const;

type GuardedCommandKey = (typeof GUARDED_COMMAND_KEY)[keyof typeof GUARDED_COMMAND_KEY];

type GuardedCommandsConfig = Partial<Record<GuardedCommandKey, GuardAction>>;

interface RuntimeGuardrailsConfig {
	autonomousMode: boolean;
	guardedCommands: GuardedCommandsConfig;
}

interface LoadGuardrailsOptions {
	/** Override the config home directory (used in tests to avoid touching ~/.pi). */
	gentlePiConfigHome?: string;
}

const GUARDED_KEY_PATTERNS: Record<GuardedCommandKey, RegExp> = {
	gitPush: GIT_PUSH_RE,
	gitRebase: /\bgit\s+(rebase)\b/,
	gitBranchDeleteForce: /\bgit\s+(branch)\s+(?:-[a-zA-Z]*D[a-zA-Z]*|-[a-zA-Z]*d[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*|--delete\b[^\r\n;&|]*--force\b|--force\b[^\r\n;&|]*--delete\b)/,
	npmPublish: /\bnpm\s+(publish)\b/,
	piRemove: /\bpi\s+(remove)\b/,
};

const AUTONOMOUS_DEFAULT_ACTIONS: Record<GuardedCommandKey, GuardAction> = {
	gitPush: "allow",
	gitRebase: "confirm",
	gitBranchDeleteForce: "confirm",
	npmPublish: "block",
	piRemove: "confirm",
};

const GUARDED_COMMAND_LABELS: Record<GuardedCommandKey, string> = {
	gitPush: "git push",
	gitRebase: "git rebase",
	gitBranchDeleteForce: "forced git branch deletion",
	npmPublish: "npm publish",
	piRemove: "pi remove",
};

const SAFE_GUARDRAILS_CONFIG: RuntimeGuardrailsConfig = {
	autonomousMode: false,
	guardedCommands: {},
};

/**
 * Classify a shell command under the runtime guard policy.
 *
 * Ordering (non-negotiable):
 *   1. Hard-deny patterns → "block" (always, cannot be overridden by config)
 *   2. If autonomousMode is false → mirror the legacy CONFIRM_BASH_PATTERNS result
 *   3. If autonomousMode is true → use configured GuardAction for the matched key
 *      (applying AUTONOMOUS_DEFAULT_ACTIONS for any key not set in guardedCommands)
 *   4. No match → "not-guarded"
 */
function collectGuardedMatches(
	command: string,
	config: RuntimeGuardrailsConfig,
): GuardMatch[] {
	const matches: GuardMatch[] = [];
	for (const [key, pattern] of Object.entries(GUARDED_KEY_PATTERNS) as [
		GuardedCommandKey,
		RegExp,
	][]) {
		const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
		for (const match of command.matchAll(globalPattern)) {
			const action = config.autonomousMode
				? (config.guardedCommands[key] ?? AUTONOMOUS_DEFAULT_ACTIONS[key])
				: "confirm";
			matches.push({
				key,
				action,
				triggerIndex: match.index + match[0].lastIndexOf(match[1]),
			});
		}
	}
	return matches.sort((left, right) => left.triggerIndex - right.triggerIndex);
}

function evaluateGuardedCommand(
	command: string,
	config: RuntimeGuardrailsConfig,
): GuardEvaluation {
	const matches = collectGuardedMatches(command, config);
	const destructive = recognizeDestructiveCommands(command);
	const hardDeny = destructive.find((match) => match.hardDeny);
	if (hardDeny) return { action: "block", triggerIndex: hardDeny.triggerIndex, matches };

	// Hard denies override every configured action across the complete command.
	for (const pattern of DENIED_BASH_PATTERNS) {
		const denied = pattern.exec(command);
		if (!denied) continue;
		const matchedAction = matches.find((match) =>
			match.triggerIndex >= denied.index && match.triggerIndex < denied.index + denied[0].length,
		);
		return {
			action: "block",
			key: matchedAction?.key,
			triggerIndex: matchedAction?.triggerIndex ?? denied.index,
			matches,
		};
	}

	// Explicit configured blocks outrank recognized data-loss confirmation.
	const configuredBlock = matches.find((match) => match.action === "block");
	if (configuredBlock) return { ...configuredBlock, matches };
	const dataLoss = destructive.find((match) => match.kind !== "git");
	if (dataLoss) return { action: "confirm", dataLoss: true, triggerIndex: dataLoss.triggerIndex, matches };

	// Confirmation, then allow win across remaining matches.
	const selected = matches.find((match) => match.action === "block")
		?? matches.find((match) => match.action === "confirm")
		?? matches.find((match) => match.action === "allow");
	if (selected) return { ...selected, matches };
	return { action: "not-guarded", triggerIndex: 0, matches };
}

function classifyGuardedCommand(
	command: string,
	config: RuntimeGuardrailsConfig,
): GuardClassification {
	return evaluateGuardedCommand(command, config).action;
}

function guardedCommandPreview(command: string, triggerIndex: number): string {
	const start = Math.max(0, triggerIndex - 60);
	const prefix = start > 0 ? "…" : "";
	return `${prefix}${truncateToWidth(command.slice(start).replace(/\s+/g, " ").trim(), 180 - prefix.length, "…")}`;
}

/** Confirmation headline for all guarded actions; generic when no key matched. */
function guardedCommandTitle(
	key?: GuardedCommandKey,
	matches: readonly GuardMatch[] = [],
): string {
	if (matches.length > 1) {
		return `Allow guarded actions: ${matches.map((match) => GUARDED_COMMAND_LABELS[match.key]).join("; ")}?`;
	}
	return key === undefined
		? "Allow guarded command?"
		: `Allow guarded ${GUARDED_COMMAND_LABELS[key]}?`;
}

function parseGuardrailsConfigFile(
	raw: string,
): RuntimeGuardrailsConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;

	const autonomousMode = parsed.autonomousMode === true;

	const rawCommands = isRecord(parsed.guardedCommands) ? parsed.guardedCommands : {};
	const guardedCommands: GuardedCommandsConfig = {};
	const validActions = new Set<string>(["allow", "confirm", "block"]);
	for (const [key, value] of Object.entries(rawCommands)) {
		if (
			typeof value === "string" &&
			validActions.has(value) &&
			Object.values(GUARDED_COMMAND_KEY).includes(key as GuardedCommandKey)
		) {
			guardedCommands[key as GuardedCommandKey] = value as GuardAction;
		}
	}

	return { autonomousMode, guardedCommands };
}

/**
 * Load the runtime guardrails config.
 *
 * Resolution order (project overrides global):
 *   1. Check NUB_IA_AUTONOMOUS_MODE (legacy GENTLE_PI_AUTONOMOUS_MODE) env var — if "1", forces autonomousMode=true
 *      and uses default guarded command actions.
 *   2. Read global config from ${gentlePiConfigHome}/runtime-guardrails.json
 *   3. Read project config from ${cwd}/.pi/nub-ia/runtime-guardrails.json (legacy .pi/gentle-ai/ read as fallback)
 *      (project values are merged on top of global)
 *   4. Any parse/read error anywhere → fail safe (return SAFE_GUARDRAILS_CONFIG)
 */
function loadRuntimeGuardrailsConfig(
	cwd: string,
	options: LoadGuardrailsOptions = {},
): RuntimeGuardrailsConfig {
	try {
		// Env var override: forces autonomous mode with default actions
		if (readEnv(process.env, "NUB_IA_AUTONOMOUS_MODE", "GENTLE_PI_AUTONOMOUS_MODE") === "1") {
			return { autonomousMode: true, guardedCommands: {} };
		}

		const configHome = options.gentlePiConfigHome ?? gentleAiConfigHome();
		const globalConfigPath = configReadPath(configHome, "runtime-guardrails.json");
		const projectConfigPath = projectConfigReadPath(cwd, "runtime-guardrails.json");

		let merged: RuntimeGuardrailsConfig = { autonomousMode: false, guardedCommands: {} };

		if (existsSync(globalConfigPath)) {
			const globalParsed = parseGuardrailsConfigFile(
				readFileSync(globalConfigPath, "utf8"),
			);
			if (!globalParsed) return SAFE_GUARDRAILS_CONFIG;
			merged = globalParsed;
		}

		if (existsSync(projectConfigPath)) {
			const projectParsed = parseGuardrailsConfigFile(
				readFileSync(projectConfigPath, "utf8"),
			);
			if (!projectParsed) return SAFE_GUARDRAILS_CONFIG;
			// Project values fully override global values
			merged = {
				autonomousMode: projectParsed.autonomousMode,
				guardedCommands: {
					...merged.guardedCommands,
					...projectParsed.guardedCommands,
				},
			};
		}

		return merged;
	} catch {
		return SAFE_GUARDRAILS_CONFIG;
	}
}

const PATH_GUARDED_TOOL_NAMES = new Set(["read", "write", "edit"]);
const PATH_INPUT_KEYS = new Set([
	"path",
	"paths",
	"file",
	"files",
	"filePath",
	"filePaths",
]);
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.credentials(?:\/|$)/,
	/(^|\/)library\/keychains(?:\/|$)/,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)\.config\/gh\/hosts\.ya?ml$/,
	/(^|\/)secrets(?:\/|$)/,
	/(^|\/)\.env(?:$|[./_-])/,
	/\.(?:pem|key|p12|pfx)$/,
];

const JUDGMENT_DAY_AGENT_NAMES = [
	"jd-judge-a",
	"jd-judge-b",
	"jd-fix-agent",
] as const;

const CORE_MODEL_AGENT_NAMES = JUDGMENT_DAY_AGENT_NAMES;
const CORE_MODEL_AGENT_NAME_SET = new Set<string>(CORE_MODEL_AGENT_NAMES);

type AgentSource = "project" | "user" | "builtin";

interface AgentEntry {
	name: string;
	source: AgentSource;
	filePath?: string;
}

const KEEP_CURRENT = "Keep current";
const INHERIT_MODEL = "Inherit active/default model";
const CUSTOM_MODEL = "Custom model id";
const INHERIT_THINKING = "Inherit effort";
const THINKING_OPTIONS: (ThinkingLevel | typeof INHERIT_THINKING)[] = [
	INHERIT_THINKING,
	...THINKING_LEVELS,
];

const MODEL_CONTROL_OPTIONS = [
	KEEP_CURRENT,
	INHERIT_MODEL,
	CUSTOM_MODEL,
] as const;
const MODEL_PANEL_MAX_RENDER_ROWS = 20;
// Rows the agent list does not own: two borders, title, current-profile line,
// blank, "Current assignments:", blank, both scroll indicators, blank, Continue,
// Back, blank, and the two footer rows.
const AGENT_LIST_CHROME_ROWS = 15;
const AGENT_LIST_MAX_VISIBLE_ROWS = MODEL_PANEL_MAX_RENDER_ROWS - AGENT_LIST_CHROME_ROWS;
// Rows the model list does not own: two borders, title, blank, search, blank,
// blank, and the footer row.
const MODEL_LIST_CHROME_ROWS = 8;
const MODEL_LIST_MAX_VISIBLE_ROWS = 12;

function readStringPath(value: unknown, path: string[]): string | undefined {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return typeof current === "string" ? current : undefined;
}

function readAgentStartNames(event: unknown): string[] {
	return [
		readStringPath(event, ["agentName"]),
		readStringPath(event, ["agent"]),
		readStringPath(event, ["name"]),
		readStringPath(event, ["agent", "name"]),
		readStringPath(event, ["subagent", "name"]),
	]
		.filter((value): value is string => value !== undefined)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function isNamedAgentStartEvent(event: unknown): boolean {
	return readAgentStartNames(event).length > 0;
}

function normalizePolicyPath(value: string): string {
	return value.trim().replace(/^~(?=\/|$)/, homedir()).replace(/\\/g, "/").toLowerCase();
}

function isSensitivePath(value: string): boolean {
	const normalized = normalizePolicyPath(value);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectPathInputs(value: unknown, key?: string): string[] {
	if (typeof value === "string") return key && PATH_INPUT_KEYS.has(key) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((item) => collectPathInputs(item, key));
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([entryKey, entryValue]) =>
		collectPathInputs(entryValue, entryKey),
	);
}

function hasWritableEngramTool(pi: ExtensionAPI): boolean {
	try {
		const getActiveTools = (pi as unknown as { getActiveTools?: () => unknown[] })
			.getActiveTools;
		if (typeof getActiveTools !== "function") return false;
		const tools = getActiveTools.call(pi);
		return tools.some((tool) => {
			const name =
				typeof tool === "string"
					? tool
					: isRecord(tool) && typeof tool.name === "string"
						? tool.name
						: "";
			return name === "mem_save" || name.endsWith(".mem_save");
		});
	} catch {
		return false;
	}
}

function evaluateSensitivePathTool(
	toolName: string,
	input: unknown,
): ToolCallEventResult | undefined {
	if (!PATH_GUARDED_TOOL_NAMES.has(toolName)) return undefined;
	const sensitivePath = collectPathInputs(input).find(isSensitivePath);
	if (!sensitivePath) return undefined;
	return {
		block: true,
		reason: `Nub-IA safety policy blocked access to sensitive path: ${sanitizeTerminalText(sensitivePath)}. Ask the user for an explicit safer plan.`,
	};
}

const ASK_USER_CHOICE_BLOCKED_EVENT = "gentle-pi:ask-user-choice:blocked";
const ASK_USER_QUESTION_BLOCKED_EVENT = "gentle-pi:ask-user-question:blocked";

const HERDR_BLOCKER_LABEL = {
	CHOICE: "Choice awaiting input",
	GUARDED_CONFIRMATION: "Guarded command confirmation",
	QUESTIONNAIRE: "Questionnaire awaiting input",
} as const;

type HerdrBlockerLabel = (typeof HERDR_BLOCKER_LABEL)[keyof typeof HERDR_BLOCKER_LABEL];

type HerdrConfirmationLifecycle = {
	begin(): void;
	settle(): void;
};

function createHerdrConfirmationLifecycle(events: ExtensionAPI["events"]): HerdrConfirmationLifecycle {
	let pending = 0;
	let choiceActive = false;
	let nativeQuestionnaireActive = false;
	let legacyQuestionnaireActive = false;
	let emittedLabel: HerdrBlockerLabel | undefined;
	const emitEffectiveBlocker = (): void => {
		const nextLabel = choiceActive
			? HERDR_BLOCKER_LABEL.CHOICE
			: nativeQuestionnaireActive || legacyQuestionnaireActive
				? HERDR_BLOCKER_LABEL.QUESTIONNAIRE
				: pending > 0
					? HERDR_BLOCKER_LABEL.GUARDED_CONFIRMATION
					: undefined;
		// Herdr bridges count active/inactive edges. Keep the first label until
		// every source releases; relabel activations would leak a blocked count.
		if ((nextLabel === undefined) === (emittedLabel === undefined)) return;
		emittedLabel = nextLabel;
		if (nextLabel === undefined) events.emit("herdr:blocked", { active: false });
		else events.emit("herdr:blocked", { active: true, label: nextLabel });
	};

	events?.on?.(ASK_USER_CHOICE_BLOCKED_EVENT, (event) => {
		if (!isRecord(event) || typeof event.active !== "boolean" || event.active === choiceActive) return;
		choiceActive = event.active;
		emitEffectiveBlocker();
	});

	events?.on?.(ASK_USER_QUESTION_BLOCKED_EVENT, (event) => {
		if (!isRecord(event) || typeof event.active !== "boolean" || event.active === nativeQuestionnaireActive) return;
		nativeQuestionnaireActive = event.active;
		emitEffectiveBlocker();
	});

	events?.on?.("rpiv:ask-user:blocked", (event) => {
		if (!isRecord(event) || typeof event.active !== "boolean" || event.active === legacyQuestionnaireActive) return;
		legacyQuestionnaireActive = event.active;
		emitEffectiveBlocker();
	});

	return {
		begin() {
			pending += 1;
			emitEffectiveBlocker();
		},
		settle() {
			if (pending === 0) return;
			pending -= 1;
			emitEffectiveBlocker();
		},
	};
}

/** Conservative waiver surface: one plain push in the current repository, no shell/wrapper or destination-changing options. */
function isOrdinaryYoloPush(command: string, evaluation: GuardEvaluation): boolean {
	if (evaluation.action !== "confirm" || evaluation.dataLoss || evaluation.matches.length !== 1 || evaluation.key !== "gitPush") return false;
	return /^git\s+push(?:\s+(?:-u|--set-upstream|[A-Za-z0-9_][A-Za-z0-9_./-]*))*\s*$/.test(command);
}

/** Preserve explicitly configured confirmations even when legacy env/autonomy resolution ignores them. */
function yoloPushConfiguredRestriction(cwd: string, options: LoadGuardrailsOptions = {}): GuardAction | undefined {
	let restriction: GuardAction | undefined;
	for (const path of [configReadPath(options.gentlePiConfigHome ?? gentleAiConfigHome(), "runtime-guardrails.json"), projectConfigReadPath(cwd, "runtime-guardrails.json")]) {
		try {
			if (!existsSync(path)) continue;
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isRecord(parsed) || (parsed.guardedCommands !== undefined && !isRecord(parsed.guardedCommands))) {
				restriction ??= "confirm";
				continue;
			}
			const action = isRecord(parsed.guardedCommands) ? parsed.guardedCommands.gitPush : undefined;
			if (action === "block") return "block";
			if (action !== undefined && action !== "allow") restriction = "confirm";
		} catch { restriction ??= "confirm"; }
	}
	return restriction;
}

async function confirmCommand(
	command: string,
	ctx: ExtensionContext,
	events: ExtensionAPI["events"],
	herdrLifecycle: HerdrConfirmationLifecycle,
	yoloActive = false,
): Promise<ToolCallEventResult | undefined> {
	const guardrailsConfig = loadRuntimeGuardrailsConfig(ctx.cwd);
	const evaluation = evaluateGuardedCommand(command, guardrailsConfig);
	// Configuration provenance is distinct from legacy autonomy resolution, which
	// can ignore confirmations when an environment override is present. Activation
	// cannot waive a restriction from either user or project configuration layer.
	const configuredRestriction = yoloActive && evaluation.matches.some((match) => match.key === "gitPush")
		? yoloPushConfiguredRestriction(ctx.cwd) : undefined;
	const classification = evaluation.action === "block" || configuredRestriction === "block"
		? "block" : configuredRestriction ?? evaluation.action;

	if (classification === "block") {
		return {
			block: true,
			reason:
				"Nub-IA safety policy blocked a destructive shell command. Ask the user for an explicit safer plan.",
		};
	}

	if (classification === "not-guarded") return undefined;

	// classification is "allow" or "confirm" from this point on
	if (classification === "allow") return undefined;

	// Full T1 evaluation has already run. YOLO never changes persistent autonomy.
	if (yoloActive && configuredRestriction === undefined && isOrdinaryYoloPush(command, evaluation)) return undefined;

	// classification === "confirm"
	if (!ctx.hasUI) {
		return {
			block: true,
			reason:
				"Nub-IA safety policy requires interactive confirmation before this command.",
		};
	}
	const title = evaluation.dataLoss
		? "Allow recognized data-loss command?"
		: guardedCommandTitle(evaluation.key, evaluation.matches);
	const preview = guardedCommandPreview(command, evaluation.triggerIndex);
	const requestId = randomUUID();
	const emitPermissionRequest = (
		state: "waiting" | "approved" | "denied",
	): void => {
		events.emit("pi-permission-system:permission-request", {
			requestId,
			state,
			source: "tool_call",
			message: "Nub-IA safety policy requires confirmation for this tool call.",
			toolName: "bash",
		});
	};
	let approved = false;
	let confirmationFailed = false;
	let confirmationError: unknown;
	emitPermissionRequest("waiting");
	herdrLifecycle.begin();
	try {
		approved = (await ctx.ui.confirm(title, preview)) === true;
	} catch (error) {
		confirmationFailed = true;
		confirmationError = error;
	} finally {
		try {
			emitPermissionRequest(confirmationFailed || !approved ? "denied" : "approved");
		} finally {
			herdrLifecycle.settle();
		}
	}
	if (confirmationFailed) throw confirmationError;
	if (approved) return undefined;
	return {
		block: true,
		reason:
			"Nub-IA safety policy blocked the command because it was not confirmed.",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gentleAiConfigHome(): string {
	return gentlePiConfigHome();
}

function modelConfigPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "models.json");
}

function modelExportPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "models.export.json");
}

// READ paths fall back to the legacy gentle-ai home; the functions above are the WRITE targets.
function modelConfigReadPath(_cwd: string): string {
	return configReadPath(gentleAiConfigHome(), "models.json");
}

function modelExportReadPath(_cwd: string): string {
	return configReadPath(gentleAiConfigHome(), "models.export.json");
}

const MODEL_EXPORT_KIND = "gentle-pi.agent_model_routing";
const MODEL_EXPORT_VERSION = 1;

function legacyProjectModelConfigPath(cwd: string): string {
	return projectConfigReadPath(cwd, "models.json");
}

function projectPersonaConfigPath(cwd: string): string {
	return projectConfigWritePath(cwd, "persona.json");
}

function projectPersonaConfigReadPath(cwd: string): string {
	return projectConfigReadPath(cwd, "persona.json");
}

function personaConfigPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "persona.json");
}

function personaConfigReadPath(_cwd: string): string {
	return configReadPath(gentleAiConfigHome(), "persona.json");
}

function readPersonaFile(path: string): PersonaMode | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return undefined;
		return parsed.mode === "neutral" ? "neutral" : "gentleman";
	} catch {
		return undefined;
	}
}

function readPersonaMode(cwd: string): PersonaMode {
	return (
		readPersonaFile(projectPersonaConfigReadPath(cwd)) ??
		readPersonaFile(personaConfigReadPath(cwd)) ??
		"gentleman"
	);
}

function writePersonaMode(cwd: string, mode: PersonaMode): string[] {
	const paths = [personaConfigPath(cwd)];
	const projectPath = projectPersonaConfigPath(cwd);
	if (existsSync(projectPersonaConfigReadPath(cwd))) paths.push(projectPath);
	for (const path of paths) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ mode }, null, 2)}\n`);
	}
	return paths;
}

function readSavedModelConfig(cwd: string): ModelConfigFileResult {
	const projectPath = legacyProjectModelConfigPath(cwd);
	const result = readModelRoutingAuthority(modelConfigReadPath(cwd), projectPath);
	return result.status === "invalid" && result.path === projectPath
		? { status: "valid", config: {} }
		: result;
}

async function readSavedModelConfigAsync(
	cwd: string,
): Promise<ModelConfigFileResult> {
	const projectPath = legacyProjectModelConfigPath(cwd);
	const result = await readModelRoutingAuthorityAsync(modelConfigReadPath(cwd), projectPath);
	return result.status === "invalid" && result.path === projectPath
		? { status: "valid", config: {} }
		: result;
}

export function readModelConfig(cwd: string): AgentModelConfig {
	const result = readSavedModelConfig(cwd);
	return result.status === "valid" ? result.config : {};
}

export async function readModelConfigAsync(
	cwd: string,
): Promise<AgentModelConfig> {
	const result = await readSavedModelConfigAsync(cwd);
	return result.status === "valid" ? result.config : {};
}

function writeModelConfig(cwd: string, config: AgentModelConfig): void {
	const path = modelConfigPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	const cleaned = normalizeModelConfig(config) ?? {};
	writeFileSync(path, `${JSON.stringify(cleaned, null, 2)}\n`);
}

async function writeModelConfigAsync(cwd: string, config: AgentModelConfig): Promise<void> {
	const path = modelConfigPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const cleaned = normalizeModelConfig(config) ?? {};
	await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`);
}

function parseModelExport(value: unknown): AgentModelConfig | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind !== MODEL_EXPORT_KIND || value.version !== MODEL_EXPORT_VERSION) return undefined;
	return normalizeModelConfig(value.agents);
}

async function exportSavedModelConfig(ctx: ExtensionContext): Promise<number> {
	const saved = await readModelRoutingAuthorityAsync(
		modelConfigReadPath(ctx.cwd),
		legacyProjectModelConfigPath(ctx.cwd),
	);
	if (saved.status === "invalid") throw new Error(`Invalid model config: ${saved.path}`);
	const agents = saved.status === "valid" ? saved.config : {};
	const path = modelExportPath(ctx.cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({ kind: MODEL_EXPORT_KIND, version: MODEL_EXPORT_VERSION, agents }, null, 2)}\n`,
	);
	return Object.keys(agents).length;
}

async function readModelExport(ctx: ExtensionContext): Promise<AgentModelConfig | undefined> {
	try {
		return parseModelExport(JSON.parse(await readFile(modelExportReadPath(ctx.cwd), "utf8")));
	} catch {
		return undefined;
	}
}

function cloneModelConfig(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(
		Object.entries(config).map(([name, entry]) => [name, { ...entry }]),
	);
}

function updateFrontmatterRouting(
	content: string,
	entry: AgentRoutingEntry | undefined,
): string {
	if (!content.startsWith("---\n")) return content;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return content;
	const frontmatter = content.slice(4, endIndex);
	const body = content.slice(endIndex);
	const lines = frontmatter
		.split("\n")
		.filter(
			(line) => !line.startsWith("model:") && !line.startsWith("thinking:"),
		);
	const toInsert: string[] = [];
	if (entry?.model) toInsert.push(`model: ${entry.model}`);
	if (entry?.thinking) toInsert.push(`thinking: ${entry.thinking}`);
	if (toInsert.length > 0) {
		const descriptionIndex = lines.findIndex((line) =>
			line.startsWith("description:"),
		);
		const insertIndex =
			descriptionIndex >= 0 ? descriptionIndex + 1 : Math.min(1, lines.length);
		lines.splice(insertIndex, 0, ...toInsert);
	}
	return `---\n${lines.join("\n")}${body}`;
}

/**
 * The routing an agent file currently carries, read the same way
 * `updateFrontmatterRouting` writes it: top-level `model:` and `thinking:`
 * frontmatter lines. Anything else is "no routing", not an error.
 */
function readFrontmatterRouting(content: string): AgentRoutingEntry | undefined {
	if (!content.startsWith("---\n")) return undefined;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return undefined;
	const raw: Record<string, string> = {};
	for (const line of content.slice(4, endIndex).split("\n")) {
		if (line.startsWith("model:")) raw.model = line.slice("model:".length).trim();
		else if (line.startsWith("thinking:")) raw.thinking = line.slice("thinking:".length).trim();
	}
	if (raw.model === undefined && raw.thinking === undefined) return undefined;
	const entry = normalizeRoutingEntry(raw);
	return entry && !isClearRoutingEntry(entry) ? entry : undefined;
}

function routingEntryFromModelProfile(value: unknown): AgentRoutingEntry | undefined {
	if (!isRecord(value)) return undefined;
	const entry = normalizeRoutingEntry({ model: value.model, thinking: value.effort });
	return entry && !isClearRoutingEntry(entry) ? entry : undefined;
}

function mergeMaterializedRouting(
	profile: AgentRoutingEntry | undefined,
	frontmatter: AgentRoutingEntry | undefined,
): AgentRoutingEntry | undefined {
	if (!profile) return frontmatter;
	if (!frontmatter) return profile;
	return normalizeRoutingEntry({
		model: profile.model ?? frontmatter.model,
		thinking: profile.thinking ?? frontmatter.thinking,
	});
}

function readSubagentModelProfiles(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) && isRecord(parsed.model_profiles) ? parsed.model_profiles : {};
	} catch {
		return {};
	}
}

async function readSubagentModelProfilesAsync(path: string): Promise<Record<string, unknown>> {
	if (!(await pathExists(path))) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isRecord(parsed) && isRecord(parsed.model_profiles) ? parsed.model_profiles : {};
	} catch {
		return {};
	}
}

/**
 * The routing an agent is materialized with — what subagent launches actually
 * resolve — regardless of what `models.json` records: the runtime reads
 * `subagents.json` model profiles first and the agent frontmatter otherwise,
 * independently for each routing field.
 */
function readMaterializedRoutingEntry(
	cwd: string,
	agent: AgentEntry,
	profilesByPath: Map<string, Record<string, unknown>>,
): AgentRoutingEntry | undefined {
	const profilesPath = agentModelProfileConfigPath(cwd, agent.source);
	let profiles = profilesByPath.get(profilesPath);
	if (!profiles) {
		profiles = readSubagentModelProfiles(profilesPath);
		profilesByPath.set(profilesPath, profiles);
	}
	const fromProfile = routingEntryFromModelProfile(profiles[agent.name]);
	if (!agent.filePath || !existsSync(agent.filePath)) return fromProfile;
	try {
		return mergeMaterializedRouting(fromProfile, readFrontmatterRouting(readFileSync(agent.filePath, "utf8")));
	} catch {
		return fromProfile;
	}
}

async function readMaterializedRoutingEntryAsync(
	cwd: string,
	agent: AgentEntry,
	profilesByPath: Map<string, Record<string, unknown>>,
): Promise<AgentRoutingEntry | undefined> {
	const profilesPath = agentModelProfileConfigPath(cwd, agent.source);
	let profiles = profilesByPath.get(profilesPath);
	if (!profiles) {
		profiles = await readSubagentModelProfilesAsync(profilesPath);
		profilesByPath.set(profilesPath, profiles);
	}
	const fromProfile = routingEntryFromModelProfile(profiles[agent.name]);
	if (!agent.filePath || !(await pathExists(agent.filePath))) return fromProfile;
	try {
		return mergeMaterializedRouting(fromProfile, readFrontmatterRouting(await readFile(agent.filePath, "utf8")));
	} catch {
		return fromProfile;
	}
}

/**
 * The routing a launch would resolve: a winning per-repository pin replaces subagent
 * routing wholesale, so when one wins it is the effective routing. The launch
 * resolver decides, so the profile shown as effective is exactly the profile a launch
 * would use -- there is no second precedence rule here.
 */
function pinnedEffectiveModelConfig(cwd: string): AgentModelConfig | undefined {
	const resolution = resolveProfilePin({ cwd, configHome: gentleAiConfigHome() });
	return resolution === undefined ? undefined : cloneModelConfig(resolution.modelProfiles);
}

/**
 * The routing in effect: `models.json` where it speaks, and the materialized
 * stores the runtime resolves from for every discoverable agent it is silent
 * about. A sparse `models.json` therefore never hides routing that is still
 * live (#1012). A winning pin outranks both. Reading never writes.
 */
function readEffectiveModelConfig(cwd: string): AgentModelConfig {
	return pinnedEffectiveModelConfig(cwd) ?? readGlobalEffectiveModelConfig(cwd);
}

/** The routing in effect once the pin is set aside: what a global save materializes. */
function readGlobalEffectiveModelConfig(cwd: string): AgentModelConfig {
	const effective = cloneModelConfig(readModelConfig(cwd));
	const profilesByPath = new Map<string, Record<string, unknown>>();
	for (const agent of listDiscoverableAgents(cwd)) {
		if (agent.name in effective) continue;
		const entry = readMaterializedRoutingEntry(cwd, agent, profilesByPath);
		if (entry) effective[agent.name] = entry;
	}
	return effective;
}

async function readEffectiveModelConfigAsync(cwd: string): Promise<AgentModelConfig> {
	const pinned = pinnedEffectiveModelConfig(cwd);
	if (pinned) return pinned;
	return readGlobalEffectiveModelConfigFromAsync(cwd, await readModelConfigAsync(cwd));
}

/**
 * The saved global routing merged with the materialized stores of every
 * discoverable agent it is silent about — the same effective view
 * `readEffectiveModelConfigAsync` builds, but starting from an already-read
 * saved routing so callers that must distinguish an unreadable authority can
 * keep that distinction while still seeing materialized routes.
 */
async function readGlobalEffectiveModelConfigFromAsync(
	cwd: string,
	base: AgentModelConfig,
): Promise<AgentModelConfig> {
	const effective = cloneModelConfig(base);
	const profilesByPath = new Map<string, Record<string, unknown>>();
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (agent.name in effective) continue;
		const entry = await readMaterializedRoutingEntryAsync(cwd, agent, profilesByPath);
		if (entry) effective[agent.name] = entry;
	}
	return effective;
}

/**
 * A profile is a complete routing snapshot: applying it must leave every
 * discoverable agent it omits on inherit, not on whatever was materialized
 * before. Padding the omitted agents with clear entries makes
 * `applyModelConfig` remove their model profiles and frontmatter routing, the
 * same way `/nubia:models` clears an agent set to inherit.
 */
async function withOmittedAgentsClearedAsync(
	cwd: string,
	config: AgentModelConfig,
): Promise<AgentModelConfig> {
	const completed = cloneModelConfig(config);
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (agent.name in completed) continue;
		completed[agent.name] = {};
	}
	return completed;
}

function parseAgentName(filePath: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const name = content.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	if (!name) return undefined;
	const packageName = content
		.match(/^package:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
		?.trim();
	return packageName ? `${packageName}.${name}` : name;
}

async function parseAgentNameAsync(
	filePath: string,
): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	const name = content.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	if (!name) return undefined;
	const packageName = content
		.match(/^package:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
		?.trim();
	return packageName ? `${packageName}.${name}` : name;
}

function listAgentFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "skills") continue;
			files.push(...listAgentFilesRecursive(path));
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		)
			files.push(path);
	}
	return files;
}

async function listAgentFilesRecursiveAsync(dir: string): Promise<string[]> {
	if (!(await pathExists(dir))) return [];
	const files: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "skills") continue;
			files.push(...(await listAgentFilesRecursiveAsync(path)));
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		) {
			files.push(path);
		}
	}
	return files;
}

function listAgentsFromDir(dir: string, source: AgentSource): AgentEntry[] {
	return listAgentFilesRecursive(dir)
		.map((filePath): AgentEntry | undefined => {
			const name = parseAgentName(filePath);
			return name ? { name, source, filePath } : undefined;
		})
		.filter((entry): entry is AgentEntry => entry !== undefined);
}

async function listAgentsFromDirAsync(
	dir: string,
	source: AgentSource,
): Promise<AgentEntry[]> {
	const filePaths = await listAgentFilesRecursiveAsync(dir);
	const entries: AgentEntry[] = [];
	for (const filePath of filePaths) {
		const name = await parseAgentNameAsync(filePath);
		if (name) entries.push({ name, source, filePath });
	}
	return entries;
}

interface DiscoverableNonBuiltinAgentRoot {
	dir: string;
	source: AgentSource;
	/** The package installer owns this directory, so packageAssetAudit reports it. */
	packageManaged: boolean;
}

function discoverableNonBuiltinAgentRoots(cwd: string): DiscoverableNonBuiltinAgentRoot[] {
	const globalAgentHome = gentlePiAgentHome();
	const roots: DiscoverableNonBuiltinAgentRoot[] = [
		{ dir: join(globalAgentHome, "agents"), source: "user", packageManaged: true },
		{ dir: join(globalAgentHome, "subagents"), source: "user", packageManaged: false },
		{ dir: join(homedir(), ".agents"), source: "user", packageManaged: false },
		{ dir: join(cwd, ".agents"), source: "project", packageManaged: false },
		{ dir: join(cwd, ".pi", "agents"), source: "project", packageManaged: false },
		{ dir: join(cwd, ".pi", "subagents"), source: "project", packageManaged: false },
	];
	const unique = new Map<string, DiscoverableNonBuiltinAgentRoot>();
	for (const root of roots) {
		let canonical: string;
		try {
			canonical = realpathSync(root.dir);
		} catch {
			canonical = resolve(root.dir);
		}
		const existing = unique.get(canonical);
		if (existing) {
			// Reinsert so a later alias keeps true later-root precedence even when
			// another physical root appears between the duplicate entries. A merged
			// package-managed root must keep its installer-owned path: ownership
			// updates validate that lexical path against the managed manifest root.
			const managedRoot = existing.packageManaged ? existing : root.packageManaged ? root : undefined;
			unique.delete(canonical);
			unique.set(canonical, {
				dir: managedRoot?.dir ?? root.dir,
				source: root.source,
				packageManaged: managedRoot !== undefined,
			});
		} else unique.set(canonical, root);
	}
	return [...unique.values()];
}

function builtinAgentDirs(cwd: string): string[] {
	return [
		join(PACKAGE_ROOT, "..", "pi-subagents-j0k3r", "agents"),
		join(cwd, ".pi", "npm", "node_modules", "pi-subagents-j0k3r", "agents"),
		join(homedir(), ".local", "lib", "node_modules", "pi-subagents-j0k3r", "agents"),
		join(PACKAGE_ROOT, "..", "pi-subagents", "agents"),
		join(cwd, ".pi", "npm", "node_modules", "pi-subagents", "agents"),
		join(homedir(), ".local", "lib", "node_modules", "pi-subagents", "agents"),
	];
}

function listDiscoverableAgents(cwd: string): AgentEntry[] {
	const builtinDirs = builtinAgentDirs(cwd);
	const agents = [
		...builtinDirs.flatMap((dir) => listAgentsFromDir(dir, "builtin")),
		...discoverableNonBuiltinAgentRoots(cwd).flatMap(({ dir, source }) =>
			listAgentsFromDir(dir, source),
		),
	];
	const byName = new Map<string, AgentEntry>();
	for (const agent of agents) byName.set(agent.name, agent);
	return orderDiscoverableAgents(Array.from(byName.values()));
}

async function listDiscoverableAgentsAsync(cwd: string): Promise<AgentEntry[]> {
	const builtinDirs = builtinAgentDirs(cwd);
	const agents: AgentEntry[] = [];
	for (const dir of builtinDirs) {
		agents.push(...(await listAgentsFromDirAsync(dir, "builtin")));
	}
	for (const { dir, source } of discoverableNonBuiltinAgentRoots(cwd)) {
		agents.push(...(await listAgentsFromDirAsync(dir, source)));
	}
	const byName = new Map<string, AgentEntry>();
	for (const agent of agents) byName.set(agent.name, agent);
	return orderDiscoverableAgents(Array.from(byName.values()));
}

function orderDiscoverableAgents(agents: AgentEntry[]): AgentEntry[] {
	const coreFirst = CORE_MODEL_AGENT_NAMES.map((name) =>
		agents.find((agent) => agent.name === name),
	).filter((agent): agent is AgentEntry => agent !== undefined);
	const rest = agents
		.filter((agent) => !CORE_MODEL_AGENT_NAME_SET.has(agent.name))
		.sort((left, right) => left.name.localeCompare(right.name));
	return [...coreFirst, ...rest];
}

function isClearRoutingEntry(entry: AgentRoutingEntry): boolean {
	return entry.model === undefined && entry.thinking === undefined;
}

function agentModelProfileConfigPath(cwd: string, source: AgentSource): string {
	return source === "project"
		? join(cwd, ".pi", "subagents.json")
		: join(gentlePiAgentHome(), "subagents.json");
}

function modelProfileForRoutingEntry(
	entry: AgentRoutingEntry | undefined,
): Record<string, string> | undefined {
	if (!entry || isClearRoutingEntry(entry)) return undefined;
	const profile: Record<string, string> = {};
	if (entry.model) profile.model = entry.model;
	if (entry.thinking) profile.effort = entry.thinking;
	return Object.keys(profile).length > 0 ? profile : undefined;
}

function updateSubagentModelProfileAtPath(
	path: string,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): boolean {
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) config = { ...parsed };
		} catch {
			config = {};
		}
	}
	const modelProfiles = isRecord(config.model_profiles)
		? { ...config.model_profiles }
		: {};
	const profile = modelProfileForRoutingEntry(entry);
	// A write that would leave the profile as it is (including removing a
	// profile that was never there) is not an update and touches no file.
	if (JSON.stringify(modelProfiles[name]) === JSON.stringify(profile)) return false;
	if (profile) {
		if (options.preserveExisting && isRecord(modelProfiles[name])) return false;
		modelProfiles[name] = profile;
	} else delete modelProfiles[name];
	if (Object.keys(modelProfiles).length > 0) config.model_profiles = modelProfiles;
	else delete config.model_profiles;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	return true;
}

async function updateSubagentModelProfileAtPathAsync(
	path: string,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): Promise<boolean> {
	let config: Record<string, unknown> = {};
	if (await pathExists(path)) {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (isRecord(parsed)) config = { ...parsed };
		} catch {
			config = {};
		}
	}
	const modelProfiles = isRecord(config.model_profiles)
		? { ...config.model_profiles }
		: {};
	const profile = modelProfileForRoutingEntry(entry);
	// A write that would leave the profile as it is (including removing a
	// profile that was never there) is not an update and touches no file.
	if (JSON.stringify(modelProfiles[name]) === JSON.stringify(profile)) return false;
	if (profile) {
		if (options.preserveExisting && isRecord(modelProfiles[name])) return false;
		modelProfiles[name] = profile;
	} else delete modelProfiles[name];
	if (Object.keys(modelProfiles).length > 0) config.model_profiles = modelProfiles;
	else delete config.model_profiles;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
	return true;
}

function updateSubagentModelProfile(
	cwd: string,
	source: AgentSource,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): boolean {
	return updateSubagentModelProfileAtPath(
		agentModelProfileConfigPath(cwd, source),
		name,
		entry,
		options,
	);
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/**
 * Pi's own global settings file, which is where the orchestrator model lives.
 * Profiles own the three `default*` keys there; nothing else in this extension
 * reads or writes that file.
 */
function orchestratorSettingsPath(): string {
	return join(gentlePiAgentHome(), "settings.json");
}

function removeLegacyAgentOverridesFromSettings(
	settingsPath: string,
	settings: Record<string, unknown>,
): void {
	const subagents = isRecord(settings.subagents)
		? { ...settings.subagents }
		: undefined;
	if (!subagents) return;
	delete subagents.agentOverrides;
	if (Object.keys(subagents).length > 0) settings.subagents = subagents;
	else delete settings.subagents;
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function isValidJsonObjectFileOrMissing(path: string): boolean {
	if (!existsSync(path)) return true;
	try {
		return isRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return false;
	}
}

function modelAssignmentNames(cwd: string): string[] {
	return [...new Set(listDiscoverableAgents(cwd).map((agent) => agent.name))];
}

function migrateLegacyProjectModelOverrides(cwd: string): number {
	const settingsPath = projectSettingsPath(cwd);
	if (!existsSync(settingsPath)) return 0;
	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isRecord(parsed)) return 0;
		settings = { ...parsed };
	} catch {
		return 0;
	}
	const subagents = isRecord(settings.subagents) ? settings.subagents : undefined;
	const agentOverrides = isRecord(subagents?.agentOverrides)
		? subagents.agentOverrides
		: undefined;
	if (!agentOverrides) return 0;
	const agentsByName = new Map(listDiscoverableAgents(cwd).map((agent) => [agent.name, agent]));
	const migratableEntries = Object.entries(agentOverrides)
		.map(([name, value]) => ({ name, entry: normalizeRoutingEntry(value) }))
		.filter((item): item is { name: string; entry: AgentRoutingEntry } =>
			item.entry !== undefined && !isClearRoutingEntry(item.entry),
		);
	const targetPaths = new Set(
		migratableEntries.map(({ name }) =>
			agentModelProfileConfigPath(cwd, agentsByName.get(name)?.source ?? "project"),
		),
	);
	if (![...targetPaths].every(isValidJsonObjectFileOrMissing)) return 0;
	let migrated = 0;
	for (const { name, entry } of migratableEntries) {
		const source = agentsByName.get(name)?.source ?? "project";
		if (updateSubagentModelProfile(cwd, source, name, entry, { preserveExisting: true })) migrated += 1;
	}
	removeLegacyAgentOverridesFromSettings(settingsPath, settings);
	return migrated;
}

async function updateSubagentModelProfileAsync(
	cwd: string,
	source: AgentSource,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): Promise<boolean> {
	return updateSubagentModelProfileAtPathAsync(
		agentModelProfileConfigPath(cwd, source),
		name,
		entry,
		options,
	);
}

export function applyModelConfig(
	cwd: string,
	config: AgentModelConfig,
): { updated: number; skipped: number } {
	let updated = 0;
	let skipped = 0;
	const seenAgents = new Set<string>();
	for (const agent of listDiscoverableAgents(cwd)) {
		seenAgents.add(agent.name);
		const entry = config[agent.name];
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		if (agent.source === "builtin") {
			if (updateSubagentModelProfile(cwd, agent.source, agent.name, entry)) updated += 1;
			else skipped += 1;
			continue;
		}
		if (!agent.filePath || !existsSync(agent.filePath)) {
			skipped += 1;
		} else {
			const original = readFileSync(agent.filePath, "utf8");
			const next = updateFrontmatterRouting(original, entry);
			if (next === original) {
				skipped += 1;
			} else {
				if (!updatePackageManagedSddAgentOwnership(agent.filePath, original, next)) {
					writeFileSync(agent.filePath, next);
				}
				updated += 1;
			}
		}
		if (updateSubagentModelProfile(cwd, agent.source, agent.name, entry)) updated += 1;
		else skipped += 1;
	}
	for (const [name, entry] of Object.entries(config)) {
		// The orchestrator is routing, not an agent: its model lives in Pi's global
		// settings.json and must never reach subagents.json.
		if (isProfileOrchestratorKey(name)) continue;
		if (!seenAgents.has(name) && isClearRoutingEntry(entry)) {
			if (updateSubagentModelProfile(cwd, "user", name, entry)) updated += 1;
			else skipped += 1;
		}
	}
	return { updated, skipped };
}

export async function applyModelConfigAsync(
	cwd: string,
	config: AgentModelConfig,
): Promise<{ updated: number; skipped: number }> {
	let updated = 0;
	let skipped = 0;
	const seenAgents = new Set<string>();
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		seenAgents.add(agent.name);
		const entry = config[agent.name];
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		if (agent.source === "builtin") {
			if (await updateSubagentModelProfileAsync(cwd, agent.source, agent.name, entry))
				updated += 1;
			else skipped += 1;
			continue;
		}
		if (!agent.filePath || !(await pathExists(agent.filePath))) {
			skipped += 1;
		} else {
			const original = await readFile(agent.filePath, "utf8");
			const next = updateFrontmatterRouting(original, entry);
			if (next === original) {
				skipped += 1;
			} else {
				if (!updatePackageManagedSddAgentOwnership(agent.filePath, original, next)) {
					await writeFile(agent.filePath, next);
				}
				updated += 1;
			}
		}
		if (await updateSubagentModelProfileAsync(cwd, agent.source, agent.name, entry))
			updated += 1;
		else skipped += 1;
	}
	for (const [name, entry] of Object.entries(config)) {
		if (isProfileOrchestratorKey(name)) continue;
		if (!seenAgents.has(name) && isClearRoutingEntry(entry)) {
			if (await updateSubagentModelProfileAsync(cwd, "user", name, entry))
				updated += 1;
			else skipped += 1;
		}
	}
	return { updated, skipped };
}

export async function applySavedModelConfig(
	ctx: ExtensionContext,
	applyConfig: typeof applyModelConfigAsync = applyModelConfigAsync,
): Promise<{ updated: number; skipped: number; invalidPath?: string }> {
	const result = await readModelRoutingAuthorityAsync(
		modelConfigReadPath(ctx.cwd),
		legacyProjectModelConfigPath(ctx.cwd),
	);
	if (result.status === "invalid") {
		return { updated: 0, skipped: 0, invalidPath: result.path };
	}
	return applyConfig(
		ctx.cwd,
		result.status === "valid" ? result.config : {},
	);
}

function describeModelConfig(cwd: string, config: AgentModelConfig): string[] {
	return modelAssignmentNames(cwd).map((name) => {
		const entry = config[name];
		const model = entry?.model ?? "inherit";
		const thinking = entry?.thinking ?? "inherit";
		return `${sanitizeTerminalText(name)}: model=${sanitizeTerminalText(model)}, effort=${sanitizeTerminalText(thinking)}`;
	});
}

async function getPiModelOptions(ctx: ExtensionContext): Promise<string[]> {
	const registry = ctx.modelRegistry;
	if (!registry) {
		return [...MODEL_CONTROL_OPTIONS];
	}
	let raw: unknown;
	try {
		raw = await registry.getAvailable();
	} catch {
		return [...MODEL_CONTROL_OPTIONS];
	}
	if (!Array.isArray(raw)) {
		return [...MODEL_CONTROL_OPTIONS];
	}
	const models = raw as { provider: string; id: string }[];
	const modelIds = models
		.map((model) => normalizeModelId(`${model.provider}/${model.id}`))
		.filter((model): model is string => model !== undefined)
		.sort((left, right) => left.localeCompare(right));
	return [...MODEL_CONTROL_OPTIONS, ...modelIds];
}

interface OverlayComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

type ModelPanelResult =
	| { type: "save"; config: AgentModelConfig }
	// `save`, then snapshot saved agent routing and the live orchestrator into
	// the current profile without changing the global orchestrator defaults.
	| { type: "save-profile"; config: AgentModelConfig }
	| { type: "custom"; agent: string | "all"; config: AgentModelConfig }
	| { type: "export"; config: AgentModelConfig }
	| { type: "restore"; config: AgentModelConfig }
	| { type: "cancel" };

const SET_ALL_AGENTS = "Set all agents";

const PANEL_TONE = {
	BORDER: "border",
	MUTED: "muted",
	TEXT: "text",
	TITLE: "title",
	ACCENT: "accent",
	STATUS: "status",
} as const;

type PanelTone = (typeof PANEL_TONE)[keyof typeof PANEL_TONE];

const PANEL_TONE_COLOR: Record<PanelTone, ThemeColor> = {
	border: "border",
	muted: "muted",
	text: "text",
	title: "accent",
	accent: "accent",
	status: "thinkingHigh",
};

class SddModelPanel implements OverlayComponent {
	private cursor = 0;
	private mode: "agents" | "models" | "effort" = "agents";
	private selectedRow = SET_ALL_AGENTS;
	private modelCursor = 0;
	private effortCursor = 0;
	private query = "";
	private readonly draft: AgentModelConfig;
	private readonly rows: string[];
	private readonly modelOptions: string[];
	private readonly done: (result: ModelPanelResult) => void;
	private readonly theme: Theme | undefined;
	// The profile `u` writes to, named up front so the key never targets a surprise.
	private readonly profileLabel: string;
	// Terminal rows, so the card fills the fullscreen overlay like `/nubia:profiles`.
	private readonly terminalRows: (() => number) | undefined;

	constructor(
		initialConfig: AgentModelConfig,
		modelOptions: string[],
		agents: string[],
		done: (result: ModelPanelResult) => void,
		theme?: Theme,
		profileLabel = "none",
		terminalRows?: () => number,
	) {
		this.draft = cloneModelConfig(initialConfig);
		this.rows = [SET_ALL_AGENTS, ...agents];
		this.modelOptions = modelOptions;
		this.done = done;
		this.theme = theme;
		this.profileLabel = profileLabel;
		this.terminalRows = terminalRows;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "models") {
			this.handleModelInput(data);
			return;
		}
		if (this.mode === "effort") {
			this.handleEffortInput(data);
			return;
		}
		this.handleAgentInput(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines =
			this.mode === "models"
				? this.renderModelPicker(innerWidth)
				: this.mode === "effort"
					? this.renderEffortPicker(innerWidth)
					: this.renderAgentList(innerWidth);
		return this.renderCard(lines, width);
	}

	// In the fullscreen overlay a list owns every row its chrome leaves free;
	// without a terminal height it keeps the fixed window.
	private visibleListRows(fixedRows: number, chromeRows: number): number {
		if (!this.terminalRows) return fixedRows;
		return Math.max(1, Math.floor(this.terminalRows()) - chromeRows);
	}

	private renderCard(body: string[], width: number): string[] {
		let lines = body;
		const innerWidth = Math.max(1, width - 4);
		const horizontal = "─".repeat(innerWidth + 2);
		const border = (text: string) => this.renderText(text, "border");
		const bodyRows = this.terminalRows ? Math.floor(this.terminalRows()) - 2 : 0;
		if (lines.length < bodyRows) {
			lines = [...lines, ...Array<string>(bodyRows - lines.length).fill("")];
		}
		return [
			border(`╭${horizontal}╮`),
			...lines.map(
				(line) =>
					`${border("│")} ${this.fitStyledLine(line, innerWidth)} ${border("│")}`,
			),
			border(`╰${horizontal}╯`),
		];
	}

	private fitStyledLine(line: string, width: number): string {
		const visible = stripAnsi(line);
		if (visible.length > width) {
			return truncateToWidth(visible, Math.max(1, width), "…", true);
		}
		return `${line}${" ".repeat(Math.max(0, width - visible.length))}`;
	}

	private renderLine(text = "", width: number, tone?: PanelTone): string {
		const safe = truncateToWidth(
			sanitizeTerminalText(text),
			Math.max(1, width),
			"…",
			true,
		);
		return tone ? this.renderText(safe, tone) : safe;
	}

	private renderText(text: string, tone: PanelTone): string {
		const safe = sanitizeTerminalText(text);
		if (!this.theme) return safe;
		return this.theme.fg(PANEL_TONE_COLOR[tone], safe);
	}

	private renderCursor(focused: boolean): string {
		return focused ? this.renderText("▸", "accent") : " ";
	}

	private handleAgentInput(data: string): void {
		const maxCursor = this.rows.length + 1;
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.done({ type: "save", config: this.draft });
			return;
		}
		if (matchesKey(data, "u")) {
			this.done({ type: "save-profile", config: this.draft });
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.cursor = Math.min(maxCursor, this.cursor + 1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "g")) {
			this.cursor = 0;
			return;
		}
		if (data === "G") {
			this.cursor = maxCursor;
			return;
		}
		if (matchesKey(data, "i")) {
			this.applyInherit();
			return;
		}
		if (matchesKey(data, "e")) {
			this.selectedRow = this.rows[this.cursor] ?? SET_ALL_AGENTS;
			this.mode = "effort";
			this.effortCursor = 0;
			return;
		}
		if (matchesKey(data, "x")) {
			this.done({ type: "export", config: this.draft });
			return;
		}
		if (matchesKey(data, "r")) {
			this.done({ type: "restore", config: this.draft });
			return;
		}
		if (matchesKey(data, "c")) {
			const row = this.rows[this.cursor];
			if (row === SET_ALL_AGENTS)
				this.done({ type: "custom", agent: "all", config: this.draft });
			else if (row)
				this.done({ type: "custom", agent: row, config: this.draft });
			return;
		}
		if (!matchesKey(data, "return")) return;
		if (this.cursor === this.rows.length) {
			this.done({ type: "save", config: this.draft });
			return;
		}
		if (this.cursor === this.rows.length + 1) {
			this.done({ type: "cancel" });
			return;
		}
		this.selectedRow = this.rows[this.cursor] ?? SET_ALL_AGENTS;
		this.mode = "models";
		this.modelCursor = 0;
		this.query = "";
	}

	private handleModelInput(data: string): void {
		const options = this.filteredModelOptions();
		if (matchesKey(data, "ctrl+c")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.mode = "agents";
			this.query = "";
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.modelCursor = Math.min(
				this.modelCursor,
				Math.max(0, this.filteredModelOptions().length - 1),
			);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.modelCursor = Math.min(
				Math.max(0, options.length - 1),
				this.modelCursor + 1,
			);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.modelCursor = Math.max(0, this.modelCursor - 1);
			return;
		}
		if (matchesKey(data, "return")) {
			const selected = options[this.modelCursor];
			if (!selected) return;
			if (selected === CUSTOM_MODEL) {
				this.done({
					type: "custom",
					agent: this.selectedRow === SET_ALL_AGENTS ? "all" : this.selectedRow,
					config: this.draft,
				});
				return;
			}
			if (selected === KEEP_CURRENT) {
				this.mode = "agents";
				return;
			}
			this.applyModelSelection(
				selected === INHERIT_MODEL ? undefined : selected,
			);
			this.mode = "agents";
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.modelCursor = 0;
		}
	}

	private applyModelSelection(model: string | undefined): void {
		const row = this.rows[this.cursor];
		if (row === SET_ALL_AGENTS) {
			for (const name of this.rows.slice(1)) this.setModel(name, model);
			return;
		}
		if (!row) return;
		this.setModel(row, model);
	}

	private applyThinkingSelection(thinking: ThinkingLevel | undefined): void {
		const row = this.selectedRow;
		if (row === SET_ALL_AGENTS) {
			for (const name of this.rows.slice(1)) this.setThinking(name, thinking);
			return;
		}
		this.setThinking(row, thinking);
	}

	private applyInherit(): void {
		const row = this.rows[this.cursor];
		if (row === SET_ALL_AGENTS) {
			for (const name of this.rows.slice(1)) this.clearEntry(name);
			return;
		}
		if (row) this.clearEntry(row);
	}

	private setModel(name: string, model: string | undefined): void {
		const current = this.draft[name] ?? {};
		if (model === undefined) delete current.model;
		else current.model = model;
		if (!current.model && !current.thinking) this.draft[name] = {};
		else this.draft[name] = current;
	}

	private setThinking(name: string, thinking: ThinkingLevel | undefined): void {
		const current = this.draft[name] ?? {};
		if (thinking === undefined) delete current.thinking;
		else current.thinking = thinking;
		if (!current.model && !current.thinking) this.draft[name] = {};
		else this.draft[name] = current;
	}

	private clearEntry(name: string): void {
		this.draft[name] = {};
	}

	private filteredModelOptions(): string[] {
		const query = this.query.trim().toLowerCase();
		if (!query) return this.modelOptions;
		return this.modelOptions.filter((option) =>
			option.toLowerCase().includes(query),
		);
	}

	private renderAgentList(width: number): string[] {
		const lines: string[] = [];
		const line = (text = "", tone?: PanelTone) =>
			this.renderLine(text, width, tone);
		lines.push(line("Assign Models and Effort to Agents", "title"));
		lines.push(line(`Current profile: ${this.profileLabel}`, "muted"));
		lines.push("");
		lines.push(line("Current assignments:", "muted"));
		lines.push("");
		const visibleRows = Math.min(
			this.visibleListRows(AGENT_LIST_MAX_VISIBLE_ROWS, AGENT_LIST_CHROME_ROWS),
			this.rows.length,
		);
		const listCursor = Math.min(this.cursor, this.rows.length - 1);
		const start = Math.max(
			0,
			Math.min(
				listCursor - Math.floor(visibleRows / 2),
				Math.max(0, this.rows.length - visibleRows),
			),
		);
		const end = Math.min(this.rows.length, start + visibleRows);
		if (start > 0) lines.push(line(`  ↑ ${start} more agent(s)`, "muted"));
		for (let i = start; i < end; i++) {
			const row = this.rows[i] ?? SET_ALL_AGENTS;
			const focused = i === this.cursor;
			const label =
				row === SET_ALL_AGENTS
					? this.renderSetAllLabel(row)
					: this.renderAgentLabel(row);
			lines.push(`${this.renderCursor(focused)} ${label}`);
		}
		if (end < this.rows.length)
			lines.push(line(`  ↓ ${this.rows.length - end} more agent(s)`, "muted"));
		lines.push("");
		lines.push(
			`${this.renderCursor(this.cursor === this.rows.length)} ${this.renderText(
				"Continue",
				this.cursor === this.rows.length ? "accent" : "text",
			)}`,
		);
		lines.push(
			`${this.renderCursor(this.cursor === this.rows.length + 1)} ${this.renderText(
				"← Back",
				this.cursor === this.rows.length + 1 ? "accent" : "text",
			)}`,
		);
		lines.push("");
		// Two rows: editing keys, then the keys that leave the panel. One row no
		// longer fits the minimum width once the profile key joins the save keys.
		lines.push(
			line(
				`j/k scroll • enter model/save • e effort • i inherit • c custom`,
				"muted",
			),
		);
		lines.push(
			line(
				`x export • r restore • ctrl+s save • u capture session in "${this.profileLabel}" • esc back`,
				"muted",
			),
		);
		return lines;
	}

	private renderModelPicker(width: number): string[] {
		const lines: string[] = [];
		const options = this.filteredModelOptions();
		const line = (text = "", tone?: PanelTone) =>
			this.renderLine(text, width, tone);
		lines.push(
			line(`Select model for ${sanitizeTerminalText(this.selectedRow)}`, "title"),
		);
		lines.push("");
		lines.push(
			`${this.renderText("◎", "accent")} ${this.renderText(this.query || "search...", "muted")}`,
		);
		lines.push("");
		const visibleRows = this.visibleListRows(MODEL_LIST_MAX_VISIBLE_ROWS, MODEL_LIST_CHROME_ROWS);
		const start = Math.max(
			0,
			Math.min(
				this.modelCursor - Math.floor(visibleRows / 2),
				Math.max(0, options.length - visibleRows),
			),
		);
		const end = Math.min(options.length, start + visibleRows);
		for (let i = start; i < end; i++) {
			const focused = i === this.modelCursor;
			lines.push(
				`${this.renderCursor(focused)} ${this.renderText(
					(options[i] ?? ""),
					focused ? "status" : "text",
				)}`,
			);
		}
		if (options.length === 0) lines.push(line("  No matching models", "muted"));
		lines.push("");
		lines.push(
			line("j/k: navigate • type: search • enter: select • esc: back", "muted"),
		);
		return lines;
	}

	private handleEffortInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.mode = "agents";
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.effortCursor = Math.min(
				Math.max(0, THINKING_OPTIONS.length - 1),
				this.effortCursor + 1,
			);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.effortCursor = Math.max(0, this.effortCursor - 1);
			return;
		}
		if (!matchesKey(data, "return")) return;
		const selected = THINKING_OPTIONS[this.effortCursor];
		if (selected === INHERIT_THINKING) this.applyThinkingSelection(undefined);
		else this.applyThinkingSelection(selected);
		this.mode = "agents";
	}

	private renderEffortPicker(width: number): string[] {
		const lines: string[] = [];
		const line = (text = "", tone?: PanelTone) =>
			this.renderLine(text, width, tone);
		lines.push(
			line(`Select effort for ${sanitizeTerminalText(this.selectedRow)}`, "title"),
		);
		lines.push("");
		for (let i = 0; i < THINKING_OPTIONS.length; i++) {
			const focused = i === this.effortCursor;
			lines.push(
				`${this.renderCursor(focused)} ${this.renderText(
					(THINKING_OPTIONS[i] ?? ""),
					focused ? "status" : "text",
				)}`,
			);
		}
		lines.push("");
		lines.push(line("j/k: navigate • enter: select • esc: back", "muted"));
		return lines;
	}

	private renderSetAllLabel(row: string): string {
		const models = this.rows
			.slice(1)
			.map((name) => this.draft[name]?.model ?? "inherit");
		const efforts = this.rows
			.slice(1)
			.map((name) => this.draft[name]?.thinking ?? "inherit");
		const firstModel = models[0] ?? "inherit";
		const firstEffort = efforts[0] ?? "inherit";
		const modelLabel = models.every((value) => value === firstModel)
			? firstModel
			: "mixed";
		const effortLabel = efforts.every((value) => value === firstEffort)
			? firstEffort
			: "mixed";
		return `${this.renderText(sanitizeTerminalText(row).padEnd(20), "text")} ${this.renderText("model=", "muted")}${this.renderText(modelLabel, "status")}${this.renderText(
			", effort=",
			"muted",
		)}${this.renderText(effortLabel, "status")}`;
	}

	private renderAgentLabel(row: string): string {
		const model = this.draft[row]?.model ?? "inherit";
		const effort = this.draft[row]?.thinking ?? "inherit";
		return `${this.renderText(sanitizeTerminalText(row).padEnd(20), "text")} ${this.renderText("model=", "muted")}${this.renderText(model, "status")}${this.renderText(
			", effort=",
			"muted",
		)}${this.renderText(effort, "status")}`;
	}
}

function renderSddModelPanelForTesting(
	initialConfig: AgentModelConfig,
	modelOptions: string[],
	agents: string[],
	width: number,
	theme?: Theme,
	terminalRows?: number,
	inputs: string[] = [],
): string[] {
	const panel = new SddModelPanel(
		initialConfig,
		modelOptions,
		agents,
		() => {},
		theme,
		undefined,
		terminalRows === undefined ? undefined : () => terminalRows,
	);
	for (const data of inputs) panel.handleInput(data);
	return panel.render(width);
}

async function showSddModelPanel(
	ctx: ExtensionContext,
	config: AgentModelConfig,
	profileLabel: string,
): Promise<ModelPanelResult> {
	const modelOptions = await getPiModelOptions(ctx);
	const agents = modelAssignmentNames(ctx.cwd);
	return ctx.ui.custom<ModelPanelResult>(
		(tui, theme, _keybindings, done) =>
			new SddModelPanel(config, modelOptions, agents, done, theme, profileLabel, () =>
				Math.max(0, tui.terminal.rows),
			),
		{
			overlay: true,
			// Same fullscreen dimensions as the `/nubia:profiles` panel.
			overlayOptions: {
				anchor: "center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

async function handleModelsCommand(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	migrateLegacyProjectModelOverrides(ctx.cwd);
	// A pinned repository resolves its subagent routing from the profile at launch,
	// so global routing written here will not reach its subagents. Saying it before
	// the edits, not after them, is the difference between a note and a surprise.
	const pinNote = profilePinScopeNote(ctx.cwd);
	if (pinNote) ctx.ui.notify(pinNote, "info");
	const savedConfig = await readModelRoutingAuthorityAsync(
		modelConfigReadPath(ctx.cwd),
		legacyProjectModelConfigPath(ctx.cwd),
	);
	if (savedConfig.status === "invalid") {
		ctx.ui.notify(
			`Nub-IA cannot open model config because ${savedConfig.path} is invalid JSON or not an object. Fix or remove the file, then run /nubia:models again.`,
			"warning",
		);
		return;
	}
	let config = savedConfig.status === "valid" ? savedConfig.config : {};
	const profileLabel = describeCurrentProfileTarget(resolveCurrentProfileTarget(ctx.cwd));
	let result = await showSddModelPanel(ctx, config, profileLabel);
	while (result.type === "custom" || result.type === "export" || result.type === "restore") {
		config = cloneModelConfig(result.config);
		if (result.type === "export") {
			try {
				const count = await exportSavedModelConfig(ctx);
				ctx.ui.notify(`Nub-IA exported ${count} saved model routing entr${count === 1 ? "y" : "ies"} to ${modelExportPath(ctx.cwd)}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Model routing export failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			result = await showSddModelPanel(ctx, config, profileLabel);
			continue;
		}
		if (result.type === "restore") {
			const restored = await readModelExport(ctx);
			if (!restored) {
				ctx.ui.notify(`Model routing restore failed: ${modelExportPath(ctx.cwd)} is missing or invalid.`, "warning");
				result = await showSddModelPanel(ctx, config, profileLabel);
				continue;
			}
			const approved = await ctx.ui.confirm("Restore saved model routing?", `Replace ${modelConfigPath(ctx.cwd)} with ${modelExportPath(ctx.cwd)}`);
			if (approved) {
				try {
					await writeModelConfigAsync(ctx.cwd, restored);
				} catch (error) {
					ctx.ui.notify(`Model routing restore failed before writing config: ${error instanceof Error ? error.message : String(error)}`, "warning");
					result = await showSddModelPanel(ctx, config, profileLabel);
					continue;
				}
				config = restored;
				try {
					const applyResult = await applyModelConfigAsync(ctx.cwd, restored);
					ctx.ui.notify([
						"Nub-IA restored global model config.",
						`Import: ${modelExportPath(ctx.cwd)}`,
						`Global config: ${modelConfigPath(ctx.cwd)}`,
						`Agents updated: ${applyResult.updated}`,
					].join("\n"), "info");
				} catch (error) {
					ctx.ui.notify([
						"Nub-IA restored global model config, but applying it to agents failed.",
						`Global config: ${modelConfigPath(ctx.cwd)}`,
						`Apply error: ${error instanceof Error ? error.message : String(error)}`,
					].join("\n"), "warning");
				}
			}
			result = await showSddModelPanel(ctx, config, profileLabel);
			continue;
		}
		const current =
			result.agent === "all"
				? "inherit"
				: (config[result.agent]?.model ?? "inherit");
		const custom = await ctx.ui.input(
			`${result.agent === "all" ? "all agents" : sanitizeTerminalText(result.agent)} custom model id`,
			current === "inherit" ? "provider/model" : sanitizeTerminalText(current),
		);
		if (custom === undefined) return;
		const trimmed = custom.trim();
		if (trimmed.length > 0) {
			const model = normalizeModelId(trimmed);
			if (!model) {
				ctx.ui.notify(
					"Custom model id must be a single-line provider/model identifier using letters, numbers, '.', '-', '_', '~', ':', '@', '/', '+', '%' only.",
					"warning",
				);
				result = await showSddModelPanel(ctx, config, profileLabel);
				continue;
			}
			if (result.agent === "all") {
				const next: AgentModelConfig = { ...config };
				for (const name of modelAssignmentNames(ctx.cwd)) {
					next[name] = {
						...(next[name] ?? {}),
						model,
					};
				}
				config = next;
			} else {
				config = {
					...config,
					[result.agent]: {
						...(config[result.agent] ?? {}),
						model,
					},
				};
			}
		}
		result = await showSddModelPanel(ctx, config, profileLabel);
	}
	if (result.type !== "save" && result.type !== "save-profile") return;
	writeModelConfig(ctx.cwd, result.config);
	const applyResult = await applyModelConfigAsync(ctx.cwd, result.config);
	ctx.ui.notify(
		[
			"Nub-IA global model config saved.",
			`Global config: ${modelConfigPath(ctx.cwd)}`,
			`Agents updated: ${applyResult.updated}`,
			...describeModelConfig(ctx.cwd, result.config),
		].join("\n"),
		"info",
	);
	if (result.type === "save-profile") updateCurrentProfileFromSavedRouting(ctx, pi);
}

/** The profile `u` in `/nubia:models` writes to, and why it is that one. */
interface CurrentProfileTarget {
	name: string;
	source: "pinned" | "active";
}

/**
 * A pinned repository launches with its pinned profile, so that profile is the
 * one worth updating from here; anywhere else the globally active profile is.
 * Neither existing yields no target rather than a guess.
 */
function resolveCurrentProfileTarget(
	cwd: string,
	store: ProfilesFileReadResult = readProfilesFileResult(profilesReadFilePath(gentleAiConfigHome())),
): CurrentProfileTarget | undefined {
	const pin = resolveProfilePin({ cwd, configHome: gentleAiConfigHome() });
	if (pin) return { name: pin.profile, source: "pinned" };
	if (store.status !== "valid" || store.file.active === undefined) return undefined;
	if (!hasOwnProfile(store.file.profiles, store.file.active)) return undefined;
	return { name: store.file.active, source: "active" };
}

function describeCurrentProfileTarget(target: CurrentProfileTarget | undefined): string {
	if (!target) return "none";
	return target.source === "pinned" ? `${target.name} (pinned)` : target.name;
}

/**
 * The second half of `u` captures saved global agent routing (never the pin)
 * and the live session orchestrator. Without a live model it falls back to
 * persisted settings. The global save has already been reported, so every
 * outcome here speaks only about the profile.
 */
function updateCurrentProfileFromSavedRouting(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const path = profilesFilePath(gentleAiConfigHome());
	const read = readProfilesFileResult(profilesReadFilePath(gentleAiConfigHome()));
	if (read.status === "invalid") {
		ctx.ui.notify(
			`Nub-IA saved the global routing, but cannot update a profile because ${sanitizeTerminalText(path)} is invalid JSON or not a profiles file. Fix or remove the file, then run /nubia:profiles again.`,
			"warning",
		);
		return;
	}
	const snapshot = profileSnapshotFrom(
		readGlobalEffectiveModelConfig(ctx.cwd),
		readOrchestratorSettings(orchestratorSettingsPath()),
	);
	if (ctx.model) {
		snapshot[PROFILE_ORCHESTRATOR_KEY] = {
			model: `${ctx.model.provider}/${ctx.model.id}`,
			thinking: pi.getThinkingLevel(),
		};
	}
	if (read.status === "missing") {
		// The same seed `/nubia:profiles` performs on its first open, so pressing
		// `u` before ever opening that panel lands on the same "current" profile.
		try {
			writeProfilesFileSync(path, bootstrapProfilesFile(snapshot));
		} catch (error) {
			ctx.ui.notify(
				`Nub-IA saved the global routing, but could not create ${sanitizeTerminalText(path)}: ${profilesErrorMessage(error)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(`Nub-IA seeded the "current" profile in ${sanitizeTerminalText(path)} from the routing just saved.`, "info");
		return;
	}
	reportProfilesDrops(ctx, path, read.drops);
	const target = resolveCurrentProfileTarget(ctx.cwd, read);
	if (!target) {
		ctx.ui.notify(
			"Nub-IA saved the global routing, but no profile is current: none is active and this repository pins none. Apply or create one with /nubia:profiles, then press u here or s there.",
			"warning",
		);
		return;
	}
	try {
		writeProfilesFileSync(path, updateProfile(read.file, target.name, snapshot));
	} catch (error) {
		ctx.ui.notify(
			`Nub-IA saved the global routing, but profile "${target.name}" was not updated: ${profilesErrorMessage(error)}`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(
		[
			`Nub-IA: Profile "${target.name}" updated from the routing just saved (${target.source === "pinned" ? "this repository's pinned profile" : "the active profile"}).`,
			`Profiles store: ${sanitizeTerminalText(path)}`,
		].join("\n"),
		"info",
	);
}

/** Names of the preset profiles shipped in assets/profiles/*.json. */
function listPackagedProfilePresets(): string[] {
	try {
		return readdirSync(join(ASSETS_DIR, "profiles"))
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => entry.slice(0, -".json".length))
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

type ProfilesPanelResult =
	| { type: "apply"; name: string }
	| { type: "apply-global"; name: string }
	| { type: "create" }
	| { type: "update"; name: string }
	| { type: "duplicate"; name: string }
	| { type: "rename"; name: string }
	| { type: "delete"; name: string }
	| { type: "export"; name: string }
	| { type: "pin"; source: ProfilePinSource; name: string }
	| { type: "import" }
	| { type: "close" };

type ProfilesSnapshotHandler = (name: string) => AgentProfilesFile;

/**
 * What a panel action hands the reopened panel: a one-line status for the footer,
 * because notifications stay hidden behind the fullscreen overlay until it closes,
 * and the profile to select when the action created or renamed one.
 */
interface ProfilesPanelReport {
	status?: string;
	selectedName?: string;
}

const PROFILES_PANEL_MIN_BODY_ROWS = 6;

type ProfilesPanelPointerLayout = AgentsViewLayout & { listTop: number };

function hasOwnProfile(profiles: Record<string, unknown>, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(profiles, name);
}

function profilesErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The pin layer that wins, in one line: the winning layer's scope, name, and exact
 * file path, or the first stale layer named as missing from the loaded store. An
 * invalid layer is reported by `profilePinDetailLines` instead, because a file that
 * is not a pin is not a layer that could ever win.
 */
function profilePinStateLabel(
	status: ProfilePinStatus | undefined,
	evaluation: ProfilePinEvaluation,
): string {
	if (!status) return "none (not inside a Git worktree)";
	if (evaluation.winner) {
		return `${evaluation.winner.source}: ${evaluation.winner.profile} — ${evaluation.winner.path}`;
	}
	const stale = evaluation.stale[0];
	if (stale) return `${stale.source}: ${stale.profile} (missing from this store) — ${stale.path}`;
	return "none";
}

/**
 * Every line the panel needs to tell a pinned repository the truth: the winning
 * layer and its exact file, an explicit warning for a file that is not a pin named
 * by path (kept separate from a pin naming a profile this store no longer defines),
 * and one sentence that a winning pin outranks the global active profile and every
 * `/nubia:models` write.
 */
function profilePinDetailLines(
	status: ProfilePinStatus | undefined,
	profiles: Record<string, unknown>,
): string[] {
	const evaluation = evaluateProfilePin(status, profiles);
	const lines = [`pin           ${profilePinStateLabel(status, evaluation)}`];
	const shownStale = evaluation.winner ? undefined : evaluation.stale[0];
	for (const issue of evaluation.invalid) {
		lines.push(`              invalid pin file ${issue.path} (${issue.source} layer); ignoring it — fix or remove the file.`);
	}
	for (const issue of evaluation.stale) {
		if (issue === shownStale) continue;
		lines.push(`              the ${issue.source} pin names "${issue.profile}", which this store does not define; ignoring it (${issue.path}).`);
	}
	if (evaluation.winner) {
		lines.push("              This repository's subagent routing comes from the pin; the globally active profile and /nubia:models writes do not apply here.");
	}
	return lines;
}

/**
 * Keep the clone-scoped pin pointing at the profile it names after a rename. The
 * repository declaration is a tracked file, so rewriting it would churn a commit
 * behind the operator's back; a declaration that still names the old profile is
 * reported instead, and `P` republishes it. Layers that name something else, or no
 * layer at all, are left alone.
 */
function followRenamedPin(
	cwd: string,
	from: string,
	to: string,
): { followed: string[]; stillDeclared: string[] } {
	const status = readProfilePinStatus(cwd);
	if (!status) return { followed: [], stillDeclared: [] };
	const followed: string[] = [];
	const stillDeclared: string[] = [];
	if (status.local.status === "valid" && status.local.profile === from) {
		try {
			writeProfilePinSync(status.localPath, to);
			followed.push(status.localPath);
		} catch {
			// A pin that cannot be rewritten is reported by the pin line and degrades to
			// the global routing, exactly like any other stale pin; a rename that already
			// succeeded in the store is not undone by it.
		}
	}
	if (status.repo.status === "valid" && status.repo.profile === from) {
		stillDeclared.push(status.repoPath);
	}
	return { followed, stillDeclared };
}

/**
 * One sentence naming the profile this repository resolves, for the commands whose
 * writes a pin outranks: `/nubia:models` materializes global routing that a pinned
 * repository will not use for its subagents. The launch resolver decides, so the note
 * names exactly what a launch would use.
 */
function profilePinScopeNote(cwd: string): string | undefined {
	const resolution = resolveProfilePin({ cwd, configHome: gentleAiConfigHome() });
	if (!resolution) return undefined;
	return sanitizeTerminalText(
		`This repository pins profile "${resolution.profile}" (${resolution.source} pin at ${resolution.path}), so its subagent launches resolve that profile instead of the global routing. Change or remove the pin with /nubia:profiles (p or P).`,
	);
}

/**
 * Whether the committed declaration would actually be committed. This shells out to
 * Git, so it runs only on the key press that writes the declaration and makes at most
 * two bounded calls. Any Git failure is reported as unknown instead of thrown: a pin
 * write that already succeeded must not become an error because a probe about sharing
 * it failed.
 */
function repoDeclarationSharing(root: string, path: string): string {
	const relativePath = relative(root, path).split(sep).join("/");
	const run = (...arguments_: string[]): string =>
		execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
	try {
		// Exit 0 means gitignore matches the path; the exact negation line is what makes
		// the declaration committable again.
		run("check-ignore", "--quiet", relativePath);
		return [
			`This worktree ignores ${relativePath}; add these exact lines to the root .gitignore to share only this declaration:`,
			...REPO_PROFILE_DECLARATION_GITIGNORE_RULES,
		].join("\n");
	} catch (error) {
		// Exit 1 means "not ignored"; anything else (including a missing git) is unknown.
		const exitStatus = (error as { status?: number }).status;
		if (exitStatus !== 1) return `Git could not say whether ${relativePath} is tracked; check it before committing.`;
	}
	try {
		run("ls-files", "--error-unmatch", relativePath);
		return `${relativePath} is tracked by Git; commit the change to share it.`;
	} catch {
		return `${relativePath} is not ignored, so it is committable as-is.`;
	}
}

/** Keep a detail-pane scroll offset inside the bounds of its own content. */
function clampDetailScroll(offset: number, lineCount: number, bodyRows: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, lineCount - bodyRows)));
}

// Left profile list, right detail panes. Rendering and pointer routing share
// one measured layout; the list rows keep native keyboard, hover, press,
// click, and wheel handling through NativeChoiceList. The frame takes the full
// overlay, so its height follows the terminal rows the same way AgentsView does.
class ProfilesPanel implements OverlayComponent {
	private completed = false;
	private pointerLayout: ProfilesPanelPointerLayout | undefined;
	private detailScroll = 0;
	private lastDetailLineCount = 0;
	private lastDetailRows = 0;
	private lastSelectedId: string | undefined;
	private feedback: string | undefined;
	readonly list: NativeChoiceList<ProfileListItem>;
	private file: AgentProfilesFile;
	private readonly currentConfig: AgentModelConfig;
	private readonly done: (result: ProfilesPanelResult) => void;
	private readonly saveSnapshot: ProfilesSnapshotHandler;
	private readonly requestRender: () => void;
	private readonly listItems: ProfileListItem[];
	private readonly theme: Theme | undefined;
	private readonly rows: () => number;
	private readonly orchestratorSettings: OrchestratorSettingsReadResult;
	// Actions reopen the panel, refreshing this snapshot without disk reads during rendering.
	private readonly pinStatus: ProfilePinStatus | undefined;
	private readonly sessionBoundName: string | undefined;

	constructor(
		file: AgentProfilesFile,
		currentConfig: AgentModelConfig,
		done: (result: ProfilesPanelResult) => void,
		keybindings: KeybindingsManager | undefined,
		theme: Theme | undefined,
		selectedName: string | undefined,
		rows: () => number,
		orchestratorSettings: OrchestratorSettingsReadResult,
		saveSnapshot: ProfilesSnapshotHandler,
		requestRender: () => void,
		pinStatus: () => ProfilePinStatus | undefined,
		sessionBound: () => string | undefined,
		feedback?: string,
	) {
		this.file = file;
		this.feedback = feedback;
		this.currentConfig = currentConfig;
		this.done = done;
		this.saveSnapshot = saveSnapshot;
		this.requestRender = requestRender;
		this.theme = theme;
		this.rows = rows;
		this.orchestratorSettings = orchestratorSettings;
		this.pinStatus = pinStatus();
		this.sessionBoundName = sessionBound();
		const items = buildProfileListItems(file, evaluateProfilePin(this.pinStatus, file.profiles).winner?.profile, this.sessionBoundName);
		this.listItems = items;
		this.list = new NativeChoiceList<ProfileListItem>(
			items,
			{
				selectedPrefix: (text) => this.renderText(text, "accent"),
				selectedText: (text) => this.renderText(text, "accent"),
				description: (text) => this.renderText(text, "muted"),
				hoverBackground: (text) => (this.theme ? this.theme.bg("toolPendingBg", text) : text),
			},
			keybindings,
		);
		this.list.onSelect = (item) => this.finish({ type: "apply", name: item.id });
		this.list.onCancel = () => this.finish({ type: "close" });
		const selected = selectedName ? items.findIndex((item) => item.id === selectedName) : -1;
		if (selected >= 0) this.list.setSelectedIndex(selected);
	}

	invalidate(): void {
		this.pointerLayout = undefined;
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.finish({ type: "close" });
			return;
		}
		const name = this.list.getSelectedItem()?.id;
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("j"))) {
			this.scrollDetail(this.pageRows());
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("k"))) {
			this.scrollDetail(-this.pageRows());
			return;
		}
		// Agents-view line scroll: j/k move the routing one line at a time. The
		// arrow keys stay with the profile list, exactly as the letters below stay
		// profile actions.
		if (data === "j") {
			this.scrollDetail(1);
			return;
		}
		if (data === "k") {
			this.scrollDetail(-1);
			return;
		}
		if (data === "c") return this.finish({ type: "create" });
		if (data === "i") return this.finish({ type: "import" });
		if (!name) return this.list.handleInput(data);
		if (data === "s") {
			try {
				this.file = this.saveSnapshot(name);
				this.refreshListItems();
				this.feedback = `Snapshot saved; live routing unchanged. Profile "${name}" saved from current routing.`;
			} catch (error) {
				this.feedback = `Snapshot failed; live routing unchanged. Profile "${name}" was not saved from current routing: ${profilesErrorMessage(error)}`;
			}
			this.requestRender();
			return;
		}
		if (data === "a") return this.finish({ type: "apply-global", name });
		if (data === "d") return this.finish({ type: "duplicate", name });
		if (data === "r") return this.finish({ type: "rename", name });
		if (data === "x") return this.finish({ type: "delete", name });
		if (data === "e") return this.finish({ type: "export", name });
		if (data === "p") return this.finish({ type: "pin", source: "local", name });
		if (data === "P") return this.finish({ type: "pin", source: "repo", name });
		this.list.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const layout = this.pointerLayout;
		if (!layout) return undefined;
		const inBody = event.y >= layout.listTop && event.y < layout.listTop + layout.bodyRows;
		if (
			inBody &&
			event.type === "wheel" &&
			event.wheelDelta &&
			layout.mode === "panes" &&
			event.x >= layout.threadX &&
			event.x < layout.threadX + layout.threadWidth
		) {
			this.scrollDetail(event.wheelDelta);
			return { handled: true, render: true };
		}
		if (!inBody) return undefined;
		if (event.x < layout.listX || event.x >= layout.listX + layout.listWidth) return undefined;
		return this.list.handleMouse({
			...event,
			x: event.x - layout.listX,
			y: event.y - layout.listTop,
			width: layout.listWidth,
			height: layout.bodyRows,
		});
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const listWidth = measureAgentsViewLayout(safeWidth, PROFILES_PANEL_MIN_BODY_ROWS + 3).listWidth;
		const listLines = this.list.render(listWidth);
		// The frame fills the overlay, and the overlay fills the terminal, so the
		// body height comes from the terminal rows rather than from the content.
		const rows = Math.max(PROFILES_PANEL_MIN_BODY_ROWS + 3, Math.floor(this.rows()));
		const layout = measureAgentsViewLayout(safeWidth, rows);
		if (layout.mode === "fallback" || layout.width === 0) {
			this.pointerLayout = undefined;
			return [];
		}
		const selectedId = this.list.getSelectedItem()?.id;
		if (selectedId !== this.lastSelectedId) {
			this.lastSelectedId = selectedId;
			this.detailScroll = 0;
		}
		const detailLines = this.renderDetailLines(layout.threadWidth, layout.mode === "panes");
		this.lastDetailLineCount = detailLines.length;
		this.lastDetailRows = layout.bodyRows;
		this.detailScroll = clampDetailScroll(this.detailScroll, detailLines.length, layout.bodyRows);
		this.pointerLayout = { ...layout, listTop: 1 };
		const rule = "─".repeat(Math.max(0, layout.width - 2));
		const lines: string[] = [this.renderText(`╭${rule}╮`, "border")];
		for (let row = 0; row < layout.bodyRows; row += 1) {
			lines.push(this.renderBodyRow(row, layout, listLines, detailLines));
		}
		lines.push(this.renderFooterRow(layout.width));
		lines.push(this.renderText(`╰${rule}╯`, "border"));
		return lines;
	}

	private scrollDetail(delta: number): void {
		this.detailScroll = clampDetailScroll(
			this.detailScroll + Math.trunc(delta),
			this.lastDetailLineCount,
			this.lastDetailRows,
		);
	}

	private refreshListItems(): void {
		// Keep the list instance (and its pointer observer) alive while refreshing the
		// mutable item records that NativeChoiceList already holds by reference.
		for (const item of buildProfileListItems(this.file, evaluateProfilePin(this.pinStatus, this.file.profiles).winner?.profile, this.sessionBoundName)) {
			const current = this.listItems.find((candidate) => candidate.id === item.id);
			if (current) Object.assign(current, item);
		}
		this.list.refreshItems();
	}

	private pageRows(): number {
		return Math.max(1, this.lastDetailRows - 1);
	}

	private finish(result: ProfilesPanelResult): void {
		if (this.completed) return;
		this.completed = true;
		this.list.setDisabled(true);
		this.done(result);
	}

	private renderBodyRow(
		row: number,
		layout: AgentsViewLayout,
		listLines: string[],
		detailLines: string[],
	): string {
		if (layout.mode === "panes") {
			return [
				this.renderText("│", "border"),
				" ",
				this.fitPaneLine(listLines[row] ?? "", layout.listWidth),
				" ",
				this.renderText("│", "border"),
				" ",
				this.fitPaneLine(detailLines[this.detailScroll + row] ?? "", layout.threadWidth),
				this.renderText("│", "border"),
			].join("");
		}
		return [
			this.renderText("│", "border"),
			" ",
			this.fitPaneLine(listLines[row] ?? "", layout.listWidth),
			" ",
			this.renderText("│", "border"),
		].join("");
	}

	private renderFooterRow(width: number): string {
		const hints =
			"enter use in this session · a set as global default · c create · s snapshot · d duplicate · r rename · x delete · e export · i import (file or preset) · p pin · P share · j/k line · ctrl+j/k page · esc close";
		const text = this.feedback ?? hints;
		return [
			this.renderText("│", "border"),
			" ",
			this.fitPaneLine(this.renderText(text, this.feedback ? "status" : "muted"), width - 4),
			" ",
			this.renderText("│", "border"),
		].join("");
	}

	private renderDetailLines(width: number, showDetail: boolean): string[] {
		if (!showDetail) return [];
		const name = this.list.getSelectedItem()?.id;
		if (!name || !hasOwnProfile(this.file.profiles, name)) {
			return [this.renderLine("No profile selected.", width, "muted")];
		}
		const config = this.file.profiles[name];
		const profileRows = profileRoutingRows(config);
		const currentRows = profileRoutingRows(this.currentConfig);
		// One shared measurement across both tables, so the same agent sits in the
		// same column whether it comes from the profile or from models.json.
		const widths = routingColumnWidths(profileRows, currentRows);
		return [
			this.renderLine(name === this.file.active ? `${name} (active)` : name, width, "title"),
			this.renderLine(
				`orchestrator  ${formatOrchestratorSelection(readProfileOrchestrator(config))}`,
				width,
				"text",
			),
			this.renderLine(`now           ${this.effectiveOrchestratorLabel()}`, width, "muted"),
			// A pin only redirects subagent routing, so it is reported next to the
			// orchestrator lines it deliberately does not move. The winning layer's path,
			// any invalid or stale layer, and the scope sentence all come from the shared
			// precedence rule the launch resolver uses.
			...profilePinDetailLines(this.pinStatus, this.file.profiles).map((line) => this.renderLine(line, width, "muted")),
			// gentle-shell#1064 slice 1: the binding is stored for this session and
			// outranks the pin in the panel list, so it is named right after the pin
			// layers. Launch resolution ships with slice 2 (gentle-shell#1558); this
			// slice stores the binding only, launch routing is unchanged, and nothing
			// was written.
			...(this.sessionBoundName === undefined
				? []
				: [this.renderLine(`session        ${sanitizeTerminalText(this.sessionBoundName)} (session) — stored for this session; launch routing is unchanged; nothing was written`, width, "muted")]),
			"",
			this.renderLine("Profile routing", width, "accent"),
			...this.indentLines(this.routingLines(profileRows, widths), width),
			"",
			this.renderLine("Current routing (effective)", width, "accent"),
			...this.indentLines(this.routingLines(currentRows, widths), width),
		];
	}

	private effectiveOrchestratorLabel(): string {
		const settings = this.orchestratorSettings;
		if (settings.status === "invalid") {
			return `unreadable (${sanitizeTerminalText(settings.reason)})`;
		}
		return formatOrchestratorSelection(settings.status === "valid" ? settings.entry : undefined);
	}

	private routingLines(
		rows: ProfileRoutingRow[],
		widths: { agent: number; model: number },
	): string[] {
		if (rows.length === 0) {
			return ["No routing entries — every agent inherits its default model."];
		}
		return rows.map((row) => formatRoutingRow(row, widths));
	}

	private indentLines(lines: string[], width: number): string[] {
		return lines.map((line) => this.renderLine(`  ${line}`, width, "text"));
	}

	private fitPaneLine(line: string, width: number): string {
		const visible = stripAnsi(line);
		if (visible.length > width) {
			return truncateToWidth(visible, Math.max(1, width), "…", true);
		}
		return `${line}${" ".repeat(Math.max(0, width - visible.length))}`;
	}

	private renderLine(text: string, width: number, tone?: PanelTone): string {
		const safe = truncateToWidth(
			sanitizeTerminalText(text),
			Math.max(1, width),
			"…",
			true,
		);
		return tone ? this.renderText(safe, tone) : safe;
	}

	private renderText(text: string, tone: PanelTone): string {
		const safe = sanitizeTerminalText(text);
		if (!this.theme) return safe;
		return this.theme.fg(PANEL_TONE_COLOR[tone], safe);
	}
}

/** The full-screen profile picker: one visit per action, so every reopen reads fresh store, pin, orchestrator, and session-binding state. */
async function showProfilesPanel(
	ctx: ExtensionContext,
	file: AgentProfilesFile,
	currentConfig: AgentModelConfig,
	selectedName: string | undefined,
	saveSnapshot: ProfilesSnapshotHandler,
	status?: string,
	sessionBoundName?: string,
): Promise<ProfilesPanelResult> {
	// Both orchestrator and pin state are snapshots for this panel visit.
	// Actions (including p/P) reopen the panel and read fresh state.
	const orchestratorSettings = readOrchestratorSettings(orchestratorSettingsPath());
	return ctx.ui.custom<ProfilesPanelResult>(
		(tui, theme, keybindings, done) => {
			const panel = new ProfilesPanel(
				file,
				currentConfig,
				done,
				keybindings,
				theme,
				selectedName,
				() => Math.max(0, tui.terminal.rows),
				orchestratorSettings,
				saveSnapshot,
				() => tui.requestRender(),
				() => readProfilePinStatus(ctx.cwd),
				() => sessionBoundName,
				status,
			);
			const container = createNativeFullscreenInteraction({
				keyboardTarget: panel,
				requestRender: () => tui.requestRender(),
				mouseObserver: panel.list.createMouseObserver(() => tui.requestRender()),
			});
			container.addChild(panel);
			return container;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

function reportProfilesDrops(ctx: ExtensionContext, path: string, drops: ProfilesParseDrops): void {
	// Dropped names are by definition the ones that failed validation, so they are
	// untrusted input reaching the terminal and must be sanitized like any other
	// externally supplied text.
	const parts: string[] = [];
	if (drops.droppedProfiles.length > 0) {
		parts.push(`profiles: ${drops.droppedProfiles.map((name) => sanitizeTerminalText(name)).join(", ")}`);
	}
	if (drops.droppedAgents.length > 0) {
		parts.push(
			`routing entries: ${drops.droppedAgents.map(({ profile, agent }) => `${sanitizeTerminalText(profile)}/${sanitizeTerminalText(agent)}`).join(", ")}`,
		);
	}
	if (drops.droppedActive !== undefined) {
		parts.push(`active marker: ${sanitizeTerminalText(drops.droppedActive)}`);
	}
	if (parts.length > 0) {
		ctx.ui.notify(
			`Nub-IA dropped invalid entries while loading ${sanitizeTerminalText(path)} — ${parts.join("; ")}.`,
			"warning",
		);
	}
}

/** Pi's own live-session controls: the ExtensionAPI's setModel/setThinkingLevel. */
type LiveSession = Pick<ExtensionAPI, "setModel" | "setThinkingLevel" | "getThinkingLevel">;

/**
 * Switch the running session to the profile's orchestrator. `settings.json`
 * is the default for new sessions only; Pi's `setModel`/`setThinkingLevel`
 * are what move the live one. Failures never undo the persisted default: the
 * profile is applied for the next session either way, and the note says what
 * this session did. Nothing here may throw — settings.json is already written
 * and the apply must finish reporting.
 */
async function switchLiveOrchestrator(ctx: ExtensionContext, live: LiveSession, entry: AgentRoutingEntry): Promise<string> {
	const reference = parseOrchestratorModelRef(entry.model);
	if (reference === undefined) return "";
	const label = `${reference.provider}/${reference.model}`;
	const registry = ctx.modelRegistry;
	if (!registry) {
		if (ctx.hasUI && ctx.ui.notify) {
			ctx.ui.notify("Model registry unavailable; this session keeps its current model.", "warning");
		}
		return `\nModel registry unavailable; this session keeps its current model.`;
	}
	const model = registry.find(reference.provider, reference.model);
	if (model === undefined) return `\n${label} is not in the model catalog; this session keeps its current model.`;
	let switched = false;
	try {
		switched = await live.setModel(model);
	} catch (error) {
		return `\nThis session could not switch to ${label}: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}.`;
	}
	if (!switched) return `\nno authentication is configured for ${reference.provider}; this session keeps its current model.`;
	if (entry.thinking === undefined) return `\nThis session now runs on ${label}.`;
	try {
		live.setThinkingLevel(entry.thinking);
	} catch (error) {
		return `\nThis session now runs on ${label}, but its thinking level could not be set to ${entry.thinking}: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}.`;
	}
	return `\nThis session now runs on ${label} · ${entry.thinking}.`;
}

function profileSnapshotFrom(
	current: AgentModelConfig,
	settings: OrchestratorSettingsReadResult,
): AgentModelConfig {
	const snapshot = cloneModelConfig(current);
	if (settings.status === "valid" && settings.entry !== undefined) {
		snapshot[PROFILE_ORCHESTRATOR_KEY] = { ...settings.entry };
	}
	return snapshot;
}

/** Runs one finished panel action against the store and the live session, returning the file the reopened panel should show. */
async function runProfilesPanelAction(
	ctx: ExtensionContext,
	live: LiveSession,
	path: string,
	file: AgentProfilesFile,
	result: Exclude<ProfilesPanelResult, { type: "close" }>,
	report: ProfilesPanelReport = {},
): Promise<AgentProfilesFile> {
	switch (result.type) {
		case "apply": {
			if (!hasOwnProfile(file.profiles, result.name)) return file;
			// gentle-shell#1064 slice 1: Enter binds the selected profile to this
			// parent session. The binding is in-process state keyed by the session
			// id: it writes no store marker, no global routing, no materialized
			// stores, no agent frontmatter, no Pi settings, and no pin or declaration
			// layer, pin or not. This slice stores the binding only: launch routing
			// is unchanged until slice 2 (gentle-shell#1558) resolves the binding
			// at launch. Refreshing the binding means selecting again.
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) {
				ctx.ui.notify(
					`Nub-IA cannot bind profile "${result.name}" to this session: no parent session id is available here. Set it as the global default with a instead.`,
					"warning",
				);
				return file;
			}
			bindSessionProfile(sessionId, result.name, normalizeModelConfig(file.profiles[result.name]) ?? {});
			ctx.ui.notify(
				`Nub-IA bound profile "${result.name}" to this session — shown as "${result.name} (session)". The binding is stored for this session; launch routing is unchanged. Nothing was written: the global routing, pins, and materialized stores are untouched. Set as global default with a.`,
				"info",
			);
			return file;
		}
		case "apply-global": {
			if (!hasOwnProfile(file.profiles, result.name)) return file;
			// A pinned repository resolves its subagent routing from the profile at launch,
			// so a global apply would move global state this repository never reads. When a
			// pin wins, applying is repo-scoped: re-pin this clone and write no global
			// routing, no materialized stores, and no orchestrator. The committed
			// declaration is never rewritten behind a commit.
			const pinResolution = resolveProfilePin({ cwd: ctx.cwd, configHome: gentleAiConfigHome() });
			if (pinResolution) {
				const localPath = pinResolution.status.localPath;
				let pinNote: string;
				try {
					writeProfilePinSync(localPath, result.name);
					pinNote = `Nub-IA applied profile "${result.name}" repo-scoped: this clone now pins it in ${sanitizeTerminalText(localPath)}.\nSubagent launches here keep resolving the pin; no global routing or orchestrator was written.`;
				} catch (error) {
					ctx.ui.notify(
						`Nub-IA could not pin profile "${result.name}" in ${sanitizeTerminalText(localPath)}: ${profilesErrorMessage(error)}`,
						"warning",
					);
					return file;
				}
				if (pinResolution.source === "repo" && pinResolution.path !== localPath) {
					pinNote += `\nThis worktree's committed declaration ${sanitizeTerminalText(pinResolution.path)} still declares "${pinResolution.profile}"; the clone-local pin now takes precedence.`;
				}
				ctx.ui.notify(pinNote, "info");
				return file;
			}
			const normalized = normalizeModelConfig(file.profiles[result.name]) ?? {};
			const orchestratorEntry = readProfileOrchestrator(normalized);
			const hasAgentRoutes = Object.keys(normalized).some((name) => !isProfileOrchestratorKey(name));
			// Every global apply confirms before anything is written: applying replaces
			// the whole routing map in models.json and clears materialized routes the
			// profile omits, so the dialog must name the concrete diff. The current
			// routing is read from the same authority every other consumer uses; an
			// unreadable config is tolerated as empty, exactly like readModelConfigAsync.
			const savedRouting = await readModelRoutingAuthorityAsync(
				modelConfigReadPath(ctx.cwd),
				legacyProjectModelConfigPath(ctx.cwd),
			);
			// The apply pads omitted discoverable agents with clear entries, so the
			// diff must run against the effective current routing: the saved global
			// routing plus the materialized routes (frontmatter, subagents.json) of
			// agents the saved routing is silent about. models.json alone would hide
			// materialized-only routes the approval actually clears.
			const currentRouting = savedRouting.status === "valid"
				? await readGlobalEffectiveModelConfigFromAsync(ctx.cwd, savedRouting.config)
				: {};
			const agentNames = [
				...new Set([
					...Object.keys(currentRouting).filter((name) => !isProfileOrchestratorKey(name)),
					...Object.keys(normalized).filter((name) => !isProfileOrchestratorKey(name)),
				]),
			].sort();
			const replacedRoutes: string[] = [];
			const clearedRoutes: string[] = [];
			const addedRoutes: string[] = [];
			for (const name of agentNames) {
				const from = currentRouting[name];
				const to = normalized[name];
				if (to === undefined) {
					clearedRoutes.push(`${name}: ${formatOrchestratorSelection(from)} → inherit (cleared)`);
				} else if (from === undefined) {
					addedRoutes.push(`${name}: ${formatOrchestratorSelection(to)} (added)`);
				} else if (from.model !== to.model || from.thinking !== to.thinking) {
					replacedRoutes.push(`${name}: ${formatOrchestratorSelection(from)} → ${formatOrchestratorSelection(to)}`);
				}
			}
			if (!hasAgentRoutes) {
				// A genuinely empty profile and an orchestrator-only profile both wipe
				// every materialized agent route, but they read very differently to the
				// user: the orchestrator entry survives the apply and reconfigures the
				// orchestrator, so the dialog must not promise an entirely empty config.
				const [confirmTitle, confirmMessage] = orchestratorEntry !== undefined
					? [
						"Apply orchestrator-only profile?",
						`Profile "${result.name}" has an orchestrator entry but no agent routing entries. Applying it will replace global routing in ${sanitizeTerminalText(modelConfigPath(ctx.cwd))} with the orchestrator entry alone, clear every materialized agent route so every agent returns to inherit its default model, set the configured orchestrator entry in settings.json, and attempt to switch this session to that orchestrator model. Continue?`,
					]
					: [
						"Apply empty profile?",
						`Profile "${result.name}" has no routing entries. Applying it will replace global routing in ${sanitizeTerminalText(modelConfigPath(ctx.cwd))} with an empty configuration and return every agent to inherit its default model. Continue?`,
					];
				const approved = await ctx.ui.confirm(confirmTitle, confirmMessage);
				if (!approved) return file;
			} else {
				// A populated profile keeps the same abort semantics as the empty and
				// orchestrator-only dialogs: declining leaves every surface untouched.
				// When the routing authority is unreadable the diff above was computed
				// against an empty map, so the dialog must disclose the unreadable
				// routing and the replace/clear-to-inherit effect instead of presenting
				// existing routes as merely "(added)" (the #1349 wipe-bug class).
				// When the profile carries an orchestrator entry, approval also writes
				// settings.json and tries to move the live session, so both variants
				// must disclose those effects in the same words the orchestrator-only
				// dialog uses. An unconditional "will switch" is never claimed: the
				// registry/auth can refuse the live move.
				const orchestratorEffects = orchestratorEntry !== undefined
					? ", set the configured orchestrator entry in settings.json, and attempt to switch this session to that orchestrator model"
					: "";
				// A profile whose agent routes already match the effective current routing
				// and that moves no orchestrator changes nothing: re-selecting the active
				// profile or verifying state would otherwise train users to approve a
				// dialog without reading it, weakening the guard on the destructive cases
				// (issue #1683). Any routing change, any orchestrator change, or an
				// unreadable routing authority (the diff above cannot prove a no-op)
				// keeps the confirmation exactly as #1349/#1384 defined it.
				// `applyOrchestratorSettings` treats an entry without a model as "leave
				// settings.json alone", so such an entry is a no-op too, not a change.
				// The live session is a fourth surface: applying re-asserts the profile's
				// orchestrator on it, so a session already moved to another model or
				// thinking level mid-session is a real change the user must approve,
				// even when settings.json and the profile agree.
				const liveOrchestrator = (() => {
					if (ctx.model === undefined || typeof ctx.model.provider !== "string" || typeof ctx.model.id !== "string") return undefined;
					let thinking: unknown;
					try { thinking = live.getThinkingLevel(); } catch { return undefined; }
					return { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: isThinkingLevel(thinking) ? thinking : undefined };
				})();
				const orchestratorUnchanged = (orchestratorEntry === undefined || orchestratorEntry.model === undefined) || (() => {
					const current = readOrchestratorSettings(orchestratorSettingsPath());
					// An invalid stored defaultThinkingLevel is dropped from the entry but
					// applyOrchestratorSettings would delete the key, so the file would
					// change: a no-op cannot be proven and the dialog must stay.
					if (current.status === "valid" && "defaultThinkingLevel" in current.value && current.entry?.thinking === undefined) return false;
					return current.status === "valid" && current.entry !== undefined
						&& current.entry.model === orchestratorEntry.model
						&& current.entry.thinking === orchestratorEntry.thinking
						&& liveOrchestrator !== undefined
						&& liveOrchestrator.model === orchestratorEntry.model
						&& liveOrchestrator.thinking === orchestratorEntry.thinking;
				})();
				if (savedRouting.status === "valid" && replacedRoutes.length === 0 && clearedRoutes.length === 0 && addedRoutes.length === 0 && orchestratorUnchanged) {
					ctx.ui.notify(
						`Profile "${result.name}" already matches the current global routing${orchestratorEntry !== undefined ? " and orchestrator" : ""}; applying it changed nothing.`,
						"info",
					);
				} else {
					let confirmMessage: string;
					if (savedRouting.status !== "valid") {
						const modelsPath = sanitizeTerminalText(modelConfigPath(ctx.cwd));
						confirmMessage = `Profile "${result.name}" has agent routing entries, but the current global routing in ${modelsPath} could not be read, so existing routes are not listed. Applying it will replace global routing in ${modelsPath} with this profile's routes, so every existing agent route may be replaced or cleared back to inherit${orchestratorEffects}. Continue?`;
					} else {
						const changes = [...replacedRoutes, ...clearedRoutes, ...addedRoutes];
						const changeSummary = changes.length > 0
							? changes.join("; ")
							: "its agent routes already match the current global routing";
						confirmMessage = `Profile "${result.name}" has agent routing entries. Applying it will replace global routing in ${sanitizeTerminalText(modelConfigPath(ctx.cwd))} with this profile's routes: ${changeSummary}${orchestratorEffects}. Continue?`;
					}
					const approved = await ctx.ui.confirm(`Apply profile "${result.name}"?`, confirmMessage);
					if (!approved) return file;
				}
			}
			// Applying spans three files — the store, models.json, and Pi's global
			// settings.json — and there is no cross-file rename, so order the writes to
			// keep the store truthful and compensate on failure: claim the profile in
			// the store first, then materialise routing, then the orchestrator. A claim
			// that fails leaves routing untouched; anything that fails after the claim
			// restores the previous claim and, when the previously active profile is
			// known, the routing that profile implies.
			const claimed = setActiveProfile(file, result.name);
			try {
				writeProfilesFileSync(path, claimed);
			} catch (error) {
				ctx.ui.notify(
					`Nub-IA could not update ${sanitizeTerminalText(path)}: ${profilesErrorMessage(error)}`,
					"warning",
				);
				return file;
			}
			const previousActiveConfig =
				file.active !== undefined && hasOwnProfile(file.profiles, file.active)
					? normalizeModelConfig(file.profiles[file.active]) ?? {}
					: undefined;
			// Set only when the orchestrator write succeeded, so the revert knows it has
			// something to undo. A rollback closure (not a previous-bytes value) is used
			// because "the file did not exist before" is a real state that must restore
			// by removing the file, and `undefined` bytes cannot carry that distinction.
			let orchestratorRollback: (() => void) | undefined;
			const revertClaim = async (routingWritten: boolean): Promise<AgentProfilesFile> => {
				let restored = previousActiveConfig === undefined ? "" : "routing";
				if (routingWritten && previousActiveConfig !== undefined) {
					try {
						await writeModelConfigAsync(ctx.cwd, previousActiveConfig);
						// Materialize the previous profile again with the same
						// replacement semantics, so the failed profile's routes do not
						// linger in subagents.json or the agent frontmatter.
						await applyModelConfigAsync(
							ctx.cwd,
							await withOmittedAgentsClearedAsync(ctx.cwd, previousActiveConfig),
						);
					} catch {
						restored = "";
					}
				}
				if (orchestratorRollback) {
					try {
						orchestratorRollback();
						restored = restored === "" ? "settings" : `${restored} and settings`;
					} catch {
						restored = restored === "" ? "" : restored;
					}
				}
				try {
					writeProfilesFileSync(path, file);
					restored = restored === "" ? "active marker" : `${restored} and active marker`;
				} catch {
					restored = restored === "" ? "nothing" : restored;
				}
				const unresolved =
					routingWritten && previousActiveConfig === undefined
						? ` ${sanitizeTerminalText(modelConfigPath(ctx.cwd))} still holds this profile's routing because no previously active profile was recorded to restore.`
						: "";
				ctx.ui.notify(
					`Nub-IA could not apply profile "${result.name}". Restored: ${restored}.${unresolved}`,
					"warning",
				);
				return file;
			};
			try {
				await writeModelConfigAsync(ctx.cwd, normalized);
			} catch (error) {
				ctx.ui.notify(
					`Nub-IA could not write ${sanitizeTerminalText(modelConfigPath(ctx.cwd))}: ${profilesErrorMessage(error)}`,
					"warning",
				);
				return revertClaim(false);
			}
			// models.json holds the profile as written; the padding with clear
			// entries only drives materialization, so agents the profile omits
			// return to inherit instead of keeping a previously materialized route.
			let applyResult: { updated: number; skipped: number };
			try {
				applyResult = await applyModelConfigAsync(
					ctx.cwd,
					await withOmittedAgentsClearedAsync(ctx.cwd, normalized),
				);
			} catch (error) {
				ctx.ui.notify(
					`Nub-IA could not materialize profile "${result.name}": ${profilesErrorMessage(error)}`,
					"warning",
				);
				return revertClaim(true);
			}
			let orchestratorNote = "";
			if (orchestratorEntry !== undefined) {
				const settingsPath = orchestratorSettingsPath();
				const written = applyOrchestratorSettings(settingsPath, orchestratorEntry);
				if (written.status === "invalid") {
					ctx.ui.notify(
						`Nub-IA could not set the orchestrator from profile "${result.name}": ${sanitizeTerminalText(written.reason)}. ${sanitizeTerminalText(settingsPath)} was left unchanged.`,
						"warning",
					);
					return revertClaim(true);
				}
				if (written.status === "written") {
					const previous = written.previous;
					orchestratorRollback = () => restoreOrchestratorSettings(settingsPath, previous);
					orchestratorNote = `\nOrchestrator set to ${formatOrchestratorSelection(orchestratorEntry)} in ${sanitizeTerminalText(settingsPath)}.`;
				}
				// settings.json only governs future sessions. The session the user is
				// sitting in keeps its model until told otherwise, which made a profile
				// look applied while the orchestrator kept answering with the old one.
				orchestratorNote += await switchLiveOrchestrator(ctx, live, orchestratorEntry);
			}
			// A pin that does not resolve changes nothing at launch, so the global apply
			// above is what governs this repository. Saying so keeps a broken pin from
			// looking like the reason a launch ignored the profile just applied.
			const pinEvaluation = evaluateProfilePin(readProfilePinStatus(ctx.cwd), file.profiles);
			let pinNote = "";
			if (pinEvaluation.stale.length > 0 || pinEvaluation.invalid.length > 0) {
				pinNote = "\nThis repository also has a pin layer that does not resolve; the global routing above governs its subagents until the pin is fixed.";
			}
			ctx.ui.notify(
				[
					`Nub-IA applied profile "${result.name}" — ${applyResult.updated} agent${applyResult.updated === 1 ? "" : "s"} updated.`,
					"New routing takes effect on the next subagent launch.",
				].join("\n") + orchestratorNote + pinNote,
				"info",
			);
			return claimed;
		}
		case "create": {
			const answer = await ctx.ui.input("New profile name", "e.g. deep-work");
			if (answer === undefined) {
				report.status = "Create cancelled.";
				return file;
			}
			const name = answer.trim();
			if (name === "") {
				report.status = "No profile created: no name entered.";
				return file;
			}
			try {
				const next = createProfile(file, name, {});
				writeProfilesFileSync(path, next);
				report.status = `Profile "${name}" created.`;
				report.selectedName = name;
				return next;
			} catch (error) {
				report.status = `Profile not created: ${profilesErrorMessage(error)}`;
				ctx.ui.notify(report.status, "warning");
				return file;
			}
		}
		case "update": {
			// A profile is a complete snapshot, so capturing the current routing also
			// captures the orchestrator the routing is running under. A settings file
			// that cannot be read leaves the snapshot without an orchestrator entry
			// rather than inventing one.
			const snapshot = profileSnapshotFrom(
				await readEffectiveModelConfigAsync(ctx.cwd),
				readOrchestratorSettings(orchestratorSettingsPath()),
			);
			try {
				const next = updateProfile(file, result.name, snapshot);
				writeProfilesFileSync(path, next);
				ctx.ui.notify(
					`Nub-IA updated profile "${result.name}" from the current routing in ${modelConfigPath(ctx.cwd)}.`,
					"info",
				);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not updated: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "duplicate": {
			// The Pi host starts the field empty and ignores the placeholder, so the title
			// names the suggestion and Enter on an untouched field accepts it.
			const suggested = `${result.name}-copy`;
			const answer = await ctx.ui.input(`Duplicate profile "${result.name}" as (empty = ${suggested})`, suggested);
			if (answer === undefined) {
				report.status = "Duplicate cancelled.";
				return file;
			}
			const name = answer.trim() || suggested;
			try {
				const next = duplicateProfile(file, result.name, name);
				writeProfilesFileSync(path, next);
				report.status = `Profile "${result.name}" duplicated as "${name}".`;
				report.selectedName = name;
				return next;
			} catch (error) {
				report.status = `Profile not duplicated: ${profilesErrorMessage(error)}`;
				ctx.ui.notify(report.status, "warning");
				return file;
			}
		}
		case "rename": {
			const answer = await ctx.ui.input(`Rename profile "${result.name}" to (empty = keep ${result.name})`, result.name);
			if (answer === undefined) {
				report.status = "Rename cancelled.";
				return file;
			}
			const name = answer.trim();
			if (name === "") {
				report.status = `Profile "${result.name}" unchanged: no new name entered.`;
				return file;
			}
			try {
				const next = renameProfile(file, result.name, name);
				writeProfilesFileSync(path, next);
				// A pin stores a name, so a rename that did not follow it would leave every
				// pinned repository with a name the store no longer defines, which silently
				// returns those repositories to the global routing.
				const follow = followRenamedPin(ctx.cwd, result.name, name);
				ctx.ui.notify(
					`Nub-IA renamed profile "${result.name}" to "${name}".` +
						(follow.followed.length > 0 ? `\nUpdated the clone pin: ${follow.followed.map((entry) => sanitizeTerminalText(entry)).join(", ")}.` : "") +
						(follow.stillDeclared.length > 0 ? `\nThe committed repository declaration ${follow.stillDeclared.map((entry) => sanitizeTerminalText(entry)).join(", ")} still names "${result.name}"; press P on "${name}" to republish it.` : ""),
					"info",
				);
				report.status = `Profile "${result.name}" renamed to "${name}".`;
				report.selectedName = name;
				return next;
			} catch (error) {
				report.status = `Profile not renamed: ${profilesErrorMessage(error)}`;
				ctx.ui.notify(report.status, "warning");
				return file;
			}
		}
		case "delete": {
			// A pinned profile is live state for this repository, so deleting it is
			// refused the same way deleting the active profile is: the pin must be cleared
			// deliberately instead of leaving a name that resolves to nothing. Either
			// layer refuses, not just the winning one, because a non-winning layer still
			// names a live profile for this repository.
			const deletePinStatus = readProfilePinStatus(ctx.cwd);
			const namedLayers: string[] = [];
			if (deletePinStatus) {
				for (const layer of [
					{ scope: "local", read: deletePinStatus.local, path: deletePinStatus.localPath },
					{ scope: "repo", read: deletePinStatus.repo, path: deletePinStatus.repoPath },
				]) {
					if (layer.read.status === "valid" && layer.read.profile === result.name) {
						namedLayers.push(`${layer.scope} pin at ${sanitizeTerminalText(layer.path)}`);
					}
				}
			}
			if (namedLayers.length > 0) {
				ctx.ui.notify(
					`Profile "${result.name}" is pinned for this repository (${namedLayers.join(" and ")}). Remove the pin first with /nubia:profiles (p removes the clone pin, P removes the declaration), then delete it.`,
					"warning",
				);
				return file;
			}
			const approved = await ctx.ui.confirm(
				"Delete profile?",
				`Delete profile "${result.name}" from ${path}? The routing in ${modelConfigPath(ctx.cwd)} is not changed.`,
			);
			if (!approved) return file;
			try {
				const next = deleteProfile(file, result.name);
				writeProfilesFileSync(path, next);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not deleted: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "pin": {
			if (!hasOwnProfile(file.profiles, result.name)) return file;
			// The pin layer is chosen by the key, not by the file that happens to exist:
			// `p` sets the local pin in the clone's Git common directory, `P` sets the
			// committable per-worktree declaration. Both toggle: the same key on the
			// profile a layer already names removes that layer, so a repository can be
			// released without editing files by hand. Neither writes routing, so a
			// failure here has nothing to roll back.
			const status = readProfilePinStatus(ctx.cwd);
			if (!status) {
				ctx.ui.notify(
					"Nub-IA cannot pin a profile because this session is not inside a Git worktree. Pinning is per repository; apply the profile globally instead.",
					"warning",
				);
				return file;
			}
			const pinPath = result.source === "local" ? status.localPath : status.repoPath;
			const current = result.source === "local" ? status.local : status.repo;
			const currentlyPinned = current.status === "valid" && current.profile === result.name;
			const scope = result.source === "local" ? "clone" : "worktree";
			try {
				if (currentlyPinned) clearProfilePinSync(pinPath);
				else writeProfilePinSync(pinPath, result.name);
			} catch (error) {
				ctx.ui.notify(
					`Nub-IA could not update profile pin ${sanitizeTerminalText(pinPath)}: ${profilesErrorMessage(error)}`,
					"warning",
				);
				return file;
			}
			if (currentlyPinned) {
				ctx.ui.notify(
					[
						`Nub-IA removed the ${result.source} pin for this ${scope} from ${sanitizeTerminalText(pinPath)}.`,
						result.source === "local"
							? "This clone falls back to the repository declaration, then to the global routing."
							: "This worktree falls back to the global routing; a local pin in the clone still outranks it.",
					].join("\n"),
					"info",
				);
				return file;
			}
			// The sharing line is only worth a Git call when the declaration was just
			// written, and it must never turn a successful pin into a failure.
			const sharingNote = result.source === "repo" ? `\n${repoDeclarationSharing(status.root, pinPath)}` : "";
			ctx.ui.notify(
				result.source === "local"
					? [
						`Nub-IA pinned profile "${result.name}" for this clone in ${sanitizeTerminalText(pinPath)}.`,
						"Subagent launches in this repository resolve that profile at launch; the orchestrator and every other repository keep their global routing. Press p again to unpin.",
					].join("\n")
					: [
						`Nub-IA declared profile "${result.name}" for this worktree in ${sanitizeTerminalText(pinPath)}.`,
						"Subagent launches resolve it at launch. Commit the file to share the routing; a local pin takes precedence over it. Press P again to remove the declaration.",
					].join("\n") + sharingNote,
				"info",
			);
			return file;
		}
		case "export": {
			if (!hasOwnProfile(file.profiles, result.name)) return file;
			const exportPath = profileExportPath(gentleAiConfigHome());
			try {
				const text = serializeProfileExport(result.name, file.profiles[result.name]);
				await mkdir(dirname(exportPath), { recursive: true });
				await writeFile(exportPath, text);
				ctx.ui.notify(`Nub-IA exported profile "${result.name}" to ${exportPath}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Profile export failed: ${profilesErrorMessage(error)}`, "warning");
			}
			return file;
		}
		case "import": {
			let importPath = profileExportReadPath(gentleAiConfigHome());
			// A packaged preset (assets/profiles/*.json) can be imported by name instead of the export file.
			const presets = listPackagedProfilePresets();
			if (presets.length > 0 && typeof ctx.ui.select === "function") {
				const exportChoice = "Exported file (profiles.export.json)";
				const choice = await ctx.ui.select("Import profile", [exportChoice, ...presets.map((preset) => `Preset: ${preset}`)]);
				if (choice === undefined) return file;
				if (choice !== exportChoice) importPath = join(ASSETS_DIR, "profiles", `${choice.slice("Preset: ".length)}.json`);
			}
			let text: string;
			try {
				text = await readFile(importPath, "utf8");
			} catch {
				ctx.ui.notify(`Profile import failed: ${importPath} is missing or unreadable.`, "warning");
				return file;
			}
			const parsed = parseProfileExportTextWithDrops(text);
			if (!parsed) {
				ctx.ui.notify(
					`Profile import failed: ${importPath} is not a valid agent-model profile export.`,
					"warning",
				);
				return file;
			}
			if (parsed.droppedAgents.length > 0) {
				ctx.ui.notify(
					`Nub-IA dropped invalid routing entries while importing profile "${parsed.name}": ${parsed.droppedAgents.join(", ")}.`,
					"warning",
				);
			}
			if (hasOwnProfile(file.profiles, parsed.name)) {
				const approved = await ctx.ui.confirm(
					"Replace existing profile?",
					`Profile "${parsed.name}" already exists in ${path}. Replace its routing with the import?`,
				);
				if (!approved) return file;
			}
			try {
				const next = hasOwnProfile(file.profiles, parsed.name)
					? updateProfile(file, parsed.name, parsed.config)
					: createProfile(file, parsed.name, parsed.config);
				writeProfilesFileSync(path, next);
				const entries = Object.keys(parsed.config).length;
				ctx.ui.notify(
					`Nub-IA imported profile "${parsed.name}" (${entries} routing ${entries === 1 ? "entry" : "entries"}) from ${importPath}.`,
					"info",
				);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile import failed: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
	}
}

/** `/nubia:profiles`: seed or open the store, then loop the panel over one action at a time until it closes. */
async function handleProfilesCommand(ctx: ExtensionContext, live: LiveSession): Promise<void> {
	const path = profilesFilePath(gentleAiConfigHome());
	const read = readProfilesFileResult(profilesReadFilePath(gentleAiConfigHome()));
	if (read.status === "invalid") {
		ctx.ui.notify(
			`Nub-IA cannot open agent profiles because ${path} is invalid JSON or not a profiles file. Fix or remove the file, then run /nubia:profiles again.`,
			"warning",
		);
		return;
	}
	let file: AgentProfilesFile;
	if (read.status === "missing") {
		file = bootstrapProfilesFile(await readEffectiveModelConfigAsync(ctx.cwd));
		try {
			writeProfilesFileSync(path, file);
		} catch (error) {
			ctx.ui.notify(
				`Nub-IA could not create ${path}: ${profilesErrorMessage(error)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(`Nub-IA seeded the "current" profile in ${path} from the routing currently in effect.`, "info");
	} else {
		file = read.file;
		reportProfilesDrops(ctx, path, read.drops);
	}
	const saveSnapshot: ProfilesSnapshotHandler = (name) => {
		const next = updateProfile(
			file,
			name,
			profileSnapshotFrom(
				// The snapshot captures the same routing the panel shows as current,
				// so a session binding outranks the shared layers here too.
				readSessionProfileBinding(ctx.sessionManager?.getSessionId?.())?.modelProfiles
					?? readEffectiveModelConfig(ctx.cwd),
				readOrchestratorSettings(orchestratorSettingsPath()),
			),
		);
		writeProfilesFileSync(path, next);
		file = next;
		return next;
	};
	let selectedName: string | undefined;
	const sessionBoundName = () => readSessionProfileBinding(ctx.sessionManager?.getSessionId?.())?.name;
	// The panel's "Current routing (effective)" table shows what this session's
	// launches resolve right now, and a session binding outranks every shared
	// layer, so a bound session reads its snapshot as the current routing while an
	// unbound session keeps reading the effective config exactly as before.
	const currentRoutingForPanel = async () =>
		readSessionProfileBinding(ctx.sessionManager?.getSessionId?.())?.modelProfiles
		?? await readEffectiveModelConfigAsync(ctx.cwd);
	let result = await showProfilesPanel(
		ctx,
		file,
		await currentRoutingForPanel(),
		selectedName,
		saveSnapshot,
		undefined,
		sessionBoundName(),
	);
	while (result.type !== "close") {
		const report: ProfilesPanelReport = {};
		file = await runProfilesPanelAction(ctx, live, path, file, result, report);
		selectedName = report.selectedName ?? ("name" in result ? result.name : undefined);
		result = await showProfilesPanel(
			ctx,
			file,
			await currentRoutingForPanel(),
			selectedName,
			saveSnapshot,
			report.status,
			sessionBoundName(),
		);
	}
}

async function handlePersonaCommand(ctx: ExtensionContext): Promise<void> {
	const current = readPersonaMode(ctx.cwd);
	const selected = await ctx.ui.select(
		`Nub-IA persona (current: ${current})`,
		[...PERSONA_OPTIONS],
	);
	if (selected !== "gentleman" && selected !== "neutral") return;
	const writtenPaths = writePersonaMode(ctx.cwd, selected);
	ctx.ui.notify(
		[
			`Nub-IA persona set to: ${selected}`,
			`Global config: ${personaConfigPath(ctx.cwd)}`,
			...(writtenPaths.length > 1
				? [`Project override updated: ${projectPersonaConfigPath(ctx.cwd)}`]
				: []),
			"Run /reload or start a new Pi session for already-injected prompts to refresh.",
		].join("\n"),
		"info",
	);
}

export const __testing = {
	runProfilesPanelAction,
	readEffectiveModelConfig,
	readEffectiveModelConfigAsync,
	followRenamedPin,
	profilePinScopeNote,
	listAgentsFromDir,
	listAgentsFromDirAsync,
	listDiscoverableAgents,
	orderDiscoverableAgents,
	classifyGuardedCommand,
	evaluateGuardedCommand,
	guardedCommandPreview,
	guardedCommandTitle,
	loadRuntimeGuardrailsConfig,
	isOrdinaryYoloPush,
	yoloPushConfiguredRestriction,
	buildGentlePrompt,
	renderSddModelPanel: renderSddModelPanelForTesting,
	getOrchestratorPrompt,
	renderOrchestratorPrompt,
	loadBackgroundSubagentsPolicy,
	resolveBackgroundSubagentsPolicy,
	renderBackgroundSubagentsReport,
	writeGlobalBackgroundSubagentsPolicy,
	parseBackgroundSubagentsPolicyFile,
	resolveBackgroundSubagentsCapability,
	readActiveToolNames,
	renderBackgroundSubagentsStatusLine,
	createGentleAiExtension: createGentleAiExtensionForTesting,
	getPiModelOptions,
	MODEL_CONTROL_OPTIONS,
	switchLiveOrchestrator,
};

export interface GentleAiRuntimeDependencies {
	// The environment the session's child processes inherit; tests inject a
	// plain object so the child/guard checks are observable without touching
	// the test runner's own process.env.
	processEnv?: NodeJS.ProcessEnv;
}

export function createGentleAiExtension(dependencies: GentleAiRuntimeDependencies = {}): (pi: ExtensionAPI) => void {
	return createGentleAiExtensionForTesting(dependencies);
}

const processAgentEndSubagentDepth = new Map<string | symbol, number>();

function subagentDepthSessionKey(context: ExtensionContext | undefined, fallbackKey: symbol): string | symbol {
	try {
		const sessionManager = (context as unknown as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		if (typeof sessionId === "string") return sessionId;
	} catch { /* Minimal or test contexts use the registration-local fallback. */ }
	return fallbackKey;
}

function createGentleAiExtensionForTesting(
	dependencies: GentleAiRuntimeDependencies = {},
): (pi: ExtensionAPI) => void {
	return function gentleAi(pi: ExtensionAPI): void {
	const subagentDepthFallbackKey = Symbol("subagent-depth-fallback");
	const herdrLifecycle = createHerdrConfirmationLifecycle(pi.events);
	const permissionEnvironment = dependencies.processEnv ?? process.env;
	const yolo = registerYoloSessionPolicy(pi, permissionEnvironment);

	pi.on("session_shutdown", (_event, context) => {
		yolo.reset(context);
		processAgentEndSubagentDepth.delete(subagentDepthSessionKey(context, subagentDepthFallbackKey));
	});

	// gentle-pi ODD input phase labels: the explicit half of the bounded ODD
	// phase signal for the Gentle prompt's working label. Gentle Shell infers
	// the phase from the primary session's tool activity
	// (lib/odd-phase-inference.ts); this tool lets the orchestrator refine it
	// at ODD protocol transitions tools cannot show, and its report is
	// "explicit" so a following read-only tool call never downgrades it. Never
	// inferred from prose. It is session-scoped in lib/odd-phase.ts: a
	// background/child agent runs as its own OS process with its own module
	// state, so it can never see or override the primary session's phase.
	const hiddenOddPhaseToolComponent = { render: (_width: number): string[] => [], invalidate() {} };
	pi.registerTool({
		name: "gentle_odd_phase",
		renderShell: "self",
		label: "Gentle ODD Phase",
		description: "Refine the primary session's current ODD phase for the Gentle prompt's working label, which is otherwise inferred automatically from tool activity. Best-effort UI only; never a source of truth for orchestration logic.",
		promptSnippet: "Refine the automatically inferred working label with authorizing/exploring/researching/deciding/planning/implementing/checking/closing only at real ODD phase transitions of the primary turn; never poll or report per tool call.",
		promptGuidelines: [
			`phase must be exactly one of ${ODD_PHASES.join(", ")}, or "clear" to leave the current phase before its turn ends. Call this only when the ODD phase actually changes for the primary session's active turn, not on every tool call or thought.`,
			"Never call this from a subagent or background/child task; it reports only the primary orchestrator's own phase, and a child's session id can never override the parent's label.",
		],
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["phase"],
			properties: {
				phase: { type: "string", enum: [...ODD_PHASES, "clear"], description: "The reported ODD phase, or 'clear' to leave the current phase." },
			},
		} as const,
		executionMode: "parallel",
		// The prompt editor owns the success indicator. An empty self-rendered
		// call avoids Pi's default transcript card while preserving error output.
		renderCall() {
			return hiddenOddPhaseToolComponent;
		},
		renderResult(result, _options, theme, context) {
			if (!context.isError) return hiddenOddPhaseToolComponent;
			const message = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			return new Text(theme.fg("error", sanitizeTerminalText(message || "ODD phase report failed.")), 0, 0);
		},
		async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
			const phase = (parameters as { phase?: unknown }).phase;
			const sessionId = ctx.sessionManager.getSessionId();
			// Pi's own contract (docs/extensions.md, Signaling errors): throw to
			// mark a tool execution as failed (sets isError: true on the result);
			// returning a value -- including an isError property on it -- never
			// sets that flag.
			if (!sessionId) throw new Error("No active session to report an ODD phase for; nothing changed.");
			// An invalid token never resets state: only the explicit "clear" token
			// leaves the current phase. This keeps a malformed report from wiping
			// out an otherwise-accurate label for the rest of the turn.
			if (phase === "clear") {
				oddPhaseRegistry.clear(sessionId);
				return { content: [{ type: "text", text: "ODD phase cleared." }], details: { phase: undefined } };
			}
			if (!isOddPhase(phase)) {
				throw new Error(`Invalid ODD phase; use one of ${ODD_PHASES.join(", ")}, or "clear". The previously reported phase, if any, is unchanged.`);
			}
			const reported = oddPhaseRegistry.report(sessionId, phase, "explicit");
			return { content: [{ type: "text", text: `ODD phase reported: ${reported}` }], details: { phase: reported } };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		yolo.reset(ctx);
		// Route the one-time "legacy config read" hint through the UI instead of raw stderr.
		if (ctx.hasUI) setLegacyHintNotifier((message) => { try { ctx.ui.notify(message, "info"); } catch { /* stale context */ } });
		// A delegated child runs in the parent's resolved worktree. Asset
		// install and model config belong to the parent session and write
		// shared state, so only the parent performs them.
		if (readEnv(permissionEnvironment, "NUB_IA_AGENTS_CHILD", "GENTLE_PI_AGENTS_CHILD") !== "1") await startParentSession(ctx);
	});

	const startParentSession = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const installResult = installPackageAssets(ctx.cwd, true, ["delegation", "review"]);
			migrateLegacyProjectModelOverrides(ctx.cwd);
			const modelResult = await applySavedModelConfig(ctx);
			if (ctx.hasUI && modelResult.invalidPath) {
				ctx.ui.notify(
					`Nub-IA skipped model config because ${modelResult.invalidPath} is invalid JSON or not an object. Fix or remove the file, then run /nubia:models again.`,
					"warning",
				);
				return;
			}
			// Routine startup housekeeping (model routing applied, managed assets
			// refreshed) is silent: the counts are visible in /nubia:models and
			// /nubia:doctor. Only a failure is surfaced.
			void installResult;
		} catch (error) {
			if (ctx.hasUI) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Nub-IA model config sweep failed: ${message}`,
					"warning",
				);
			}
		}
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const isNamedAgent = isNamedAgentStartEvent(event);
		const isChildSession = readEnv(permissionEnvironment, "NUB_IA_AGENTS_CHILD", "GENTLE_PI_AGENTS_CHILD") === "1";
		const isPrimarySession = !isNamedAgent && !isChildSession;
		const subagentDepthKey = subagentDepthSessionKey(ctx, subagentDepthFallbackKey);
		if (isNamedAgent || isChildSession) {
			processAgentEndSubagentDepth.set(subagentDepthKey, (processAgentEndSubagentDepth.get(subagentDepthKey) ?? 0) + 1);
		} else {
			processAgentEndSubagentDepth.set(subagentDepthKey, 0);
		}
		const gentlePrompt = !isPrimarySession
			? ""
			: `\n\n${buildGentlePrompt(
					readPersonaMode(ctx.cwd),
					ctx.cwd,
					readActiveToolNames(pi),
					ctx.mode,
				)}`;
		// pi-claude-bridge drops a handler-returned systemPrompt and forwards
		// only systemPromptOptions, so the harness is delivered through the
		// mutable appendSystemPrompt section instead of a replacement.
		appendSystemPromptOnce(event.systemPromptOptions, gentlePrompt);
		updateYoloPrompt(event.systemPromptOptions, isPrimarySession && await yolo.active(ctx));
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const primaryToolCall = (processAgentEndSubagentDepth.get(subagentDepthSessionKey(ctx, subagentDepthFallbackKey)) ?? 0) === 0;
		const yoloActive = primaryToolCall && await yolo.active(ctx);
		const sensitivePathDenied = evaluateSensitivePathTool(
			event.toolName,
			event.input,
		);
		if (sensitivePathDenied) return sensitivePathDenied;
		if (event.toolName === "subagent_run") {
			const judgmentDayFixDenied = rejectInvalidJudgmentDayFixDispatch(event.input);
			if (judgmentDayFixDenied) return judgmentDayFixDenied;
			const writerScopeDenied = rejectUnscopedBoundedWriterDispatch(event.input);
			if (writerScopeDenied) return writerScopeDenied;
			return undefined;
		}
		if (event.toolName !== "bash") return undefined;
		if (!isRecord(event.input) || typeof event.input.command !== "string") {
			return undefined;
		}
		if (readEnv(permissionEnvironment, "NUB_IA_AGENTS_CHILD", "GENTLE_PI_AGENTS_CHILD") === "1") {
			const childDenied = blockChildDestructiveCommand(event.input.command);
			if (childDenied) return childDenied;
		}
		return await confirmCommand(event.input.command, ctx, pi.events, herdrLifecycle, yoloActive);
	});

	for (const owner of ["delegation", "review"] as const) {
		const label = owner;
		pi.registerCommand(`nubia:install-${owner}`, {
			description: `Repair or refresh only the global Nub-IA ${label} assets.`,
			handler: async (args, ctx) => {
				const force = args.includes("--force");
				const result = installPackageAssets(ctx.cwd, force, [owner]);
				ctx.ui.notify(
					`Global Nub-IA ${label} assets installed: ${result.agents} agent(s), ${result.chains} chain(s), ${result.support} support file(s), ${result.skipped} already present.`,
					"info",
				);
			},
		});
	}

	pi.registerCommand("nubia:models", {
		description: "Configure global per-agent models for Nub-IA agents.",
		handler: async (_args, ctx) => {
			await handleModelsCommand(ctx, pi);
		},
	});

	pi.registerCommand("nubia:profiles", {
		description: "Create, switch, and manage global agent-model profiles for Nub-IA agents.",
		handler: async (_args, ctx) => {
			await handleProfilesCommand(ctx, pi);
		},
	});

	pi.registerCommand("nubia:persona", {
		description: "Switch Nub-IA persona between gentleman and neutral.",
		handler: async (_args, ctx) => {
			await handlePersonaCommand(ctx);
		},
	});

	pi.registerCommand("nubia:doctor", {
		description: "Run read-only Nub-IA diagnostics for this Pi workspace.",
		handler: async (_args, ctx) => {
			const assetLines = packageAssetDiagnosticLines(ctx.cwd);
			const skillRegistryPresent = existsSync(
				join(ctx.cwd, ".atl", "skill-registry.md"),
			);
			const modelConfig = await readSavedModelConfigAsync(ctx.cwd);
			const engramActive = hasWritableEngramTool(pi);
			const lines = [
				"Nub-IA doctor",
				...assetLines,
				"pass: Organic Driven Development (ODD): active",
				`${skillRegistryPresent ? "pass" : "warn"}: Skill registry ${skillRegistryPresent ? "present" : "missing"}`,
				`${modelConfig.status === "invalid" ? "fail" : "pass"}: Global model config ${modelConfig.status}`,
				"pass: Sensitive-path guard active for read/write/edit tools",
				`${engramActive ? "pass" : "warn"}: Engram memory tools ${engramActive ? "active" : "not active in this session"}`,
			];
			if (modelConfig.status === "invalid") {
				lines.push(`remedy: fix or remove ${modelConfig.path}`);
			}
			ctx.ui.notify(
				lines.join("\n"),
				lines.some((line) => line.startsWith("fail:")) || assetLines.some((line) => line.startsWith("warn:")) ? "warning" : "info",
			);
		},
	});

	// A user-owned switch, never an automated one.
	// It matters more here than there, because this policy governs whether
	// background subagents may be launched at all, so nothing in Pi may write
	// it. The only writer is this handler, reached only by explicit invocation.
	pi.registerCommand("nubia:background-subagents", {
		description: "Show or set the managed background-subagents policy; no argument opens a selectable menu (status|enable|disable). Every sub-action is user-initiated only; Pi automation never toggles it.",
		// No argument opens a selectable menu when an interactive UI is present;
		// headless callers and fakes without ui.select keep the status fallback.
		handler: async (args, ctx) => {
			let subAction = args.trim().length === 0 ? "status" : args.trim();
			if (args.trim().length === 0 && ctx.hasUI && typeof ctx.ui.select === "function") {
				const selected = await ctx.ui.select("Background subagents policy", ["status", "enable", "disable"]);
				if (selected === undefined) return;
				subAction = selected;
			}
			if (subAction !== "status" && subAction !== "enable" && subAction !== "disable") {
				ctx.ui.notify(`Unknown /nubia:background-subagents sub-action "${subAction}". Use status, enable, or disable.`, "warning");
				return;
			}
			try {
				const wrote: BackgroundSubagentsPolicy | undefined = subAction === "enable" ? "on" : subAction === "disable" ? "off" : undefined;
				if (wrote !== undefined) writeGlobalBackgroundSubagentsPolicy(wrote);
				const resolution = resolveBackgroundSubagentsPolicy(ctx.cwd);
				const capability = resolveBackgroundSubagentsCapability(ctx.cwd, readActiveToolNames(pi));
				const report = renderBackgroundSubagentsReport(resolution, capability, wrote);
				ctx.ui.notify(report.message, report.type);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("nubia:status", {
		description: "Show Nub-IA package status for this project.",
		handler: async (_args, ctx) => {
			const assetLines = packageAssetDiagnosticLines(ctx.cwd);
			const savedConfig = await readModelRoutingAuthorityAsync(
				modelConfigReadPath(ctx.cwd),
				legacyProjectModelConfigPath(ctx.cwd),
			);
			ctx.ui.notify(
				[
					"Nub-IA package is active.",
					`Persona: ${readPersonaMode(ctx.cwd)}`,
					...assetLines,
					"Organic Driven Development (ODD): active",
					`Global model config: ${existsSync(modelConfigReadPath(ctx.cwd)) ? "present" : "missing"}`,
					`Saved model routing: ${savedConfig.status}${savedConfig.status === "invalid" ? ` (${savedConfig.path})` : ""}`,
					...(savedConfig.status === "invalid" ? [] : describeModelConfig(ctx.cwd, savedConfig.status === "valid" ? savedConfig.config : {})),
				].join("\n"),
				savedConfig.status === "invalid" || assetLines.some((line) => line.startsWith("warn:")) ? "warning" : "info",
			);
		},
	});
	};
}

export default function gentleAi(pi: ExtensionAPI): void {
	return createGentleAiExtension()(pi);
}
