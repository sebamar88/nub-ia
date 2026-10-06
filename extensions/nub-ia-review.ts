// Nub-IA review: in-process 4R code review and a push gate, replacing the
// gentle-ai native review (RDD) binary with a Pi-only extension.
//
// `nub_review` (tool) and `/nub:review` (command) take the current diff
// (staged, working tree, or base..HEAD), hand it to the four packaged lens
// agents in parallel (assets/agents/review-*.md; their `model:` is a nub-ia
// tier, so every teammate's provider works), consolidate the JSON findings
// into one markdown report under .pi/nub-ia/reviews/, and remember the
// verdict for the diff hash. Before a `git push`, the gate asks for
// confirmation when the changes being pushed were never reviewed, were
// reviewed in a different shape, or were reviewed and blocked. The gate is a
// confirmation, never a hard block: delivery stays the user's call.
//
// Pure logic (diff collection, parsing, consolidation, gate decision) lives in
// lib/nub-review.ts; this file wires it to Pi.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDefinition, discoverAgents, loadAgentsConfig, resolveAgentProfile } from "../lib/agents-config.ts";
import { resolveAgentHomeDirectory } from "../lib/agent-model-resolution.ts";
import { type CatalogModel, decideRoute, isModelTier, isProviderFailure } from "../lib/model-tier-router.ts";
import { loadTierCatalog } from "./nub-ia-router.ts";
import {
	type DiffScope,
	type Finding,
	type GitRunner,
	type LastReview,
	type LensResult,
	LENS_OUTPUT_CONTRACT,
	REVIEW_LENSES,
	type ReviewLens,
	buildReport,
	collectDiff,
	hashDiff,
	isGitPush,
	parseLensOutput,
	pushGateQuestion,
	summarizeReport,
} from "../lib/nub-review.ts";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The nub-ia tier the packaged lens declares (assets/agents/<lens>.md). The
 * installed copy under the agent home may carry a physical model instead
 * (/gentle:models writes routing into agent frontmatter), so the packaged
 * file is the authority for which tier to fail over within.
 */
export function packagedLensTier(lens: ReviewLens, root = PACKAGE_ROOT): string | undefined {
	try {
		const match = readFileSync(join(root, "assets", "agents", `${lens}.md`), "utf8").match(/^model:\s*nub-ia\/(\S+)\s*$/m);
		return match?.[1];
	} catch {
		return undefined;
	}
}
const LENS_TIMEOUT_MS = 6 * 60_000;
const DIFF_PROMPT_HEAD = "Review the following unified diff. Only the lines this diff adds, removes, or changes are in scope; surrounding context is for understanding only.\n\n```diff\n";

export function reviewStateDir(cwd: string): string {
	return join(cwd, ".pi", "nub-ia", "reviews");
}

function lastReviewPath(cwd: string): string {
	return join(reviewStateDir(cwd), "last-review.json");
}

export function readLastReview(cwd: string): LastReview | undefined {
	try {
		const parsed = JSON.parse(readFileSync(lastReviewPath(cwd), "utf8")) as Partial<LastReview>;
		return typeof parsed.diffHash === "string" && typeof parsed.verdict === "string" ? (parsed as LastReview) : undefined;
	} catch {
		return undefined;
	}
}

function gitRunner(cwd: string): GitRunner {
	return async (args) => {
		try {
			const result = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as { code?: number | string; stdout?: string; stderr?: string };
			return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
		}
	};
}

/** The hash of what `git push` would deliver: the diff from the upstream (or remote default) to HEAD. */
async function pushDiffHash(cwd: string): Promise<string | undefined> {
	const git = gitRunner(cwd);
	const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	let base = upstream.code === 0 ? upstream.stdout.trim() : undefined;
	if (!base) {
		const remoteHead = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
		base = remoteHead.code === 0 ? remoteHead.stdout.trim() : undefined;
	}
	if (!base) return undefined;
	const diff = await git(["diff", `${base}...HEAD`, "--no-color", "--no-ext-diff", "-U8", "--find-renames"]);
	if (diff.code !== 0 || diff.stdout.trim() === "") return undefined;
	return hashDiff(diff.stdout);
}

interface LensAgent {
	lens: ReviewLens;
	definition: AgentDefinition;
}

function discoverLensAgents(ctx: ExtensionContext): { agents: LensAgent[]; missing: ReviewLens[] } {
	const home = homedir();
	const roots = { cwd: ctx.cwd, home, agentHome: resolveAgentHomeDirectory({ env: process.env, home, homeOverridden: false }) };
	const discovered = discoverAgents(roots).agents;
	const agents: LensAgent[] = [];
	const missing: ReviewLens[] = [];
	for (const lens of REVIEW_LENSES) {
		const definition = discovered.find((agent) => agent.name === lens);
		if (definition) agents.push({ lens, definition });
		else missing.push(lens);
	}
	return { agents, missing };
}

