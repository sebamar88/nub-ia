import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gentlePiConfigHome } from "../lib/agent-home.ts";

// The two Pi homes: `~/.pi/agent` holds Pi's own agent definitions and
// `~/.pi/gentle-ai` holds everything the Gentle AI commands own. Both are resolved
// once and shared, because the launch-time profile pin resolver reads the same
// profiles store the `/nubia:profiles` panel writes: two spellings of the override
// would silently read two different stores.

function isolatedHome(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "gentle-pi-config-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousConfigHome = process.env.NUB_IA_CONFIG_HOME;
	const previousNubIaConfigHome = process.env.NUB_IA_CONFIG_HOME;
	// Clear the config overrides as well as isolating both OS homes.
	delete process.env.NUB_IA_CONFIG_HOME;
	delete process.env.NUB_IA_CONFIG_HOME;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousConfigHome === undefined) delete process.env.NUB_IA_CONFIG_HOME;
		else process.env.NUB_IA_CONFIG_HOME = previousConfigHome;
		if (previousNubIaConfigHome === undefined) delete process.env.NUB_IA_CONFIG_HOME;
		else process.env.NUB_IA_CONFIG_HOME = previousNubIaConfigHome;
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

test("gentlePiConfigHome honours the overrides and otherwise falls back to ~/.pi/nub-ia", (t) => {
	const home = isolatedHome(t);
	assert.equal(gentlePiConfigHome({ NUB_IA_CONFIG_HOME: "/custom/nub-ia" }), "/custom/nub-ia");
	assert.equal(gentlePiConfigHome({ NUB_IA_CONFIG_HOME: "" }), join(homedir(), ".pi", "nub-ia"));
	assert.equal(gentlePiConfigHome({}), join(homedir(), ".pi", "nub-ia"));
	assert.equal(gentlePiConfigHome(), join(homedir(), ".pi", "nub-ia"));
	assert.equal(
		join(gentlePiConfigHome(), "profiles.json"),
		join(home, ".pi", "nub-ia", "profiles.json"),
		"the store path is derived from the config home, not from the agent home",
	);
});

test("the isolated home restores defined and undefined config overrides", async (t) => {
	const previousConfigHome = process.env.NUB_IA_CONFIG_HOME;
	try {
		for (const inherited of [undefined, "/synthetic-inherited-config"]) {
			if (inherited === undefined) delete process.env.NUB_IA_CONFIG_HOME;
			else process.env.NUB_IA_CONFIG_HOME = inherited;
			await t.test(`inherited override: ${inherited === undefined ? "unset" : "set"}`, (child) => {
				const home = isolatedHome(child);
				assert.equal(process.env.NUB_IA_CONFIG_HOME, undefined);
				assert.equal(gentlePiConfigHome(), join(home, ".pi", "nub-ia"));
			});
			assert.equal(process.env.NUB_IA_CONFIG_HOME, inherited);
		}
	} finally {
		if (previousConfigHome === undefined) delete process.env.NUB_IA_CONFIG_HOME;
		else process.env.NUB_IA_CONFIG_HOME = previousConfigHome;
	}
});

test("the config home ignores the Pi agent-home overrides", (t) => {
	const home = isolatedHome(t);
	// PI_CODING_AGENT_DIR and NUB_IA_AGENT_HOME move Pi's agent directory only.
	// Reusing that resolver here would point the profiles store at the agent home.
	assert.equal(
		gentlePiConfigHome({ PI_CODING_AGENT_DIR: "/pi/agent", NUB_IA_AGENT_HOME: "/gentle/agent" }),
		join(home, ".pi", "nub-ia"),
	);
});
