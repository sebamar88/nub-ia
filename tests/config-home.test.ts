import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAnimationPolicy, writeAnimationPolicy } from "../lib/animation-policy.ts";
import { resolveBackgroundSubagentsPolicy } from "../lib/background-subagents-policy.ts";
import { resolveDoubleEscCancelPolicy } from "../lib/double-esc-cancel-policy.ts";
import { resolveHistoryCapture } from "../lib/history-capture-policy.ts";
import { quietToolsEnabled } from "../lib/quiet-tools-config.ts";
import { profilesReadFilePath, profilesFilePath } from "../lib/agent-profiles.ts";
import {
	configReadPath,
	legacyConfigHome,
	nubIaConfigHome,
	projectConfigReadPath,
	readEnv,
	resetLegacyHintForTests,
	setLegacyHintNotifier,
} from "../lib/config-home.ts";
import { repoProfileDeclarationPath, repoProfileDeclarationReadPath } from "../lib/agent-profile-pin.ts";

function tmp(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "nub-ia-config-home-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function withHints(t: test.TestContext): string[] {
	const messages: string[] = [];
	resetLegacyHintForTests();
	setLegacyHintNotifier((message) => messages.push(message));
	t.after(() => {
		setLegacyHintNotifier(undefined);
		resetLegacyHintForTests();
	});
	return messages;
}

test("readEnv returns the first defined name", () => {
	assert.equal(readEnv({ NUB_IA_X: "new" }, "NUB_IA_X"), "new");
	assert.equal(readEnv({}, "NUB_IA_X"), undefined);
});

test("config homes: NUB_IA_CONFIG_HOME, then defaults", () => {
	assert.equal(nubIaConfigHome({ NUB_IA_CONFIG_HOME: "/a" }), "/a");
	assert.match(nubIaConfigHome({}), /[\\/]\.pi[\\/]nub-ia$/);
	assert.match(legacyConfigHome(), /[\\/]\.pi[\\/]gentle-ai$/);
});

/** Point os.homedir() at `root` so the fixed legacy home (~/.pi/gentle-ai) lands inside the sandbox. */
function withHome(t: test.TestContext, root: string): void {
	const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	t.after(() => {
		if (prior.HOME === undefined) delete process.env.HOME; else process.env.HOME = prior.HOME;
		if (prior.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prior.USERPROFILE;
	});
}

test("reads prefer the nub-ia home, fall back to the legacy home, and hint once", (t) => {
	const root = tmp(t);
	withHome(t, root);
	const nub = join(root, ".pi", "nub-ia");
	const legacy = join(root, ".pi", "gentle-ai");
	mkdirSync(nub, { recursive: true });
	mkdirSync(legacy, { recursive: true });
	const env = { NUB_IA_CONFIG_HOME: nub };
	const hints = withHints(t);

	assert.equal(configReadPath(nub, "a.json", env), join(nub, "a.json"), "missing everywhere reports the canonical path");
	assert.deepEqual(hints, []);

	writeFileSync(join(legacy, "a.json"), "{}");
	assert.equal(configReadPath(nub, "a.json", env), join(legacy, "a.json"));
	assert.equal(hints.length, 1);
	assert.match(hints[0], /Nub-IA reads .*a\.json; it will be written to .*nub-ia.*a\.json on the next save/);
	writeFileSync(join(legacy, "b.json"), "{}");
	assert.equal(configReadPath(nub, "b.json", env), join(legacy, "b.json"));
	assert.equal(hints.length, 1, "at most one hint per process");

	writeFileSync(join(nub, "a.json"), "{}");
	assert.equal(configReadPath(nub, "a.json", env), join(nub, "a.json"), "the nub-ia copy wins");
});

test("project reads prefer .pi/nub-ia and fall back to .pi/gentle-ai", (t) => {
	const cwd = tmp(t);
	const hints = withHints(t);
	assert.equal(projectConfigReadPath(cwd, "p.json"), join(cwd, ".pi", "nub-ia", "p.json"));
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "gentle-ai", "p.json"), "{}");
	assert.equal(projectConfigReadPath(cwd, "p.json"), join(cwd, ".pi", "gentle-ai", "p.json"));
	assert.equal(hints.length, 1);
	mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "nub-ia", "p.json"), "{}");
	assert.equal(projectConfigReadPath(cwd, "p.json"), join(cwd, ".pi", "nub-ia", "p.json"));
});