type Completion = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;

/**
 * One completion against `model`. A `direct` request is not retried by Pi's
 * agent loop, so when the lens model is a nub-ia tier and the provider fails
 * (overload, 429, outage), the tier is re-resolved once with that provider
 * excluded and the lens runs again on the physical fallback.
 */
async function completeWithFailover(ctx: ExtensionContext, model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>, tier: string | undefined, context: Parameters<ExtensionContext["modelRegistry"]["complete"]>[1], options: object): Promise<Completion> {
	const first = await ctx.modelRegistry.complete(model, context, options as never);
	const failed = first.stopReason === "error" || first.stopReason === "aborted";
	if (process.env.NUB_IA_ROUTER_DEBUG) console.error(`[nub-ia-review] ${model.provider}/${model.id} → ${first.provider}/${first.model} stop=${first.stopReason} err=${first.errorMessage ?? "-"}`);
	if (!failed || !isModelTier(tier) || !isProviderFailure(first.errorMessage)) return first;
	const toCatalog = (entry: { provider: string; id: string; api?: string; reasoning?: boolean; cost?: { input?: number; output?: number } }): CatalogModel => ({ provider: entry.provider, id: entry.id, api: entry.api, reasoning: entry.reasoning, cost: entry.cost });
	const decision = decideRoute({
		tier,
		reason: "retry",
		available: ctx.modelRegistry.getAvailable().map(toCatalog),
		catalog: loadTierCatalog(ctx.cwd),
		failed: { model: { provider: first.provider, id: first.model }, errorMessage: first.errorMessage },
	});
	const fallback = decision.model ? ctx.modelRegistry.find(decision.model.provider, decision.model.id) : undefined;
	if (!fallback) return first;
	return ctx.modelRegistry.complete(fallback, context, options as never);
}

