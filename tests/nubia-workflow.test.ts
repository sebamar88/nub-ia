// /nubia:workflow: status, session switch, validation, and prompt injection for the primary session only.
import assert from "node:assert/strict";
import { test } from "node:test";
import nubiaWorkflow from "../extensions/nubia-workflow.ts";

function setup() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, fn),
	};
	nubiaWorkflow(pi as never);
	const notes: string[] = [];
	const ctx = { hasUI: false, cwd: "/nonexistent-repo", ui: { notify: (text: string) => notes.push(text) } };
	return { run: (args: string) => commands.get("nubia:workflow")!.handler(args, ctx), hooks, notes, ctx };
}

test("/nubia:workflow defaults to none, switches per session and rejects unknown values", async () => {
	const { run, hooks, notes, ctx } = setup();
	hooks.get("session_start")!({}, ctx);
	await run("status");
	assert.match(notes.at(-1)!, /Development Workflow: none \(default\)/);
	await run("svsd");
	await run("status");
	assert.match(notes.at(-1)!, /Development Workflow: svsd \(session\)/);
	await run("waterfall");
	assert.match(notes.at(-1)!, /Unknown workflow "waterfall"/);
	await run("default nope");
	assert.match(notes.at(-1)!, /Use \/nubia:workflow default/);
});

test("the directive reaches the system prompt only when a workflow is active, and shutdown resets it", async () => {
	const { run, hooks, ctx } = setup();
	const options = { appendSystemPrompt: "base" };
	hooks.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
	assert.equal(options.appendSystemPrompt, "base");
	await run("svsd");
	hooks.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
	assert.match(options.appendSystemPrompt, /workflow="svsd"/);
	hooks.get("session_shutdown")!({}, ctx);
	hooks.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
	assert.doesNotMatch(options.appendSystemPrompt, /nubia-workflow/);
});
