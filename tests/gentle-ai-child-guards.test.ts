import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { YOLO_STATUS_KEY } from "../lib/yolo-session-policy.ts";

// gentle-shell#1690: the package is forwarded to delegated rpc children
// (GENTLE_PI_AGENTS_CHILD=1, where ctx.hasUI is true). Parent-owned startup
// work and shared-state writes must not run there; each case pairs the child
// with a parent control so the guard cannot pass vacuously.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function isolate(t: TestContext): { root: string; cwd: string; agentHome: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-child-guards-")));
	const cwd = join(root, "project");
	const agentHome = join(root, "agent-home");
	const configHome = join(root, "config");
	for (const path of [cwd, agentHome, configHome]) mkdirSync(path, { recursive: true });
	const previous = { agentHome: process.env.GENTLE_PI_AGENT_HOME, configHome: process.env.GENTLE_PI_CONFIG_HOME };
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previous.agentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous.agentHome;
		if (previous.configHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous.configHome;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, cwd, agentHome };
}

function harness(child: boolean, cwd: string) {
	const handlers = new Map<string, Handler>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const prompts: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		events: { on() {}, emit() {} },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		getThinkingLevel: () => "medium",
		registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		processEnv: { GENTLE_PI_AGENTS_CHILD: child ? "1" : "0", GENTLE_AI_TELEMETRY: "0" },
	})(pi);
	const sessionManager = { getSessionId: () => `session-${child ? "child" : "parent"}`, getCwd: () => cwd, getEntries: () => entries, getBranch: () => entries };
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: true,
		sessionManager,
		ui: {
			notify() {},
			setStatus: (key: string, text?: string) => { statuses.push([key, text]); },
			confirm: async (title: string) => { prompts.push(`confirm:${title}`); return false; },
			select: async (title: string) => { prompts.push(`select:${title}`); return undefined; },
		},
	} as unknown as ExtensionContext;
	return { handlers, entries, prompts, statuses, tools, ctx, sessionManager };
}

function legacySettings(cwd: string): string {
	const path = join(cwd, ".pi", "settings.json");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ subagents: { agentOverrides: { worker: "openai/gpt-5" } } }, null, 2)}\n`);
	return path;
}

test("child session_start keeps local resets but skips parent-owned startup work", async (t) => {
	const { cwd, agentHome } = isolate(t);
	const settingsPath = legacySettings(cwd);
	const before = readFileSync(settingsPath, "utf8");
	const h = harness(true, cwd);
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.deepEqual(readdirSync(agentHome), [], "a child must not install package assets");
	assert.equal(readFileSync(settingsPath, "utf8"), before, "a child must not migrate project model overrides");
});

test("parent session_start still runs the startup work skipped in children", async (t) => {
	const { cwd, agentHome } = isolate(t);
	const settingsPath = legacySettings(cwd);
	const before = readFileSync(settingsPath, "utf8");
	const h = harness(false, cwd);
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.notDeepEqual(readdirSync(agentHome), [], "the parent installs package assets");
	assert.notEqual(readFileSync(settingsPath, "utf8"), before, "the parent migrates legacy project model overrides");
});

test("child session_start re-arms YOLO for its own session", async (t) => {
	const { cwd } = isolate(t);
	const h = harness(true, cwd);
	const next = { ...h.sessionManager, getSessionId: () => "session-child-next" };
	const nextCtx = { ...h.ctx, sessionManager: next } as unknown as ExtensionContext;
	const yoloClears = () => h.statuses.filter(([key, text]) => key === YOLO_STATUS_KEY && text === undefined).length;
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.handlers.get("session_shutdown")!({ reason: "new" }, h.ctx);
	const clearsBeforeRestart = yoloClears();
	await h.handlers.get("session_start")!({ reason: "new" }, nextCtx);
	assert.equal(yoloClears(), clearsBeforeRestart + 1, "the child session_start resets YOLO and clears its indicator");
});

test("child confirm-class guardrail commands ask the parent instead of running or blocking headlessly", async (t) => {
	const { cwd } = isolate(t);
	const h = harness(true, cwd);
	const result = await h.handlers.get("tool_call")!({ toolName: "bash", input: { command: "pi remove some-package" } }, h.ctx) as { block?: boolean; reason?: string } | undefined;
	assert.equal(h.prompts.length, 1, JSON.stringify(h.prompts));
	assert.equal(result?.block, true, "the declined confirmation blocks the command");
	assert.doesNotMatch(result?.reason ?? "", /requires interactive confirmation/);
});
