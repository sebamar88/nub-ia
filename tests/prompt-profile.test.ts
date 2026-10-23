// Prompt profile (roadmap T5.0): the minimal addition stays small; resolution order; the switch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildMinimalPrompt, parsePromptProfile, resolvePromptProfile, writePromptProfile } from "../lib/prompt-profile.ts";
import { __testing } from "../extensions/nubia-harness.ts";

test("the minimal profile adds well under a quarter of the full harness text and keeps the essentials", () => {
	const minimal = __testing.buildNubiaPrompt("gentleman", process.cwd(), undefined, undefined, "minimal");
	const full = __testing.buildNubiaPrompt("gentleman", process.cwd(), undefined, undefined, "full");
	assert.ok(Buffer.byteLength(minimal) < 3_000, `minimal is ${Buffer.byteLength(minimal)} bytes`);
	assert.ok(Buffer.byteLength(minimal) * 4 < Buffer.byteLength(full), "minimal is at most a quarter of full");
	for (const essential of ["You are Nub-IA", "Persona:", "Rioplatense Spanish with voseo", "Authorize:", "read-only", "test-first", "subagent_run", "nub_review", "Needs your decision", "`nubia` skill"]) assert.ok(minimal.includes(essential), essential);
	assert.doesNotMatch(minimal, /\n{3,}/, "no triple blank lines");
	const neutral = __testing.buildNubiaPrompt("neutral", process.cwd(), ["read", "bash"], undefined, "minimal");
	assert.match(neutral, /Do NOT use voseo/);
	assert.match(neutral, /No subagents in this session/);
	assert.doesNotMatch(neutral, /nub_review/, "review line only when the tool is registered");
	assert.equal(__testing.buildNubiaPrompt("gentleman"), full, "the default argument keeps the full text for existing callers and tests");
});

test("buildMinimalPrompt toggles the delegation and review lines on tool availability", () => {
	const base = { persona: "gentleman" as const, personaPrompt: "Persona:\n- x", languageBoundary: "Language: y" };
	assert.match(buildMinimalPrompt({ ...base, subagentsAvailable: true, reviewAvailable: true }), /subagent_run[\s\S]*nub_review/);
	const bare = buildMinimalPrompt({ ...base, subagentsAvailable: false, reviewAvailable: false });
	assert.match(bare, /No subagents/);
	assert.doesNotMatch(bare, /nub_review/);
});

test("resolvePromptProfile: environment > repository file > user file > default minimal; writePromptProfile persists", () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-prompt-"));
	try {
		const configHome = join(root, "cfg");
		const cwd = join(root, "repo");
		assert.deepEqual(resolvePromptProfile({ env: {}, cwd, configHome }), { profile: "minimal", source: "default" });
		writePromptProfile("full", configHome);
		assert.deepEqual(resolvePromptProfile({ env: {}, cwd, configHome }), { profile: "full", source: "user-file" });
		const files: Record<string, string> = { [join(cwd, ".pi", "nub-ia", "prompt-profile.json")]: '{"profile":"minimal"}' };
		assert.deepEqual(resolvePromptProfile({ env: {}, cwd, configHome, read: (path) => files[path] ?? (path.startsWith(configHome) ? '{"profile":"full"}' : undefined) }), { profile: "minimal", source: "project-file" });
		assert.deepEqual(resolvePromptProfile({ env: { NUB_IA_PROMPT_PROFILE: "full" }, cwd, configHome, read: () => '{"profile":"minimal"}' }), { profile: "full", source: "environment" });
		assert.equal(parsePromptProfile('{"profile":"huge"}'), undefined);
		assert.equal(parsePromptProfile("x"), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