test("policy files: legacy value is read, the next save lands in the nub-ia home", (t) => {
	const root = tmp(t);
	withHome(t, root);
	const nub = join(root, ".pi", "nub-ia");
	const legacy = join(root, ".pi", "gentle-ai");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "animations.json"), '{"schema":"gentle-pi.animations/v1","policy":"potato"}');
	const prior = { nub: process.env.NUB_IA_CONFIG_HOME };
	process.env.NUB_IA_CONFIG_HOME = nub;
	withHints(t);
	t.after(() => {
		if (prior.nub === undefined) delete process.env.NUB_IA_CONFIG_HOME; else process.env.NUB_IA_CONFIG_HOME = prior.nub;
	});

	assert.equal(resolveAnimationPolicy({ gentlePiConfigHome: nub }).policy, "potato");
	const written = writeAnimationPolicy("performance", { gentlePiConfigHome: nub });
	assert.equal(written, join(nub, "animations.json"));
	assert.equal(resolveAnimationPolicy({ gentlePiConfigHome: nub }).policy, "performance", "nub-ia copy shadows the legacy one");
});

test("profiles store: read path falls back, write path is nub-ia", (t) => {
	const root = tmp(t);
	withHome(t, root);
	const nub = join(root, ".pi", "nub-ia");
	const legacy = join(root, ".pi", "gentle-ai");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "profiles.json"), "{}");
	withHints(t);
	const prior = { nub: process.env.NUB_IA_CONFIG_HOME };
	process.env.NUB_IA_CONFIG_HOME = nub;
	t.after(() => {
		if (prior.nub === undefined) delete process.env.NUB_IA_CONFIG_HOME; else process.env.NUB_IA_CONFIG_HOME = prior.nub;
	});
	assert.equal(profilesReadFilePath(nub), join(legacy, "profiles.json"));
	assert.equal(profilesFilePath(nub), join(nub, "profiles.json"));
});

test("repository profile declaration is readable from both project dirs, nub-ia first", (t) => {
	const repo = tmp(t);
	withHints(t);
	assert.equal(repoProfileDeclarationReadPath(repo), repoProfileDeclarationPath(repo), "legacy path is the default");
	mkdirSync(join(repo, ".pi", "nub-ia"), { recursive: true });
	writeFileSync(join(repo, ".pi", "nub-ia", "profile.json"), "{}");
	assert.equal(repoProfileDeclarationReadPath(repo), join(repo, ".pi", "nub-ia", "profile.json"));
});

test("project background-subagents file is read from .pi/nub-ia before .pi/gentle-ai", (t) => {
	const cwd = tmp(t);
	const home = join(cwd, "home");
	withHints(t);
	const file = (dir: string, policy: string) => {
		mkdirSync(join(cwd, ".pi", dir), { recursive: true });
		writeFileSync(join(cwd, ".pi", dir, "background-subagents.json"), JSON.stringify({ schema: "gentle-pi.background-subagents/v1", policy }));
	};
	const env = { NUB_IA_CONFIG_HOME: home };
	file("gentle-ai", "on");
	const legacy = resolveBackgroundSubagentsPolicy(cwd, { env, gentlePiConfigHome: home });
	assert.equal(legacy.source, "project_file");
	assert.match(legacy.projectFile, /gentle-ai/);
	file("nub-ia", "off");
	const canonical = resolveBackgroundSubagentsPolicy(cwd, { env, gentlePiConfigHome: home });
	assert.match(canonical.projectFile, /nub-ia/);
});

test("NUB_IA_* env switches drive the policies", (t) => {
	const home = tmp(t);
	const base = { NUB_IA_CONFIG_HOME: home };
	assert.equal(resolveDoubleEscCancelPolicy({ env: { ...base, NUB_IA_DOUBLE_ESC_CANCEL: "off" } }).policy, "off");
	assert.equal(resolveDoubleEscCancelPolicy({ env: { ...base, NUB_IA_DOUBLE_ESC_CANCEL: "on" } }).policy, "on");

	assert.equal(resolveBackgroundSubagentsPolicy(home, { env: { ...base, NUB_IA_BACKGROUND_SUBAGENTS: "on" }, gentlePiConfigHome: home }).policy, "on");

	assert.equal(quietToolsEnabled({ NUB_IA_QUIET_TOOLS: "0" }), false);
	assert.equal(quietToolsEnabled({ NUB_IA_QUIET_TOOLS: "1" }), true);

	const off = resolveHistoryCapture({ env: { ...base, NUB_IA_HISTORY_CAPTURE: "off" }, gentlePiConfigHome: home });
	const on = resolveHistoryCapture({ env: { ...base, NUB_IA_HISTORY_CAPTURE: "on" }, gentlePiConfigHome: home });
	assert.equal(off.enabled, false);
	assert.equal(on.enabled, true);
});
