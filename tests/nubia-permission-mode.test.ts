// Permission-mode extension helpers (roadmap T7.7–T7.10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { modeChip, parsePermissionModePayload, PERMISSION_MODE_EVENT } from "../extensions/nubia-permission-mode.ts";

test("modeChip: glyph, label and the cap when one applies", () => {
	assert.equal(modeChip("plan"), "⏸ Plan");
	assert.equal(modeChip("accept-edits", "auto"), "✎ Accept edits · max Auto");
	assert.equal(modeChip("auto", "yolo"), "▶ Auto", "a cap at yolo is no cap");
	assert.equal(modeChip("yolo"), "🚀 YOLO");
});

test("parsePermissionModePayload: accepts the published shape and nothing else", () => {
	const payload = { schema: PERMISSION_MODE_EVENT, mode: "manual", max: "auto", source: { initial: "user-file", max: "project-guardrails" } };
	assert.deepEqual(parsePermissionModePayload(payload), payload);
	assert.deepEqual(parsePermissionModePayload({ schema: PERMISSION_MODE_EVENT, mode: "plan" }), { schema: PERMISSION_MODE_EVENT, mode: "plan", source: { initial: "default" } });
	assert.equal(parsePermissionModePayload({ ...payload, mode: "god" }), undefined);
	assert.equal(parsePermissionModePayload({ ...payload, max: "god" }), undefined);
	assert.equal(parsePermissionModePayload({ ...payload, schema: "x" }), undefined);
	assert.equal(parsePermissionModePayload(null), undefined);
});

// --- the extension against a fake Pi -----------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPermissionMode, { PERMISSION_MODE_ENV } from "../extensions/nubia-permission-mode.ts";

type Handler = (...args: unknown[]) => unknown;

function harness(options: { cwd: string; configHome: string; child?: boolean; confirm?: boolean; hasUI?: boolean }) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const shortcuts = new Map<string, { handler: Handler }>();
	const events: Array<{ name: string; payload: unknown }> = [];
	const notices: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const listeners = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec),
		registerShortcut: (key: string, spec: { handler: Handler }) => shortcuts.set(key, spec),
		events: {
			emit: (name: string, payload: unknown) => { events.push({ name, payload }); for (const listener of listeners.get(name) ?? []) listener(payload); },
			on: (name: string, listener: Handler) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; },
		},
	};
	const env: NodeJS.ProcessEnv = { NUB_IA_CONFIG_HOME: options.configHome, ...(options.child ? { NUB_IA_AGENTS_CHILD: "1" } : {}) };
	registerPermissionMode(pi as never, env);
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? true,
		ui: {
			confirm: async () => options.confirm ?? false,
			notify: (text: string) => notices.push(text),
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			select: async () => undefined,
		},
	};
	const fire = async (name: string, event: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
		return result;
	};
	return { fire, commands, shortcuts, events, notices, statuses, ctx, env };
}

