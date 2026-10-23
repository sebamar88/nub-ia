import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNubiaExtension } from "../extensions/nubia-harness.ts";
import nubiaTodo from "../extensions/nubia-todo.ts";

// nubia-shell#1485: pi-claude-bridge forwards only the structured
// systemPromptOptions parts of before_agent_start (contextFiles, skills,
// customPrompt, appendSystemPrompt) after Claude Code's own preset, so a
// handler-returned replacement systemPrompt never reaches the model on that
// provider. These tests exercise both extensions against one shared
// systemPromptOptions object, the same object every before_agent_start
// handler observes within a single pi emission (packages/coding-agent
// extensions/runner.js emitBeforeAgentStart: one `currentOptions` per call).

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

let fixtureCwd: string;
let fixtureRoot: string | undefined;
const fixtureEnvironment: NodeJS.ProcessEnv = {};
const previousEnvironment = new Map<string, string | undefined>();
before(async () => {
	const root = await mkdtemp(join(tmpdir(), "nub-ia-append-route-"));
	fixtureRoot = root;
	fixtureCwd = join(root, "project");
	const home = join(root, "home");
	for (const directory of [fixtureCwd, home]) await mkdir(directory);
	Object.assign(fixtureEnvironment, {
		HOME: home, USERPROFILE: home,
		NUB_IA_CONFIG_HOME: join(home, "config"),
		NUB_IA_AGENT_HOME: join(home, "agents"),
		PI_CODING_AGENT_DIR: join(home, "pi"),
		XDG_CONFIG_HOME: join(home, "xdg"),
		// These tests exercise the complete harness text; the runtime default is the minimal profile (T5.0).
		NUB_IA_PROMPT_PROFILE: "full",
	});
	for (const [key, value] of Object.entries(fixtureEnvironment)) {
		previousEnvironment.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(async () => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
});

function nubiaHandlers(processEnv: NodeJS.ProcessEnv = {}): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createNubiaExtension({
		processEnv: { ...fixtureEnvironment, NUB_IA_AGENTS_CHILD: "0", ...processEnv, NUB_IA_TELEMETRY: "0" },
	})(pi);
	return handlers;
}

function nubiaTodoHandlers(): { handlers: Map<string, Handler[]>; tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }> } {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown>; name: string }>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown>; name: string }) {
			tools.set(tool.name, tool);
		},
		registerShortcut() {},
	} as unknown as ExtensionAPI;
	nubiaTodo(pi, {});
	return { handlers, tools };
}

function ctx(): ExtensionContext {
	return {
		cwd: fixtureCwd,
		hasUI: true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => "append-route-session", getBranch: () => [] },
	} as unknown as ExtensionContext;
}

test("both extensions land their block in appendSystemPrompt on one shared options object, and neither returns a replacement systemPrompt", async () => {
	const aiHandlers = nubiaHandlers();
	const { handlers: todoHandlers, tools } = nubiaTodoHandlers();
	const session = ctx();

	for (const handler of todoHandlers.get("session_start") ?? []) await handler({}, session);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, session);
	for (const handler of todoHandlers.get("tool_execution_end") ?? []) await handler({ toolName: "todo" }, session);

	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };

	// Every handler registered for before_agent_start observes the same
	// systemPromptOptions object within one emission, exactly as pi's runner
	// does for the real event.
	const aiResult = await aiHandlers.get("before_agent_start")!(event, session);
	let todoResult: unknown;
	for (const handler of todoHandlers.get("before_agent_start") ?? []) todoResult = await handler(event, session);

	assert.equal(aiResult, undefined, "nub-ia must not return a replacement systemPrompt");
	assert.equal(todoResult, undefined, "nubia-todo must not return a replacement systemPrompt");

	const appended = event.systemPromptOptions.appendSystemPrompt;
	assert.match(appended, /Nub-IA Identity and Harness/);
	assert.match(appended, /## Todo list/);
	assert.match(appended, /1\. \[pending\] Fix the bug/);
	assert.ok(
		appended.indexOf("Nub-IA Identity and Harness") < appended.indexOf("## Todo list"),
		"nub-ia's block must precede nubia-todo's, matching handler registration order",
	);
});

test("re-running both handlers on the same already-populated options object does not duplicate either block", async () => {
	const aiHandlers = nubiaHandlers();
	const { handlers: todoHandlers, tools } = nubiaTodoHandlers();
	const session = ctx();

	for (const handler of todoHandlers.get("session_start") ?? []) await handler({}, session);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, session);
	for (const handler of todoHandlers.get("tool_execution_end") ?? []) await handler({ toolName: "todo" }, session);

	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	await aiHandlers.get("before_agent_start")!(event, session);
	const nubiaOccurrencesAfterFirstRun = event.systemPromptOptions.appendSystemPrompt.split("Nub-IA Identity and Harness").length - 1;
	assert.equal(nubiaOccurrencesAfterFirstRun, 1);

	// A defensive re-run of nub-ia's own handler against an options object
	// that already carries its exact block must not append it again.
	await aiHandlers.get("before_agent_start")!(event, session);
	const nubiaOccurrencesAfterSecondRun = event.systemPromptOptions.appendSystemPrompt.split("Nub-IA Identity and Harness").length - 1;
	assert.equal(nubiaOccurrencesAfterSecondRun, 1, "a second nub-ia run on the same options object must not duplicate the harness");
});

for (const scenario of ["child", "named-agent"] as const) {
	test(`${scenario} start leaves shared prompt options unchanged and returns no replacement`, async () => {
		const handlers = nubiaHandlers(scenario === "child" ? { NUB_IA_AGENTS_CHILD: "1" } : {});
		const event = {
			systemPrompt: "base",
			systemPromptOptions: { appendSystemPrompt: "Existing provider section" },
			...(scenario === "named-agent" ? { agentName: "nubia-worker" } : {}),
		};
		const result = await handlers.get("before_agent_start")!(event, ctx());
		assert.equal(result, undefined, "excluded sessions must not return a replacement system prompt");
		assert.equal(event.systemPromptOptions.appendSystemPrompt, "Existing provider section");
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /Nub-IA Identity and Harness/);
	});
}

test("without NUB_IA_PROMPT_PROFILE the runtime appends the minimal Nub-IA block", async () => {
	const saved = process.env.NUB_IA_PROMPT_PROFILE;
	delete process.env.NUB_IA_PROMPT_PROFILE;
	try {
		const { __testing } = await import("../extensions/nubia-harness.ts");
		const full = __testing.buildNubiaPrompt("gentleman", fixtureCwd, undefined, undefined, "full");
		const minimal = __testing.buildNubiaPrompt("gentleman", fixtureCwd, undefined, undefined, "minimal");
		assert.ok(Buffer.byteLength(minimal) * 4 < Buffer.byteLength(full));
		assert.match(minimal, /^## Nub-IA\n/);
	} finally {
		if (saved !== undefined) process.env.NUB_IA_PROMPT_PROFILE = saved;
	}
});
