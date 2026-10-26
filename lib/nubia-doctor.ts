// Nub-IA doctor lines (roadmap T5.1): the checks that belong to this fork, in
// one pure-ish module the harness doctor appends. Each line is `pass: …`,
// `warn: …` or `fail: …`, like the upstream doctor's own.

import { brand } from "./brand.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEffectiveOrgPolicy, describeOrgPolicy } from "./org-policy.ts";
import { resolvePermissionModeConfig } from "./permission-mode-config.ts";
import { MODE_LABEL } from "./permission-mode-policy.ts";
import { resolvePromptProfile } from "./prompt-profile.ts";
import { describeReviewGate, resolveReviewGate } from "./review-gate-policy.ts";
import { configReadPath, nubIaConfigHome, projectConfigReadPath } from "./config-home.ts";

export interface DoctorInput {
	cwd: string;
	packageRoot: string;
	env?: NodeJS.ProcessEnv;
	/** Path the rtk rewrite would execute (extensions/rtk-rewrite.ts resolveRtkBinary). */
	rtkBinary: string;
	git?: (args: string[], cwd: string) => string | undefined;
}

const defaultGit = (args: string[], cwd: string): string | undefined => {
	try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5_000 }).trim(); } catch { return undefined; }
};

function readText(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

export function nubiaDoctorLines(input: DoctorInput): string[] {
	const env = input.env ?? process.env;
	const git = input.git ?? defaultGit;
	const lines: string[] = [];

	// rtk: the packaged binary or an explicit one; a bare "rtk" means PATH fallback.
	if (env.RTK_DISABLED === "1") lines.push("warn: rtk rewrite disabled for this session (RTK_DISABLED=1)");
	else if (input.rtkBinary === "rtk") lines.push("warn: packaged rtk binary missing; commands pass unfiltered unless `rtk` is on PATH (pnpm run install:rtk)");
	else if (!existsSync(input.rtkBinary)) lines.push(`fail: rtk binary not found at ${input.rtkBinary}`);
	else lines.push(`pass: rtk rewrite binary ${input.rtkBinary}`);

	// Review gate.
	const gate = resolveReviewGate(input.cwd, { env });
	lines.push(`${gate.mode === "off" ? "warn" : "pass"}: ${describeReviewGate(gate)}`);

	// Permission mode and the organisation policy with role.
	const org = loadEffectiveOrgPolicy(env, input.cwd);
	const home = nubIaConfigHome(env);
	const mode = resolvePermissionModeConfig({
		userModeFile: readText(join(home, "permission-mode-default.json")),
		userGuardrails: readText(configReadPath(home, "runtime-guardrails.json", env)),
		projectGuardrails: readText(projectConfigReadPath(input.cwd, "runtime-guardrails.json")),
		orgPolicy: org.policy?.sections.permissionMode !== undefined ? JSON.stringify({ permissionMode: org.policy.sections.permissionMode }) : undefined,
	});
	lines.push(`pass: Permission mode starts in ${MODE_LABEL[mode.initial]} (${mode.sources.initial})${mode.max ? ` · cap ${MODE_LABEL[mode.max]} (${mode.sources.max})` : ""}`);
	for (const line of describeOrgPolicy(org.policy, org.path)) lines.push(`pass: ${line.trim()}${org.role && line.startsWith("Org policy") ? ` · role ${org.role.role} (${org.role.source})` : ""}`);

	// Prompt profile.
	const profile = resolvePromptProfile({ env, cwd: input.cwd });
	lines.push(`pass: Prompt profile ${profile.profile} (${profile.source})`);

	// Package checkout vs origin (only when installed from Git).
	const inside = git(["rev-parse", "--is-inside-work-tree"], input.packageRoot);
	if (inside === "true") {
		const head = git(["rev-parse", "--short", "HEAD"], input.packageRoot);
		const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], input.packageRoot);
		if (!upstream) lines.push(`warn: package checkout ${head ?? "?"} has no tracking branch; ${brand.bin} update cannot fast-forward it`);
		else {
			const counts = git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], input.packageRoot);
			const [ahead, behind] = (counts ?? "0\t0").split(/\s+/).map(Number);
			if (behind > 0) lines.push(`warn: package checkout ${head} is ${behind} commit(s) behind ${upstream}; run ${brand.bin} update`);
			else if (ahead > 0) lines.push(`warn: package checkout ${head} is ${ahead} commit(s) ahead of ${upstream} (local changes)`);
			else lines.push(`pass: package checkout ${head} matches ${upstream}`);
		}
	} else lines.push("pass: package not a Git checkout (installed as a package); updates come from pi update");

	return lines;
}