test("permission mode extension: starts in the configured mode, gates tools per mode, and the directive follows the mode", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "permission-mode.json"), '{"mode":"plan"}\n');
		const h = harness({ cwd, configHome });
		await h.fire("session_start", {});
		assert.equal(h.env[PERMISSION_MODE_ENV], "plan", "children inherit the (capped) mode through the environment");
		assert.deepEqual(h.statuses.at(-1), ["nubia:mode", "⏸ Plan"]);
		// Plan: reads pass, writes and mutating commands are denied, read-only commands pass.
		assert.equal(await h.fire("tool_call", { toolName: "read", input: { path: "a.ts" } }), undefined);
		const denied = (await h.fire("tool_call", { toolName: "write", input: { path: "a.ts", content: "x" } })) as { block: boolean; reason: string };
		assert.equal(denied.block, true);
		assert.match(denied.reason, /Plan mode is read-only/);
		assert.equal(await h.fire("tool_call", { toolName: "bash", input: { command: "git status" } }), undefined);
		assert.equal(((await h.fire("tool_call", { toolName: "bash", input: { command: "rm -rf dist" } })) as { block: boolean }).block, true);
		const options = { appendSystemPrompt: "" };
		await h.fire("before_agent_start", { systemPromptOptions: options });
		assert.match(options.appendSystemPrompt, /mode="plan"/);
		// /nubia:mode manual: a write now asks; declined → blocked with a no-retry reason.
		await h.commands.get("nubia:mode")!.handler("manual", h.ctx);
		assert.match(h.notices.at(-1)!, /Permission mode: ✋ Manual/);
		const declined = (await h.fire("tool_call", { toolName: "edit", input: { path: "a.ts" } })) as { block: boolean; reason: string };
		assert.equal(declined.block, true);
		assert.match(declined.reason, /declined .* Manual mode/);
		const permissionEvents = h.events.filter((event) => event.name === "pi-permission-system:permission-request").map((event) => (event.payload as { state: string }).state);
		assert.deepEqual(permissionEvents, ["waiting", "denied"]);
		await h.fire("before_agent_start", { systemPromptOptions: options });
		assert.equal((options.appendSystemPrompt.match(/<nubia-permission-mode /g) ?? []).length, 1);
		assert.match(options.appendSystemPrompt, /mode="manual"/);
		// Shift+Tab cycles manual → accept-edits; the mode event is published for the shell.
		await h.shortcuts.get("shift+tab")!.handler(h.ctx);
		const published = h.events.filter((event) => event.name === "nubia:permission-mode/v1").at(-1)!.payload as { mode: string };
		assert.equal(published.mode, "accept-edits");
		assert.equal(await h.fire("tool_call", { toolName: "write", input: { path: join(cwd, "a.ts") } }), undefined, "accept-edits writes inside the repo");
		// default <mode> persists; yolo is refused as a default.
		await h.commands.get("nubia:mode")!.handler("default yolo", h.ctx);
		assert.match(h.notices.at(-1)!, /never a default/);
		await h.commands.get("nubia:mode")!.handler("default manual", h.ctx);
		assert.match(h.notices.at(-1)!, /Startup permission mode saved: Manual/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission mode extension: a repository cap blocks higher modes and a child cannot change mode", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(cwd, ".pi", "nub-ia", "runtime-guardrails.json"), JSON.stringify({ permissionMode: { max: "accept-edits" } }));
		const h = harness({ cwd, configHome });
		await h.fire("session_start", {});
		assert.deepEqual(h.statuses.at(-1), ["nubia:mode", "✎ Accept edits · max Accept edits"], "the default auto is capped to accept-edits");
		await h.commands.get("nubia:mode")!.handler("auto", h.ctx);
		assert.match(h.notices.at(-1)!, /above this repository's cap/);
		await h.shortcuts.get("shift+tab")!.handler(h.ctx);
		assert.match(h.notices.at(-1)!, /Permission mode: ⏸ Plan/, "the cycle wraps below the cap");
		const child = harness({ cwd, configHome, child: true });
		child.env[PERMISSION_MODE_ENV] = "yolo";
		await child.fire("session_start", {});
		const childResult = (await child.fire("tool_call", { toolName: "bash", input: { command: "rm x" } })) as { block: boolean; reason: string };
		assert.equal(childResult.block, true, "a child inherits at most auto, capped here to accept-edits: a mutating command asks, and the fake declines");
		assert.match(childResult.reason, /Accept edits mode/);
		assert.equal(await child.fire("tool_call", { toolName: "write", input: { path: join(cwd, "x.ts") } }), undefined);
		await child.commands.get("nubia:mode")!.handler("auto", child.ctx);
		assert.match(child.notices.at(-1)!, /subagent cannot change the permission mode/);
		assert.deepEqual(child.statuses.filter(([key, text]) => key === "nubia:mode" && text !== undefined), [], "children never paint the mode chip");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
