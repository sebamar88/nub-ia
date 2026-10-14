// Nub-IA doctor lines (roadmap T5.1).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nubiaDoctorLines } from "../lib/nubia-doctor.ts";

test("nubiaDoctorLines: rtk, gate, mode, org policy, prompt profile and checkout state", () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-doctor-"));
	try {
		const cwd = join(root, "repo");
		const configHome = join(root, "cfg");
		mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(cwd, ".pi", "nub-ia", "review-gate.json"), JSON.stringify({ schema: "nub-ia.review-gate/v1", mode: "strict" }));
		writeFileSync(join(cwd, ".pi", "nub-ia", "runtime-guardrails.json"), JSON.stringify({ permissionMode: { max: "accept-edits" } }));
		writeFileSync(join(configHome, "org-policy.json"), JSON.stringify({ schema: "nub-ia.org-policy/v1", name: "Org", roles: { default: "dev", members: {}, definitions: { dev: {} } } }));
		const env = { NUB_IA_CONFIG_HOME: configHome, NUB_IA_PROMPT_PROFILE: "full" } as NodeJS.ProcessEnv;
		const rtk = join(root, "rtk");
		writeFileSync(rtk, "");
		const git = (args: string[]) => (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree" ? "true" : args[0] === "rev-parse" && args[1] === "--short" ? "abc1234" : args[0] === "rev-parse" ? "origin/main" : "0\t3");
		const lines = nubiaDoctorLines({ cwd, packageRoot: root, env, rtkBinary: rtk, git });
		assert.ok(lines.some((line) => line === `pass: rtk rewrite binary ${rtk}`));
		assert.ok(lines.some((line) => /^pass: Review gate: strict — decided by project file/.test(line)), lines.join("\n"));
		assert.ok(lines.some((line) => line === "pass: Permission mode starts in Accept edits (project-guardrails) · cap Accept edits (project-guardrails)"));
		assert.ok(lines.some((line) => /^pass: Org policy: Org · role dev \(default\)/.test(line)));
		assert.ok(lines.some((line) => line === "pass: Prompt profile full (environment)"));
		assert.ok(lines.some((line) => line === "warn: package checkout abc1234 is 3 commit(s) behind origin/main; run nub-ia update"));
		const missing = nubiaDoctorLines({ cwd, packageRoot: root, env: { NUB_IA_CONFIG_HOME: join(root, "none") }, rtkBinary: "rtk", git: () => undefined });
		assert.ok(missing.some((line) => /^warn: packaged rtk binary missing/.test(line)));
		assert.ok(missing.some((line) => /^pass: Org policy: none/.test(line)));
		assert.ok(missing.some((line) => /^pass: package not a Git checkout/.test(line)));
		assert.ok(nubiaDoctorLines({ cwd, packageRoot: root, env: { ...env, RTK_DISABLED: "1" }, rtkBinary: rtk, git }).some((line) => /^warn: rtk rewrite disabled/.test(line)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
