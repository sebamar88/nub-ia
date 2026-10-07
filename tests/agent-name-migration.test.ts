import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applySavedModelConfig } from "../extensions/nubia-harness.ts";
import { canonicalAgentName, describeAgentKeyMigration, LEGACY_AGENT_NAMES, migrateAgentKeys } from "../lib/agent-name-migration.ts";
import { normalizeProfilesFile, parseProfilesFileText } from "../lib/agent-profiles.ts";
import { parseAgentsConfig, resolveAgentProfile, type AgentDefinition } from "../lib/agents-config.ts";
import { installPackageAssets } from "../lib/agent-assets.ts";

test("helper: canonical names, legacy aliases and key migration", () => {
	assert.deepEqual(LEGACY_AGENT_NAMES, { "gentle-ai-explore": "nubia-explore", "gentle-ai-worker": "nubia-worker", "gentle-ai-verify": "nubia-verify" });
	assert.equal(canonicalAgentName("gentle-ai-worker"), "nubia-worker");
	assert.equal(canonicalAgentName("nubia-worker"), "nubia-worker");
	assert.equal(canonicalAgentName("explore"), "explore");
	assert.equal(canonicalAgentName("constructor"), "constructor");

	const untouched = { "nubia-worker": 1, other: 2 };
	const same = migrateAgentKeys(untouched);
	assert.equal(same.record, untouched);
	assert.deepEqual(same.migrated, []);

	const moved = migrateAgentKeys({ "gentle-ai-worker": "a", "gentle-ai-verify": "b", other: "c" });
	assert.deepEqual(moved.record, { other: "c", "nubia-worker": "a", "nubia-verify": "b" });
	assert.deepEqual(moved.migrated, ["gentle-ai-worker", "gentle-ai-verify"]);

	const conflict = migrateAgentKeys({ "gentle-ai-worker": "legacy", "nubia-worker": "canonical" });
	assert.deepEqual(conflict.record, { "nubia-worker": "canonical" });
	assert.deepEqual(conflict.migrated, ["gentle-ai-worker"]);
	assert.equal(describeAgentKeyMigration(["gentle-ai-worker"]), "Nub-IA renamed agent routing keys: gentle-ai-worker → nubia-worker");
});

function withHomes(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "agent-name-migration-"));
	const configHome = join(root, "config");
	mkdirSync(configHome, { recursive: true });
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	const previousNub = process.env.NUB_IA_CONFIG_HOME;
	delete process.env.NUB_IA_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME; else process.env.GENTLE_PI_CONFIG_HOME = previous;
		if (previousNub !== undefined) process.env.NUB_IA_CONFIG_HOME = previousNub;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, configHome };
}

test("(a) models.json legacy keys are renamed on disk once, applied under canonical names and notified once", async t => {
	const { root, configHome } = withHomes(t);
	const modelsPath = join(configHome, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ "gentle-ai-worker": { model: "a/b", thinking: "high" }, "gentle-ai-verify": "c/d", "nubia-explore": "e/f", "gentle-ai-explore": "ignored/model" }));
	const notices: string[] = [];
	const applied: Array<Record<string, unknown>> = [];
	const ctx = { cwd: root, hasUI: true, ui: { notify: (m: string) => notices.push(m) } } as unknown as Parameters<typeof applySavedModelConfig>[0];
	const apply = async (_cwd: string, config: Record<string, unknown>) => { applied.push(config); return { updated: 0, skipped: 0 }; };
	await applySavedModelConfig(ctx, apply as never);
	assert.deepEqual(Object.keys(applied[0]!).sort(), ["nubia-explore", "nubia-verify", "nubia-worker"]);
	assert.deepEqual(applied[0]!["nubia-explore"], { model: "e/f" });
	assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), { "nubia-explore": "e/f", "nubia-worker": { model: "a/b", thinking: "high" }, "nubia-verify": "c/d" });
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /^Nub-IA renamed agent routing keys: gentle-ai-worker → nubia-worker, gentle-ai-verify → nubia-verify, gentle-ai-explore → nubia-explore$/);
	await applySavedModelConfig(ctx, apply as never);
	assert.equal(notices.length, 1, "second load has nothing left to migrate");
});

