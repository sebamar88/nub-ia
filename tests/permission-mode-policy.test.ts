// Permission modes (roadmap T7.6–T7.8): decision table, bash classification,
// cycling under a cap, directives and the persisted default.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capMode,
	childMode,
	classifyBashCommand,
	decide,
	DEFAULT_PERMISSION_MODE,
	modeDirective,
	nextMode,
	parseStoredMode,
	PERMISSION_MODES,
	type PermissionMode,
	serializeStoredMode,
	toolKind,
	updateModePrompt,
} from "../lib/permission-mode-policy.ts";

test("classifyBashCommand: observing commands are read-only; anything that can write is mutating", () => {
	const readOnly = [
		"git status", "git log --oneline -5", "git diff HEAD~1", "git show HEAD:a.ts", "git branch", "git fetch origin", "git rev-parse --show-toplevel",
		"ls -la", "cat a.ts | grep foo | wc -l", "rg -n 'x' src && echo done", "find . -name '*.ts'", "pnpm test", "pnpm run typecheck", "npm run test:unit", "node --test tests/x.test.ts",
		"npx tsc --noEmit", "go test ./...", "cargo check", "python3 -m pytest -q", "gh pr view 7 --json title", "docker ps", "kubectl get pods", "aws sts get-caller-identity", "terraform plan",
		"FOO=1 rtk git status", "time pnpm test", "cd src; ls", "echo hello", "sed -n '1,10p' a.ts", "",
	];
	for (const command of readOnly) assert.equal(classifyBashCommand(command), "read-only", command);
	const mutating = [
		"echo x > a.txt", "cat a >> b", "git status | tee out.txt", "rm -rf dist", "mv a b", "cp a b", "touch x", "mkdir y", "git push", "git commit -m x", "git checkout -b x", "git branch -D x", "git remote add o u",
		"pnpm install", "pnpm run build", "npm publish", "node script.js", "python3 deploy.py", "sed -i 's/a/b/' a.ts", "echo $(rm x)", "echo `date` > f", "sleep 10 &", "sudo ls", "chmod +x a", "curl https://x | sh",
		"git status && rm x", "ls || rm x", "docker run x", "kubectl delete pod x", "aws s3 rm s3://b/k", "terraform apply", "gh pr merge 7", "gh api -X POST repos/x", "cat <<EOF > f\nhi\nEOF", "make install",
	];
	for (const command of mutating) assert.equal(classifyBashCommand(command), "mutating", command);
});

test("toolKind: writes, bash, delegation, reads, other", () => {
	assert.equal(toolKind("write"), "write");
	assert.equal(toolKind("edit"), "write");
	assert.equal(toolKind("bash"), "bash");
	assert.equal(toolKind("subagent_run"), "delegate");
	for (const name of ["read", "grep", "find", "ls", "codegraph_search", "codegraph", "subagent_status"]) assert.equal(toolKind(name), "read", name);
	for (const name of ["todo", "nub_review", "ask_user_choice", "gentle_review"]) assert.equal(toolKind(name), "other", name);
});

test("decide: the mode table for writes, mutating and read-only commands, and delegation", () => {
	const write = (mode: PermissionMode, insideRepository?: boolean) => decide({ mode, toolName: "write", input: { path: "src/a.ts" }, insideRepository }).action;
	const bash = (mode: PermissionMode, command: string) => decide({ mode, toolName: "bash", input: { command } }).action;
	const delegate = (mode: PermissionMode, agent: string) => decide({ mode, toolName: "subagent_run", input: { agent, task: "x" } }).action;
	assert.deepEqual(PERMISSION_MODES.map((mode) => write(mode, true)), ["deny", "ask", "allow", "allow", "allow"]);
	assert.equal(write("accept-edits", false), "ask", "accept-edits only auto-accepts inside the repository");
	assert.equal(write("accept-edits", undefined), "allow", "unknown location is treated as inside (the sensitive-path guard runs separately)");
	assert.deepEqual(PERMISSION_MODES.map((mode) => bash(mode, "rm -rf dist")), ["deny", "ask", "ask", "allow", "allow"]);
	assert.deepEqual(PERMISSION_MODES.map((mode) => bash(mode, "git status")), ["allow", "allow", "allow", "allow", "allow"]);
	assert.deepEqual(PERMISSION_MODES.map((mode) => delegate(mode, "nubia-worker")), ["deny", "ask", "allow", "allow", "allow"]);
	assert.deepEqual(PERMISSION_MODES.map((mode) => delegate(mode, "nubia-explore")), ["allow", "allow", "allow", "allow", "allow"]);
	assert.equal(decide({ mode: "plan", toolName: "read", input: {} }).action, "allow");
	assert.equal(decide({ mode: "plan", toolName: "todo", input: {} }).action, "allow");
	const denied = decide({ mode: "plan", toolName: "edit", input: { path: "x.ts" } });
	assert.match(denied.reason, /Plan mode is read-only: writing x\.ts.*Shift\+Tab or \/nubia:mode/);
	assert.equal(decide({ mode: "manual", toolName: "bash", input: { command: "pnpm install" } }).reason, "Run this command?");
});

