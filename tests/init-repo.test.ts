import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initRepo, REPO_TEMPLATES } from "../scripts/init-repo.mjs";
import { parsePathPolicy } from "../lib/path-permission-policy.ts";
import { parseDelegationLimits, parsePermissionModeLayer } from "../lib/permission-mode-config.ts";
import { parseAgentToolPolicy } from "../lib/agent-tool-policy.ts";
import { loadProjectRules } from "../lib/nub-review.ts";

test("initRepo scaffolds inert, parseable policy files and never overwrites", () => {
	const cwd = mkdtempSync(join(tmpdir(), "nubia-init-"));
	try {
		writeFileSync(join(cwd, "AGENTS.md"), "x");
		const first = initRepo(cwd);
		assert.deepEqual(first.created, Object.keys(REPO_TEMPLATES));
		const guardrails = readFileSync(join(first.dir, "runtime-guardrails.json"), "utf8");
		assert.deepEqual(parsePathPolicy(guardrails), { deny: [], confirm: [] });
		assert.deepEqual(parsePermissionModeLayer(guardrails), {});
		assert.deepEqual(parseDelegationLimits(guardrails), {});
		assert.deepEqual(parseAgentToolPolicy(guardrails), []);
		assert.equal(JSON.parse(readFileSync(join(first.dir, "review-gate.json"), "utf8")).mode, "confirm");
		assert.match(loadProjectRules((relative) => (relative === ".pi/nub-ia/review-rules.md" ? readFileSync(join(cwd, relative), "utf8") : undefined))!.text, /Review rules for this repository/);
		writeFileSync(join(first.dir, "persona.json"), '{"mode":"neutral"}');
		const second = initRepo(cwd, { reviewGate: false });
		assert.deepEqual(second.created, []);
		assert.ok(second.kept.includes("persona.json") && !second.kept.includes("review-gate.json"));
		assert.equal(JSON.parse(readFileSync(join(first.dir, "persona.json"), "utf8")).mode, "neutral", "an existing file is left alone");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

import { resolveReviewGate } from "../lib/review-gate-policy.ts";
test("the scaffolded review gate is well-formed for the gate reader", () => {
	const cwd = mkdtempSync(join(tmpdir(), "nubia-init-"));
	try {
		initRepo(cwd);
		const resolution = resolveReviewGate(cwd, { configHome: join(cwd, "no-config") });
		assert.equal(resolution.malformed, false);
		assert.equal(resolution.mode, "confirm");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