async function runLens(ctx: ExtensionContext, agent: LensAgent, diff: string, signal: AbortSignal | undefined): Promise<LensResult> {
	const home = homedir();
	const config = loadAgentsConfig({ cwd: ctx.cwd, home, agentHome: resolveAgentHomeDirectory({ env: process.env, home, homeOverridden: false }) });
	const profile = resolveAgentProfile(agent.definition, config);
	const ref = profile.model ?? ctx.model;
	const model = ref?.provider ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
	// The tier the packaged agent declares (frontmatter), used for failover even
	// when a user's models.json pinned this lens to one physical model.
	const declaredTier = ref?.provider === "nub-ia" ? ref.id : packagedLensTier(agent.lens);
	const label = ref ? `${ref.provider}/${ref.id}` : "(session model)";
	if (!model) return { lens: agent.lens, model: label, findings: [], error: `model ${label} is not in this session's catalog` };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LENS_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const assistant = await completeWithFailover(ctx, model, declaredTier, {
			systemPrompt: `${agent.definition.instructions.trim()}\n\n${LENS_OUTPUT_CONTRACT}`,
			messages: [{ role: "user", content: `${DIFF_PROMPT_HEAD}${diff}\n\`\`\``, timestamp: Date.now() }],
		}, { signal: controller.signal, ...(profile.thinking && profile.thinking !== "off" ? { reasoning: profile.thinking } : {}) });
		const resolvedModel = `${assistant.provider}/${assistant.model}`;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return { lens: agent.lens, model: resolvedModel, findings: [], error: assistant.errorMessage ?? `provider ${assistant.stopReason}` };
		}
		const text = assistant.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("");
		try {
			return { lens: agent.lens, model: resolvedModel, findings: parseLensOutput(agent.lens, text) };
		} catch (error) {
			return { lens: agent.lens, model: resolvedModel, findings: [], error: `unparseable answer: ${error instanceof Error ? error.message : String(error)}`, rawExcerpt: text.slice(0, 160) };
		}
	} catch (error) {
		return { lens: agent.lens, model: label, findings: [], error: controller.signal.aborted ? `timed out after ${LENS_TIMEOUT_MS / 60_000} min` : error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export type ReviewRun = { ok: true; summary: string; reportPath: string; findings: Finding[]; error?: undefined } | { ok: false; error: string };

export async function runReview(ctx: ExtensionContext, scope: DiffScope | { kind: "auto" }, signal?: AbortSignal): Promise<ReviewRun> {
	const collected = await collectDiff(gitRunner(ctx.cwd), scope);
	if ("error" in collected) return { ok: false, error: collected.error };
	const { agents, missing } = discoverLensAgents(ctx);
	if (agents.length === 0) return { ok: false, error: `no review lens agents found (expected ${REVIEW_LENSES.join(", ")} under the agent home)` };

	if (ctx.hasUI) ctx.ui.setStatus("nub-review", `reviewing ${collected.scope.kind} diff with ${agents.length} lenses…`);
	let lenses: LensResult[];
	try {
		lenses = await Promise.all(agents.map((agent) => runLens(ctx, agent, collected.diff, signal)));
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("nub-review", "");
	}
	for (const lens of missing) lenses.push({ lens, model: "(none)", findings: [], error: "agent definition not installed" });

	const report = buildReport({ scope: collected.scope, diff: collected.diff, lenses });
	const dir = reviewStateDir(ctx.cwd);
	mkdirSync(dir, { recursive: true });
	const reportPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${report.diffHash}.md`);
	writeFileSync(reportPath, `${report.markdown}\n`, "utf8");
	const last: LastReview = { diffHash: report.diffHash, verdict: report.verdict, reportPath, when: new Date().toISOString() };
	writeFileSync(lastReviewPath(ctx.cwd), `${JSON.stringify(last, null, 2)}\n`, "utf8");
	return { ok: true, summary: summarizeReport(report, reportPath), reportPath, findings: report.findings };
}

function parseScope(input: { scope?: string; baseRef?: string }): DiffScope | { kind: "auto" } | { error: string } {
	if (input.baseRef) return { kind: "base", ref: input.baseRef };
	switch (input.scope) {
		case undefined:
		case "auto":
			return { kind: "auto" };
		case "staged":
			return { kind: "staged" };
		case "working":
			return { kind: "working" };
		default:
			return { error: `unknown scope ${JSON.stringify(input.scope)}; use auto, staged, working, or baseRef` };
	}
}

export default function registerNubIaReview(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "nub_review",
		label: "Nub-IA review",
		description: "Run the Nub-IA 4R code review (risk, reliability, resilience, readability) over the current diff in parallel and write a consolidated report under .pi/nub-ia/reviews/. Returns the verdict and top findings. Run it before pushing; the push gate asks for confirmation when the changes were not reviewed or were blocked.",
		parameters: Type.Object({
			scope: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("staged"), Type.Literal("working")], { description: "auto (default): staged changes if any, else the working tree vs HEAD." })),
			baseRef: Type.Optional(Type.String({ description: "Review the committed range <baseRef>...HEAD instead (for example main or origin/main)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope = parseScope(params as { scope?: string; baseRef?: string });
			if ("error" in scope) return { content: [{ type: "text", text: scope.error }], details: { error: scope.error }, isError: true };
			const result = await runReview(ctx, scope, signal);
			if (!result.ok) return { content: [{ type: "text", text: result.error }], details: { error: result.error }, isError: true };
			return { content: [{ type: "text", text: result.summary }], details: { reportPath: result.reportPath, findings: JSON.parse(JSON.stringify(result.findings)) } };
		},
	});

	pi.registerCommand("nub:review", {
		description: "Review the current diff with the 4R lenses (optional: staged | working | <baseRef>).",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const scope: DiffScope | { kind: "auto" } = arg === "" || arg === "auto" ? { kind: "auto" } : arg === "staged" || arg === "working" ? { kind: arg } : { kind: "base", ref: arg };
			if (ctx.hasUI) ctx.ui.notify("Nub-IA review started…", "info");
			const result = await runReview(ctx, scope);
			if (!ctx.hasUI) return;
			if (result.ok) ctx.ui.notify(result.summary, result.findings.some((finding) => finding.severity === "BLOCKER" || finding.severity === "CRITICAL") ? "warning" : "info");
			else ctx.ui.notify(result.error, "warning");
		},
	});

	// Push gate: confirm before delivering unreviewed or blocked changes.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !isGitPush(command)) return;
		if (process.env.NUB_IA_REVIEW_GATE === "off") return;
		const question = pushGateQuestion(readLastReview(ctx.cwd), await pushDiffHash(ctx.cwd));
		if (question === undefined) return;
		if (!ctx.hasUI) return { block: true, reason: `${question} (no UI to confirm; run nub_review or set NUB_IA_REVIEW_GATE=off)` };
		const confirmed = await ctx.ui.confirm("Nub-IA push gate", question);
		if (!confirmed) return { block: true, reason: "Push cancelled at the Nub-IA review gate." };
	});
}
