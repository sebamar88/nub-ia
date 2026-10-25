// Development Workflow config: valid values, strict decoding, resolution order, backward-compatible default.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isWorkflow, parseWorkflowFile, resolveWorkflow, updateWorkflowPrompt, workflowDirective, writeWorkflow } from "../lib/workflow-config.ts";

test("none, sdd and svsd are valid; anything else is rejected", () => {
	for (const value of ["none", "sdd", "svsd"]) assert.equal(isWorkflow(value), true, value);
	for (const value of ["SVSD", "odd", "", undefined, 1]) assert.equal(isWorkflow(value), false, String(value));
});

test("parseWorkflowFile is strict: schema, exact keys, known value", () => {
	assert.equal(parseWorkflowFile('{"schema":"nub-ia.workflow/v1","default":"svsd"}'), "svsd");
	assert.equal(parseWorkflowFile('{"schema":"nub-ia.workflow/v2","default":"svsd"}'), undefined);
	assert.equal(parseWorkflowFile('{"schema":"nub-ia.workflow/v1","default":"waterfall"}'), undefined);
	assert.equal(parseWorkflowFile('{"schema":"nub-ia.workflow/v1","default":"sdd","extra":1}'), undefined);
	assert.equal(parseWorkflowFile("not json"), undefined);
	assert.equal(parseWorkflowFile(undefined), undefined);
});

test("resolveWorkflow: environment > repo file > user file > default none; permission mode is irrelevant", () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-workflow-"));
	try {
		const configHome = join(root, "cfg");
		const cwd = join(root, "repo");
		assert.deepEqual(resolveWorkflow({ env: {}, cwd, configHome }), { workflow: "none", source: "default" }, "existing repos keep the adaptive behavior");
		writeWorkflow("sdd", configHome);
		assert.deepEqual(resolveWorkflow({ env: {}, cwd, configHome }), { workflow: "sdd", source: "user-file" });
		const repoFile = join(cwd, ".pi", "nub-ia", "workflow.json");
		const read = (path: string) => (path === repoFile ? '{"schema":"nub-ia.workflow/v1","default":"svsd"}' : undefined);
		assert.deepEqual(resolveWorkflow({ env: {}, cwd, configHome, read }), { workflow: "svsd", source: "project-file" });
		assert.deepEqual(resolveWorkflow({ env: { NUB_IA_WORKFLOW: "none", NUB_IA_PERMISSION_MODE: "yolo" }, cwd, configHome, read }), { workflow: "none", source: "environment" });
		assert.deepEqual(resolveWorkflow({ env: { NUB_IA_WORKFLOW: "bogus" }, cwd, configHome }), { workflow: "sdd", source: "user-file" }, "an invalid env value is ignored");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the directive exists only for sdd and svsd, is idempotent, and swaps cleanly", () => {
	assert.equal(workflowDirective("none"), undefined);
	assert.match(workflowDirective("svsd")!, /never split it into horizontal phases/);
	assert.match(workflowDirective("sdd")!, /Spec, Design, Tasks/);
	const options = { appendSystemPrompt: "base" };
	updateWorkflowPrompt(options, "svsd");
	updateWorkflowPrompt(options, "svsd");
	assert.equal(options.appendSystemPrompt.match(/<nubia-workflow/g)?.length, 1);
	updateWorkflowPrompt(options, "sdd");
	assert.match(options.appendSystemPrompt, /workflow="sdd"/);
	assert.doesNotMatch(options.appendSystemPrompt, /svsd/);
	updateWorkflowPrompt(options, "none");
	assert.equal(options.appendSystemPrompt.trim(), "base");
});