test("(a) a legacy-home models.json keeps applying and is copied forward to the canonical home", async t => {
	const { root } = withHomes(t);
	const home = mkdtempSync(join(tmpdir(), "agent-name-migration-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const legacyHome = join(home, ".pi", "gentle-ai");
	const nubHome = join(home, ".pi", "nub-ia");
	mkdirSync(legacyHome, { recursive: true });
	writeFileSync(join(legacyHome, "models.json"), JSON.stringify({ "gentle-ai-worker": "a/b" }));
	const previousHome = process.env.HOME;
	const previousUser = process.env.USERPROFILE;
	delete process.env.GENTLE_PI_CONFIG_HOME;
	process.env.HOME = home; process.env.USERPROFILE = home;
	t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; if (previousUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUser; });
	const applied: Array<Record<string, unknown>> = [];
	await applySavedModelConfig({ cwd: root, hasUI: false } as never, (async (_cwd: string, config: Record<string, unknown>) => { applied.push(config); return { updated: 0, skipped: 0 }; }) as never);
	assert.deepEqual(Object.keys(applied[0]!), ["nubia-worker"]);
	assert.deepEqual(JSON.parse(readFileSync(join(nubHome, "models.json"), "utf8")), { "nubia-worker": "a/b" });
	assert.deepEqual(JSON.parse(readFileSync(join(legacyHome, "models.json"), "utf8")), { "gentle-ai-worker": "a/b" }, "the legacy file is never edited");
});

test("(b) profiles.json legacy agent keys are renamed in every profile and written back once", async t => {
	const { root, configHome } = withHomes(t);
	const profilesPath = join(configHome, "profiles.json");
	writeFileSync(profilesPath, JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profiles: { fast: { "gentle-ai-worker": "a/b" }, deep: { "gentle-ai-worker": "x/y", "nubia-worker": "keep/me", other: "o/p" } } }));
	const parsed = parseProfilesFileText(readFileSync(profilesPath, "utf8"));
	assert.equal(parsed.status, "valid");
	if (parsed.status === "valid") {
		assert.deepEqual(Object.keys(parsed.file.profiles.fast!), ["nubia-worker"]);
		assert.equal(parsed.file.profiles.deep!["nubia-worker"]!.model, "keep/me");
	}
	await applySavedModelConfig({ cwd: root, hasUI: false } as never, (async () => ({ updated: 0, skipped: 0 })) as never);
	const written = JSON.parse(readFileSync(profilesPath, "utf8")) as { profiles: Record<string, Record<string, unknown>> };
	assert.deepEqual(written.profiles.fast, { "nubia-worker": "a/b" });
	assert.deepEqual(written.profiles.deep, { "nubia-worker": "keep/me", other: "o/p" });
	assert.ok(normalizeProfilesFile(written));
});

test("(c) profile resolution falls back to the legacy key and prefers the canonical one", () => {
	const agent = { name: "nubia-worker", instructions: "", tools: [] } as unknown as AgentDefinition;
	const config = parseAgentsConfig({ model_profiles: { "gentle-ai-worker": { model: "openai/legacy", effort: "low" } } }, undefined);
	const resolved = resolveAgentProfile(agent, config);
	assert.equal(resolved.model?.id, "legacy");
	assert.equal(resolved.thinking, "low");
	const both = parseAgentsConfig({ model_profiles: { "gentle-ai-worker": { model: "openai/legacy" }, "nubia-worker": { model: "openai/current" } } }, undefined);
	assert.equal(resolveAgentProfile(agent, both).model?.id, "current");
	const handBuilt = { ...config, modelProfiles: { "gentle-ai-worker": { model: { provider: "p", id: "hand" }, thinking: undefined } } };
	assert.equal(resolveAgentProfile(agent, handBuilt).model?.id, "hand");
});

test("install retires managed legacy gentle-ai-* agent copies and keeps user-edited ones", t => {
	withHomes(t);
	const agentHome = mkdtempSync(join(tmpdir(), "agent-name-migration-agents-"));
	t.after(() => rmSync(agentHome, { recursive: true, force: true }));
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => { if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME; else process.env.GENTLE_PI_AGENT_HOME = previous; });
	mkdirSync(join(agentHome, "agents"), { recursive: true });
	// Package v0.1.0 copy of the explorer (hash recorded in managed-assets-v0.1.0.json) vs a user-edited worker.
	const legacyExplore = join(agentHome, "agents", "gentle-ai-explore.md");
	const legacyWorker = join(agentHome, "agents", "gentle-ai-worker.md");
	const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
	installPackageAssets(agentHome, true, ["delegation"]);
	assert.ok(existsSync(join(agentHome, "agents", "nubia-worker.md")));
	const migration = JSON.parse(readFileSync(new URL("../assets/migrations/managed-assets-v0.1.0.json", import.meta.url), "utf8")) as { assets: Record<string, string> };
	assert.deepEqual(Object.keys(migration.assets).sort(), ["agents/gentle-ai-explore.md", "agents/gentle-ai-verify.md", "agents/gentle-ai-worker.md"]);
	writeFileSync(legacyWorker, "user edited worker\n");
	writeFileSync(legacyExplore, "managed explore\n");
	writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, assets: {
		"agents/gentle-ai-explore.md": createHash("sha256").update("managed explore\n").digest("hex"),
		"agents/gentle-ai-worker.md": createHash("sha256").update("original worker\n").digest("hex"),
	} }));
	installPackageAssets(agentHome, true, ["delegation"]);
	assert.equal(existsSync(legacyExplore), false, "a managed legacy copy is retired");
	assert.equal(readFileSync(legacyWorker, "utf8"), "user edited worker\n", "a user-edited legacy copy is kept");
});

import { createHash } from "node:crypto";

test("bounded writer admission accepts both the nubia and the legacy worker name", async () => {
	const { isBoundedWriter, isGenericBoundedWriter } = await import("../lib/bounded-writer-admission.ts");
	for (const name of ["nubia-worker", "gentle-ai-worker"]) {
		assert.equal(isBoundedWriter(name), true);
		assert.equal(isGenericBoundedWriter(name), true);
	}
	assert.equal(isBoundedWriter("nubia-verify"), false);
});