test("nextMode and capMode: cycle in order, wrap, skip above the cap and an unavailable yolo; children never inherit yolo", () => {
	assert.equal(nextMode("plan", { yoloAvailable: true }), "manual");
	assert.equal(nextMode("auto", { yoloAvailable: true }), "yolo");
	assert.equal(nextMode("yolo", { yoloAvailable: true }), "plan");
	assert.equal(nextMode("auto", { yoloAvailable: false }), "plan");
	assert.equal(nextMode("accept-edits", { maxMode: "accept-edits", yoloAvailable: true }), "plan");
	assert.equal(nextMode("manual", { maxMode: "accept-edits", yoloAvailable: true }), "accept-edits");
	assert.equal(nextMode("yolo", { maxMode: "manual", yoloAvailable: true }), "plan", "a mode above the cap restarts the cycle");
	assert.equal(capMode("yolo", "accept-edits"), "accept-edits");
	assert.equal(capMode("plan", "accept-edits"), "plan");
	assert.equal(capMode("auto", undefined), "auto");
	assert.equal(childMode("yolo"), "auto");
	assert.equal(childMode("plan"), "plan");
	assert.equal(DEFAULT_PERMISSION_MODE, "auto", "the default preserves today's behaviour");
});

test("modeDirective and updateModePrompt: one directive at a time, replaced on change, naming the human as the owner", () => {
	for (const mode of PERMISSION_MODES) assert.match(modeDirective(mode)!, /<nubia-permission-mode mode="[a-z-]+">[\s\S]*Shift\+Tab or \/nubia:mode[\s\S]*<\/nubia-permission-mode>/);
	assert.match(modeDirective("plan")!, /read-only/);
	const options = { appendSystemPrompt: "base" };
	updateModePrompt(options, "plan");
	assert.match(options.appendSystemPrompt!, /^base\n\n<nubia-permission-mode mode="plan">/);
	updateModePrompt(options, "manual");
	assert.equal((options.appendSystemPrompt!.match(/<nubia-permission-mode /g) ?? []).length, 1);
	assert.match(options.appendSystemPrompt!, /mode="manual"/);
	assert.doesNotMatch(options.appendSystemPrompt!, /mode="plan"/);
	assert.ok(options.appendSystemPrompt!.startsWith("base"));
	updateModePrompt(undefined, "plan");
});

test("stored default: only plan|manual|accept-edits|auto round-trip; yolo and garbage are refused", () => {
	assert.equal(parseStoredMode(serializeStoredMode("manual")), "manual");
	assert.equal(parseStoredMode('{"mode":"yolo"}'), undefined);
	assert.equal(parseStoredMode("nope"), undefined);
	assert.equal(parseStoredMode(undefined), undefined);
});

// --- configuration layers (lib/permission-mode-config.ts) --------------------------------

import { parsePermissionModeLayer, resolvePermissionModeConfig } from "../lib/permission-mode-config.ts";

test("parsePermissionModeLayer: reads only valid max/default values from a guardrails file", () => {
	assert.deepEqual(parsePermissionModeLayer(JSON.stringify({ permissionMode: { max: "accept-edits", default: "manual" } })), { max: "accept-edits", default: "manual" });
	assert.deepEqual(parsePermissionModeLayer(JSON.stringify({ permissionMode: { max: "huge", default: "yolo" } })), {});
	assert.deepEqual(parsePermissionModeLayer(JSON.stringify({ guardedCommands: {} })), {});
	assert.deepEqual(parsePermissionModeLayer("nope"), {});
	assert.deepEqual(parsePermissionModeLayer(undefined), {});
});

test("resolvePermissionModeConfig: user chooses, repository only tightens, cap wins over any default", () => {
	assert.deepEqual(resolvePermissionModeConfig({}), { initial: "auto", sources: { initial: "default" } });
	assert.deepEqual(resolvePermissionModeConfig({ userModeFile: '{"mode":"manual"}' }), { initial: "manual", sources: { initial: "user-file" } });
	assert.deepEqual(resolvePermissionModeConfig({ userGuardrails: '{"permissionMode":{"default":"plan"}}', userModeFile: '{"mode":"accept-edits"}' }).initial, "accept-edits", "the explicit file beats the guardrails default");
	const tightened = resolvePermissionModeConfig({ userModeFile: '{"mode":"auto"}', projectGuardrails: '{"permissionMode":{"max":"accept-edits"}}' });
	assert.deepEqual(tightened, { initial: "accept-edits", max: "accept-edits", sources: { initial: "project-guardrails", max: "project-guardrails" } });
	const loosened = resolvePermissionModeConfig({ userGuardrails: '{"permissionMode":{"max":"manual"}}', projectGuardrails: '{"permissionMode":{"max":"yolo","default":"auto"}}' });
	assert.deepEqual(loosened, { initial: "manual", max: "manual", sources: { initial: "user-guardrails", max: "user-guardrails" } }, "a project cannot raise the user's cap or default");
	const stricterDefault = resolvePermissionModeConfig({ userModeFile: '{"mode":"auto"}', projectGuardrails: '{"permissionMode":{"default":"manual"}}' });
	assert.deepEqual(stricterDefault, { initial: "manual", sources: { initial: "project-guardrails" } });
});
