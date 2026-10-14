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
	const emit = (name: string, payload: unknown) => pi.events.emit(name, payload);
	return { fire, commands, shortcuts, events, notices, statuses, ctx, env, emit };
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

test("permission mode extension: the path policy denies or confirms regardless of mode, from user and repository files", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "runtime-guardrails.json"), JSON.stringify({ paths: { confirm: ["package.json"] } }));
		writeFileSync(join(cwd, ".pi", "nub-ia", "runtime-guardrails.json"), JSON.stringify({ paths: { deny: [".github/**", "*.lock"] } }));
		const h = harness({ cwd, configHome, confirm: true });
		await h.fire("session_start", {});
		assert.deepEqual(h.statuses.at(-1), ["nubia:mode", "▶ Auto"]);
		const denied = (await h.fire("tool_call", { toolName: "edit", input: { path: ".github/workflows/ci.yml" } })) as { block: boolean; reason: string };
		assert.equal(denied.block, true);
		assert.match(denied.reason, /Path policy: \.github\/workflows\/ci\.yml matches "\.github\/\*\*"/);
		const viaBash = (await h.fire("tool_call", { toolName: "bash", input: { command: "echo x > pnpm-lock.yaml.lock" } })) as { block: boolean };
		assert.equal(viaBash.block, true, "a redirection into a denied path is caught too");
		assert.equal(await h.fire("tool_call", { toolName: "write", input: { path: join(cwd, "package.json"), content: "{}" } }), undefined, "confirm in auto mode asks (the fake approves)");
		const states = h.events.filter((event) => event.name === "pi-permission-system:permission-request").map((event) => (event.payload as { state: string }).state);
		assert.deepEqual(states, ["waiting", "approved"]);
		assert.equal(await h.fire("tool_call", { toolName: "write", input: { path: join(cwd, "src", "a.ts"), content: "x" } }), undefined, "unprotected paths pass silently in auto");
		assert.equal(h.events.filter((event) => event.name === "pi-permission-system:permission-request").length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission mode extension: a child applies its agent's tool rules and fails closed on confirm", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(cwd, ".pi", "nub-ia", "runtime-guardrails.json"), JSON.stringify({ agents: { "nubia-explore": { tools: { write: "deny", bash: "confirm" } } } }));
		const child = harness({ cwd, configHome, child: true, hasUI: false });
		child.env.NUB_IA_AGENT_NAME = "nubia-explore";
		await child.fire("session_start", {});
		const denied = (await child.fire("tool_call", { toolName: "write", input: { path: join(cwd, "a.ts") } })) as { block: boolean; reason: string };
		assert.match(denied.reason, /nubia-explore agent may not use write/);
		const confirm = (await child.fire("tool_call", { toolName: "bash", input: { command: "git status" } })) as { block: boolean; reason: string };
		assert.match(confirm.reason, /requires the human's confirmation, which a subagent cannot obtain/);
		assert.equal(await child.fire("tool_call", { toolName: "read", input: { path: "a.ts" } }), undefined);
		child.env.NUB_IA_AGENT_NAME = "nubia-worker";
		const other = harness({ cwd, configHome, child: true, hasUI: false });
		other.env.NUB_IA_AGENT_NAME = "nubia-worker";
		await other.fire("session_start", {});
		assert.equal(await other.fire("tool_call", { toolName: "write", input: { path: join(cwd, "a.ts") } }), undefined, "rules are per agent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission mode extension: delegation limits count live subagents and per-turn launches", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "runtime-guardrails.json"), JSON.stringify({ limits: { maxConcurrentSubagents: 2, maxSubagentsPerTurn: 2, blockDelegationOverBudget: true } }));
		const h = harness({ cwd, configHome });
		await h.fire("session_start", {});
		await h.fire("turn_start", {});
		const run = { toolName: "subagent_run", input: { agent: "nubia-worker", task: "x" } };
		assert.equal(await h.fire("tool_call", run), undefined);
		assert.equal(await h.fire("tool_call", run), undefined);
		assert.match(((await h.fire("tool_call", run)) as { reason: string }).reason, /maxSubagentsPerTurn = 2 reached/);
		await h.fire("turn_start", {});
		h.emit("nubia:agents-status/v1", { schema: "nubia:agents-status/v1", running: 2, queued: 0, waiting: 0, finished: 0, items: [] });
		assert.match(((await h.fire("tool_call", run)) as { reason: string }).reason, /maxConcurrentSubagents = 2 reached \(2 active\)/);
		h.emit("nubia:agents-status/v1", { schema: "nubia:agents-status/v1", running: 0, queued: 0, waiting: 0, finished: 2, items: [] });
		h.emit("nubia:router-status/v1", { schema: "nubia:router-status/v1", resolved: {}, excluded: [], unroutable: [], degraded: {}, budget: { text: "budget $25 / $20 today", exceeded: true } });
		assert.match(((await h.fire("tool_call", run)) as { reason: string }).reason, /budget is exceeded/);
		assert.equal(await h.fire("tool_call", { toolName: "read", input: { path: "a" } }), undefined, "limits only concern delegation");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission mode extension: bash/read output is redacted before the model sees it; other tools untouched", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(configHome, { recursive: true });
		const h = harness({ cwd, configHome });
		await h.fire("session_start", {});
		const leaked = (await h.fire("tool_result", { toolName: "bash", input: {}, content: [{ type: "text", text: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nok" }, { type: "image", data: "x", mimeType: "image/png" }], isError: false })) as { content: Array<{ type: string; text?: string }> };
		assert.doesNotMatch(leaked.content[0]!.text!, /AKIAIOSFODNN7EXAMPLE/);
		assert.match(leaked.content[0]!.text!, /\[nub-ia: 1 aws-access-key redacted from this output\]/);
		assert.equal(leaked.content[1]!.type, "image");
		assert.equal(await h.fire("tool_result", { toolName: "bash", input: {}, content: [{ type: "text", text: "all clean" }], isError: false }), undefined, "clean output is passed through untouched");
		assert.equal(await h.fire("tool_result", { toolName: "write", input: {}, content: [{ type: "text", text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }], isError: false }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission mode extension: the organisation policy caps the mode and protects paths above repo and user", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "permission-mode.json"), '{"mode":"auto"}\n');
		writeFileSync(join(configHome, "org-policy.json"), JSON.stringify({ schema: "nub-ia.org-policy/v1", name: "Org", permissionMode: { max: "manual" }, paths: { deny: ["infra/**"] }, limits: { maxSubagentsPerTurn: 0 } }));
		const h = harness({ cwd, configHome });
		await h.fire("session_start", {});
		assert.deepEqual(h.statuses.at(-1), ["nubia:mode", "✋ Manual · max Manual"], "the user's auto default is capped by the org");
		await h.commands.get("nubia:mode")!.handler("auto", h.ctx);
		assert.match(h.notices.at(-1)!, /above this repository's cap \(Manual, from org-policy\)/);
		const denied = (await h.fire("tool_call", { toolName: "write", input: { path: join(cwd, "infra", "main.tf") } })) as { reason: string };
		assert.match(denied.reason, /Path policy: infra\/main\.tf/);
		await h.fire("turn_start", {});
		assert.match(((await h.fire("tool_call", { toolName: "subagent_run", input: { agent: "nubia-worker", task: "x" } })) as { reason: string }).reason, /maxSubagentsPerTurn = 0/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission mode extension: an org role (NUB_IA_ROLE) replaces the org-level cap for that member", async () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-mode-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "config");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "org-policy.json"), JSON.stringify({ schema: "nub-ia.org-policy/v1", name: "Org", permissionMode: { max: "manual" }, roles: { default: "developer", members: {}, definitions: { developer: {}, lead: { permissionMode: { max: "auto" } } } } }));
		const dev = harness({ cwd, configHome });
		await dev.fire("session_start", {});
		assert.deepEqual(dev.statuses.at(-1), ["nubia:mode", "✋ Manual · max Manual"]);
		const lead = harness({ cwd, configHome });
		lead.env.NUB_IA_ROLE = "lead";
		await lead.fire("session_start", {});
		assert.deepEqual(lead.statuses.at(-1), ["nubia:mode", "▶ Auto · max Auto"], "the lead role lifts the org cap to auto");
		await lead.commands.get("nubia:mode")!.handler("status", lead.ctx);
		assert.match(lead.notices.at(-1)!, /Org policy: Org · role lead \(env\)/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
