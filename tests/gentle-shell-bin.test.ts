import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Integration tests for the thin bin/nub-ia.mjs entry: they run the real
// file via spawnSync with an isolated HOME and a fake pi script standing in for
// the real @earendil-works/pi-coding-agent runtime, so the launcher's own logic
// (already covered at the unit level in tests/gentle-shell-launcher.test.ts)
// gets exercised end-to-end through real argv, env, and child-process wiring.

const binUrl = new URL("../bin/nub-ia.mjs", import.meta.url);
const binPath = fileURLToPath(binUrl);
const packageRoot = dirname(dirname(binPath));

test("Herdr activity is discoverable through the isolated launcher package", async () => {
	const { buildPiInvocation } = await import("../lib/gentle-shell-launcher.ts");
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.ok(manifest.pi.extensions.includes("./extensions"));
	assert.ok(existsSync(join(packageRoot, "extensions", "gentle-herdr-activity.ts")));
	for (const takeOver of [false, true]) {
		const invocation = buildPiInvocation({
			runtime: { kind: "path", command: "fake-pi", args: [] },
			home: { mode: "isolated", source: "default", dir: "/fake/home" },
			packageRoot, declaration: undefined, takeOver, otherPackagePaths: [],
			passthrough: [], baseEnv: {}, homedir: "/fake", cwd: "/fake/cwd",
		});
		assert.ok(invocation.args.includes(packageRoot));
		assert.equal(invocation.env.PI_CODING_AGENT_DIR, "/fake/home");
	}
});

test("real adjacent Pi resolves through its public entry without PATH or a runtime override", (t) => {
	const f = fixture(t);
	const result = spawnSync(process.execPath, [binPath, "--version"], {
		env: { HOME: f.home, USERPROFILE: f.home, PATH: "", GENTLE_SHELL_NO_AUTO_SETUP: "1" },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	// The adjacent peer is the release the open development range resolved,
	// not the manifest specifier.
	const installed: string = JSON.parse(readFileSync(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	assert.match(result.stdout, new RegExp(`pi ${installed.replace(/\./g, "\\.")}\\b`));
	assert.equal(existsSync(join(f.home, ".nub-ia", "agent")), false);
});

// A private copy places the launcher's resolution root outside this checkout,
// so absent-peer fallback is exercised without moving any real dependency.
function standaloneLauncher(t: test.TestContext) {
	const f = fixture(t);
	const root = join(f.root, "standalone");
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "nub-ia.mjs"), readFileSync(binPath));
	writeFileSync(join(root, "package.json"), readFileSync(join(packageRoot, "package.json")));
	for (const dir of ["runtime", "scripts"]) symlinkSync(join(packageRoot, dir), join(root, dir), "junction");
	const env = { HOME: f.home, USERPROFILE: f.home, PATH: `${root}${delimiter}${dirname(process.execPath)}`, GENTLE_SHELL_NO_AUTO_SETUP: "1", GENTLE_PI_SKIP_RTK_INSTALL: "1" };
	return { ...f, root, env, launcher: join(root, "bin", "nub-ia.mjs") };
}

test("a genuinely absent adjacent peer falls back to PATH", (t) => {
	const f = standaloneLauncher(t);
	writePiScript(join(f.root, "pi"), "0.99.2");
	const result = spawnSync(process.execPath, [f.launcher, "--version"], { env: f.env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pi 0\.99\.2/);
});

test("malformed adjacent metadata never silently falls back to PATH; env override still wins", (t) => {
	const f = standaloneLauncher(t);
	const peer = join(f.root, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(peer, "dist", "bundle"), { recursive: true });
	writeFileSync(join(peer, "dist", "index.js"), "");
	writePiScript(join(peer, "dist", "bundle", "cli.js"), "0.99.1");
	const fallback = join(f.root, "pi");
	writePiScript(fallback, "0.99.2");
	const base = { name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./dist/index.js" } }, bin: { pi: "dist/bundle/cli.js" } };
	for (const metadata of [{ ...base, name: "impostor" }, { ...base, bin: { pi: "../outside.js" } }, { ...base, bin: {} }, "malformed"]) {
		writeFileSync(join(peer, "package.json"), metadata === "malformed" ? "{" : JSON.stringify(metadata));
		const result = spawnSync(process.execPath, [f.launcher, "--version"], { env: f.env, encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
	}
	writeFileSync(join(peer, "package.json"), JSON.stringify({ ...base, name: "impostor" }));
	const override = spawnSync(process.execPath, [f.launcher, "--version"], { env: { ...f.env, GENTLE_SHELL_PI: fallback }, encoding: "utf8" });
	assert.equal(override.status, 0, override.stderr);
	assert.match(override.stdout, /pi 0\.99\.2/);
});

// The launcher's own gentle-pi version, exactly as `ownPackageVersion()` in
// bin/nub-ia.mjs reads it (package.json at packageRoot) — used to
// assert the post-install gentle-pi removal message and the provisioning
// marker's `gentlePi` field without hardcoding this package's own version.
function ownGentlePiVersion(): string {
	return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

// GENTLE_SHELL_NO_AUTO_SETUP=1 is in the base fixture env so every test that
// is not itself about auto-provisioning (S7) keeps today's plain-launch
// behavior: without it, every fixture-driven test against a fresh isolated
// home would run `pi install` for the team packages (network, mutating
// state). The auto-provision test section below opts back in per test via
// enableAutoProvision.
function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "gentle-shell-bin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const piScript = join(root, "fake-pi.mjs");
	writePiScript(piScript, "0.99.1");
	const gentleShellHome = join(root, "gentle-shell-home");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GENTLE_SHELL_HOME: gentleShellHome,
		GENTLE_SHELL_PI: piScript,
		GENTLE_SHELL_NO_AUTO_SETUP: "1",
		// Never download rtk from a test; the self-heal has its own tests.
		GENTLE_PI_SKIP_RTK_INSTALL: "1",
		// Team companion packages are exercised by their own tests below; every
		// other setup test keeps a deterministic install sequence.
		GENTLE_SHELL_TEAM_PACKAGES: "",
	};
	return { root, home, gentleShellHome, piScript, env };
}

// Removes the fixture's default GENTLE_SHELL_NO_AUTO_SETUP=1 opt-out, for a
// test that specifically exercises auto-provisioning (S7).
function enableAutoProvision(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { GENTLE_SHELL_NO_AUTO_SETUP, ...rest } = env;
	return rest;
}

// `removeExitCode` controls only the `pi remove ...` branch exercised by the
// setup-subcommand conflict-cleanup tests below; every other pi invocation
// (including the version probe) keeps exiting 0, unchanged for every
// existing caller that does not pass it.
function writePiScript(path: string, version: string, removeExitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			`if (args.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }`,
			"if (args[0] === 'remove') {",
			"  console.log(JSON.stringify({",
			"    args,",
			"    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
			"    GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,",
			"    PATH: process.env.PATH,",
			"  }));",
			`  process.exit(${removeExitCode});`,
			"}",
			"console.log(JSON.stringify({",
			"  args,",
			"  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
			"  GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,",
			"  GENTLE_SHELL_USER_PI_HOME: process.env.GENTLE_SHELL_USER_PI_HOME,",
			"  GENTLE_SHELL_CHILD_PACKAGE_INJECTION: process.env.GENTLE_SHELL_CHILD_PACKAGE_INJECTION,",
			"}));",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

function run(env: NodeJS.ProcessEnv, args: string[], options: { cwd?: string } = {}) {
	return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", env, ...options });
}

// Herdr tests model terminal/socket metadata only: no socket is opened and the
// real managed bridge is never imported. The fake pi records launch resources.
function herdrFixture(t: test.TestContext) {
	const f = fixture(t);
	const bridge = join(f.home, ".pi", "agent", "extensions", "herdr-agent-state.ts");
	mkdirSync(dirname(bridge), { recursive: true });
	writeFileSync(bridge, "export default function () {}\n");
	const socket = join(f.root, "mock-herdr.sock");
	const preload = join(f.root, "terminal-and-socket.cjs");
	writeFileSync(preload, [
		"const fs = require('node:fs');",
		"const { syncBuiltinESMExports } = require('node:module');",
		"const originalStat = fs.statSync;",
		"fs.statSync = (path, ...args) => path === process.env.HERDR_SOCKET_PATH",
		"  ? { isSocket: () => process.env.TEST_SOCKET_VALID === '1' } : originalStat(path, ...args);",
		"process.stdin.isTTY = process.env.TEST_STDIN_TTY === '1';",
		"process.stdout.isTTY = process.env.TEST_STDOUT_TTY === '1';",
		"require('node:net').createConnection = () => { throw new Error('Live socket forbidden'); };",
		"syncBuiltinESMExports();",
	].join("\n"));
	const env: NodeJS.ProcessEnv = {
		...f.env,
		HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "mock-pane",
		TEST_SOCKET_VALID: "1", TEST_STDIN_TTY: "1", TEST_STDOUT_TTY: "1",
	};
	delete env.GENTLE_PI_AGENTS_CHILD;
	// Keep parent agent-home inheritance out of every portable test fixture.
	delete env.PI_CODING_AGENT_DIR;
	const launch = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => {
		const result = spawnSync(process.execPath, ["--require", preload, binPath, ...args], {
			encoding: "utf8", env: { ...env, ...overrides }, cwd: f.root,
		});
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout).args as string[];
	};
	return { ...f, bridge, env, launch };
}

function extensionPaths(args: string[]): string[] {
	return args.flatMap((arg, i) => arg === "-e" || arg === "--extension" ? [args[i + 1]] : []);
}

test("Herdr isolated TUI launch explicitly loads the canonical managed bridge", (t) => {
	const f = herdrFixture(t);
	assert.ok(extensionPaths(f.launch()).includes(realpathSync(f.bridge)));
	assert.equal(readFileSync(f.bridge, "utf8"), "export default function () {}\n");
});

test("Herdr prefers the incoming agent-home bridge and falls back to the conventional home", (t) => {
	const f = herdrFixture(t);
	const previousHome = join(f.root, "previous-agent");
	const previousBridge = join(previousHome, "extensions", "herdr-agent-state.ts");
	mkdirSync(dirname(previousBridge), { recursive: true });
	writeFileSync(previousBridge, "export default function () {}\n");
	const previousPaths = extensionPaths(f.launch([], { PI_CODING_AGENT_DIR: previousHome }));
	assert.ok(previousPaths.includes(realpathSync(previousBridge)));
	assert.ok(!previousPaths.includes(realpathSync(f.bridge)));
	assert.ok(extensionPaths(f.launch([], { PI_CODING_AGENT_DIR: f.gentleShellHome })).includes(realpathSync(f.bridge)));
	const selectedBridge = join(f.gentleShellHome, "extensions", "herdr-agent-state.ts");
	mkdirSync(dirname(selectedBridge), { recursive: true });
	writeFileSync(selectedBridge, "export default function () {}\n");
	const selectedPaths = extensionPaths(f.launch([], { PI_CODING_AGENT_DIR: previousHome }));
	assert.ok(selectedPaths.includes(realpathSync(selectedBridge)));
	assert.ok(!selectedPaths.includes(realpathSync(previousBridge)));
	assert.ok(!selectedPaths.includes(realpathSync(f.bridge)));
});

test("Herdr bridge injection respects disabled extensions, headless modes and child launches", (t) => {
	const f = herdrFixture(t);
	for (const args of [["--no-extensions"], ["-ne"], ["-p", "prompt"], ["--print", "prompt"],
		["--mode", "rpc"], ["--mode", "json"], ["--export", "session.jsonl"], ["--list-models"],
		["--link"], ["--home", f.gentleShellHome], ["list"]]) {
		assert.ok(!extensionPaths(f.launch(args)).includes(realpathSync(f.bridge)), JSON.stringify(args));
	}
	for (const overrides of [{ HERDR_ENV: "0" }, { HERDR_ENV: undefined }, { HERDR_PANE_ID: "" },
		{ HERDR_SOCKET_PATH: "" }, { TEST_SOCKET_VALID: "0" }, { TEST_STDIN_TTY: "0" },
		{ TEST_STDOUT_TTY: "0" }, { GENTLE_PI_AGENTS_CHILD: "1" }]) {
		assert.ok(!extensionPaths(f.launch([], overrides)).includes(realpathSync(f.bridge)), JSON.stringify(overrides));
	}
	assert.ok(extensionPaths(f.launch(["--mode", "text"])).includes(realpathSync(f.bridge)));
});

test("Herdr absent bridge is nonfatal and explicit resources are preserved", (t) => {
	const f = herdrFixture(t);
	const absentHome = join(f.root, "empty-home");
	mkdirSync(absentHome);
	assert.ok(!extensionPaths(f.launch([], { HOME: absentHome, USERPROFILE: absentHome })).includes(realpathSync(f.bridge)));
	const alias = join(f.root, "bridge-alias.ts");
	symlinkSync(f.bridge, alias);
	const args = f.launch(["-e", alias]);
	assert.ok(extensionPaths(args).includes(alias));
	assert.ok(extensionPaths(args).includes(realpathSync(f.bridge)));
	const disabled = f.launch(["--no-extensions", "-e", alias]);
	assert.ok(extensionPaths(disabled).includes(alias));
	assert.ok(!extensionPaths(disabled).includes(realpathSync(f.bridge)));
});

test("Pi real resource loader deduplicates the bridge across discovery, explicit files and package directories", async (t) => {
	const { DefaultResourceLoader, SettingsManager, createEventBus } = await import("@earendil-works/pi-coding-agent");
	for (const scenario of ["discovered", "explicit", "directory"] as const) {
		const f = fixture(t);
		const agentDir = join(f.home, ".pi", "agent");
		const bridge = join(agentDir, "extensions", "herdr-agent-state.ts");
		mkdirSync(dirname(bridge), { recursive: true });
		writeFileSync(bridge, "export default function (pi) { pi.events.emit('mock:bridge-loaded', {}); }\n");
		const canonical = realpathSync(bridge);
		const alias = join(f.root, "alias.ts");
		symlinkSync(bridge, alias);
		writeFileSync(join(agentDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/herdr-agent-state.ts"] } }));
		const eventBus = createEventBus();
		let factoryCalls = 0;
		eventBus.on("mock:bridge-loaded", () => { factoryCalls++; });
		const additionalExtensionPaths = scenario === "explicit" ? [alias, canonical, canonical]
			: scenario === "directory" ? [agentDir, canonical] : [canonical];
		const loader = new DefaultResourceLoader({ cwd: f.root, agentDir, eventBus,
			settingsManager: SettingsManager.inMemory({ extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"] }),
			additionalExtensionPaths, noExtensions: scenario !== "discovered", noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, [], scenario);
		assert.equal(loaded.extensions.length, 1, scenario);
		assert.equal(factoryCalls, 1, scenario);
	}
});

test("--help exits 0 and prints usage", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage: nub-ia/);
});

test("home with no args prints the default isolated home", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["home"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), `isolated ${f.gentleShellHome}`);
});

test("home link persists and a later home reflects it", (t) => {
	const f = fixture(t);
	const save = run(f.env, ["home", "link"]);
	assert.equal(save.status, 0, save.stderr);
	const configPath = join(f.home, ".nub-ia", "config.json");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { home: "link" });
	const check = run(f.env, ["home"]);
	assert.equal(check.status, 0, check.stderr);
	assert.match(check.stdout, /^link /);
});

test("home <path> persists a custom directory", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const save = run(f.env, ["home", target]);
	assert.equal(save.status, 0, save.stderr);
	const configPath = join(f.home, ".nub-ia", "config.json");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { home: target });
	const check = run(f.env, ["home"]);
	assert.equal(check.stdout.trim(), `path ${target}`);
});

// Test/development-only: GENTLE_SHELL_CONFIG overrides the launcher
// config.json path (normally <homedir>/.nub-ia/config.json), so a test
// or a field run against the real HOME (for example the packed-artifact E2E
// script, which needs `--link` probes against the real pi home) never
// touches the real ~/.nub-ia/config.json. Documented as
// test/development-only in docs/readme-reference.md.
test("GENTLE_SHELL_CONFIG redirects the config.json path used by 'home' and auto-provisioning", (t) => {
	const f = fixture(t);
	const overridePath = join(f.root, "alt-config.json");
	const env = { ...f.env, GENTLE_SHELL_CONFIG: overridePath };

	const save = run(env, ["home", "link"]);
	assert.equal(save.status, 0, save.stderr);
	assert.deepEqual(JSON.parse(readFileSync(overridePath, "utf8")), { home: "link" });
	assert.equal(existsSync(join(f.home, ".nub-ia", "config.json")), false);

	const check = run(env, ["home"]);
	assert.match(check.stdout, /^link /);
});

test("first isolated run bootstraps the home, writes fullscreen, and prints the hint once", (t) => {
	const f = fixture(t);
	assert.equal(existsSync(f.gentleShellHome), false);

	const first = run(f.env, []);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stderr, /using a separate home at/);
	assert.match(first.stderr, /nub-ia --link/);
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.equal(settings.tuiMode, "fullscreen");

	const second = run(f.env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stderr, /using a separate home at/);
});

test("forwarded args reach pi after the injected extension flags, in order", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--mode", "rpc", "-p", "hi"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		packageRoot,
		"--mode",
		"rpc",
		"-p",
		"hi",
	]);
	assert.equal(payload.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
});

// #1690: the spawned pi must carry the launcher's own -e set so the subagent
// runner can forward it to delegated children; a stale inherited value is replaced.
test("an isolated launch without a gentle-pi declaration signals its package injection to pi", (t) => {
	const f = fixture(t);
	const stale = JSON.stringify({ version: 1, noExtensions: true, extensionPaths: [join(f.root, "outer")] });
	for (const inherited of [undefined, stale]) {
		const result = run({ ...f.env, GENTLE_SHELL_CHILD_PACKAGE_INJECTION: inherited }, ["--mode", "rpc"]);
		assert.equal(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.deepEqual(payload.args.slice(0, 2), ["-e", packageRoot]);
		assert.deepEqual(JSON.parse(payload.GENTLE_SHELL_CHILD_PACKAGE_INJECTION), { version: 1, noExtensions: false, extensionPaths: [packageRoot] });
	}
});

test("an isolated launch keeps its own agent home and carries the user's original Pi home, even when nested", (t) => {
	const f = fixture(t);
	const base = { ...f.env };
	delete base.PI_CODING_AGENT_DIR;
	delete base.GENTLE_SHELL_USER_PI_HOME;
	const launch = (overrides: NodeJS.ProcessEnv, args: string[] = []) => {
		const result = run({ ...base, ...overrides }, [...args, "--mode", "rpc"]);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	const conventional = launch({});
	assert.equal(conventional.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(conventional.GENTLE_SHELL_USER_PI_HOME, join(f.home, ".pi", "agent"));
	const customHome = join(f.root, "custom-pi");
	const custom = launch({ PI_CODING_AGENT_DIR: customHome });
	assert.equal(custom.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(custom.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
	assert.equal(custom.GENTLE_SHELL_USER_PI_HOME, customHome);
	// A nub-ia started from inside a Nub-IA session inherits both variables.
	const nested = launch({ PI_CODING_AGENT_DIR: custom.PI_CODING_AGENT_DIR, GENTLE_SHELL_USER_PI_HOME: custom.GENTLE_SHELL_USER_PI_HOME });
	assert.equal(nested.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(nested.GENTLE_SHELL_USER_PI_HOME, customHome);
	const linked = launch({ PI_CODING_AGENT_DIR: customHome }, ["--link"]);
	assert.equal(linked.PI_CODING_AGENT_DIR, customHome);
	assert.equal(linked.GENTLE_SHELL_USER_PI_HOME, customHome);
	assert.equal(existsSync(join(customHome, "sessions")), false);
});

test("--link skips injection and leaves settings.json byte-identical when it already declares gentle-pi", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = '{"packages":["npm:gentle-pi"],"theme":"kept"}';
	writeFileSync(settingsPath, settingsText);
	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };

	const result = run(env, ["--link", "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--mode", "rpc"]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
	assert.equal(payload.PI_CODING_AGENT_DIR, piAgentDir);
	assert.equal(existsSync(join(piAgentDir, ".nub-ia")), false);
});

// --- injection skip for isolated/--home homes once they declare gentle-pi (S3) ---
//
// `nub-ia setup` installs npm:gentle-pi into the home's settings.json;
// once that declaration exists, isolated and --home homes must stop
// injecting the launcher's own copy on top of it, the same way --link
// already does. Homes without a declaration keep the plain injection.

test("an isolated home whose settings.json declares npm:gentle-pi gets no injection", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["npm:gentle-pi@3.5.1"], tuiMode: "fullscreen" }));

	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--mode", "rpc"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("an isolated home whose settings.json does not declare gentle-pi keeps the plain injection", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));

	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
});

test("an isolated home whose settings.json declares a path-based gentle-pi takes over, same as --link", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"], tuiMode: "fullscreen" }));

	const result = run(f.env, ["--mode", "rpc"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from/);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
});

test("nub-ia list forwards to pi as a bare subcommand, with no injected extension flags", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["list"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["list"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("nub-ia install npm:<pkg> forwards the subcommand and its argument verbatim", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["install", "npm:pi-btw"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "npm:pi-btw"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("a too-old pi exits 1 naming both versions", (t) => {
	const f = fixture(t);
	writePiScript(f.piScript, "0.80.0");
	const result = run(f.env, []);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /0\.80\.0/);
	assert.match(result.stderr, /0\.99\.1/);
});

test("--version prints three lines", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--version"]);
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.trim().split("\n");
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^nub-ia /);
	assert.match(lines[1], /^pi 0\.99\.1$/);
	assert.match(lines[2], /^home isolated /);
});

// --- setup subcommand ------------------------------------------------------

// --- provisioning fake pi ------------------------------------------------------
//
// `setup` and the automatic first-run flow install the team packages through
// pi's own `install`. This fake pi answers `--version`, records every
// `install <source>` to `log` (one JSON line per run), and can fail, hang, or
// run extra JavaScript (for example to rewrite settings.json) on install. Any
// other invocation prints its args as JSON, like the plain fixture pi.

const CHILD_READY_TOKEN = "GENTLE_SHELL_TEST_CHILD_READY";

function writeProvisioningPi(
	path: string,
	options: { log?: string; installExit?: number; installSleepMs?: number; installJs?: string; signalSelf?: boolean } = {},
) {
	const { log, installExit = 0, installSleepMs = 0, installJs = "", signalSelf = false } = options;
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"const args = process.argv.slice(2);",
			'if (args.includes("--version")) { console.log("0.99.1"); process.exit(0); }',
			"const record = { args, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME };",
			"if (args[0] === 'install') {",
			`  const log = ${JSON.stringify(log ?? null)};`,
			"  if (log) appendFileSync(log, JSON.stringify(record) + '\\n');",
			`  process.stderr.write(${JSON.stringify(CHILD_READY_TOKEN)} + '\\n');`,
			`  ${signalSelf ? "process.kill(process.pid, 'SIGKILL');" : ""}`,
			`  ${installJs}`,
			`  if (${installSleepMs} > 0) await new Promise((resolve) => setTimeout(resolve, ${installSleepMs}));`,
			"  console.log(JSON.stringify(record));",
			`  process.exit(${installExit});`,
			"}",
			"console.log(JSON.stringify({ ...record, GENTLE_SHELL_USER_PI_HOME: process.env.GENTLE_SHELL_USER_PI_HOME }));",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

const TEAM = "npm:example-a";

// A provisioning environment: fake pi plus a single deterministic team package.
function provisioning(f: ReturnType<typeof fixture>, options: Parameters<typeof writeProvisioningPi>[1] = {}, extra: NodeJS.ProcessEnv = {}) {
	const script = join(f.root, "fake-pi-provisioning.mjs");
	writeProvisioningPi(script, options);
	return { ...f.env, GENTLE_SHELL_PI: script, GENTLE_SHELL_TEAM_PACKAGES: TEAM, ...extra };
}

function installRuns(log: string): string[] {
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0) : [];
}

function jsonRecords(stdout: string): Array<{ args: string[]; PI_CODING_AGENT_DIR?: string }> {
	return stdout.split(/(?<=\})\s*(?=\{)/).map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0).map((chunk) => JSON.parse(chunk));
}

const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- setup subcommand installs the team companion packages ------------------

test("nub-ia setup installs the packaged team packages via pi's own install, in the resolved home", (t) => {
	const f = fixture(t);
	const env = provisioning(f);
	delete env.GENTLE_SHELL_TEAM_PACKAGES;

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /nub-ia: installing team package npm:@dietrichgebert\/ponytail into /);
	const records = jsonRecords(result.stdout);
	assert.equal(records.length, 1, result.stdout);
	assert.deepEqual(records[0].args, ["install", "npm:@dietrichgebert/ponytail"]);
	assert.equal(records[0].PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("nub-ia setup never spawns a gentle-ai binary", (t) => {
	const f = fixture(t);
	const env = provisioning(f, {}, { GENTLE_SHELL_GENTLE_AI_BIN: join(f.root, "must-not-run") });
	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /gentle-ai/);
});

test("nub-ia setup skips team packages the home already declares, at any version", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["npm:@dietrichgebert/ponytail@4.12.0"] }));
	const env = provisioning(f);
	delete env.GENTLE_SHELL_TEAM_PACKAGES;

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /installing team package/);
	assert.equal(jsonRecords(result.stdout).length, 0, "nothing to install");
});

test("GENTLE_SHELL_TEAM_PACKAGES overrides the packaged team list and --dry-run reports it without installing", (t) => {
	const f = fixture(t);
	const env = provisioning(f, {}, { GENTLE_SHELL_TEAM_PACKAGES: "npm:example-a, git:github.com/x/y" });

	const dry = run(env, ["setup", "--dry-run"]);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stderr, /setup would then install team package npm:example-a unless/);
	assert.match(dry.stderr, /setup would then install team package git:github.com\/x\/y unless/);
	assert.equal(jsonRecords(dry.stdout).length, 0, "dry run spawns nothing");

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(jsonRecords(result.stdout).map((record) => record.args), [["install", "npm:example-a"], ["install", "git:github.com/x/y"]]);
});

test("nub-ia setup accepts a home selector before it and provisions that home", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const result = run(provisioning(f), ["--home", target, "setup"]);
	assert.equal(result.status, 0, result.stderr);
	const [record] = jsonRecords(result.stdout);
	assert.equal(record.PI_CODING_AGENT_DIR, target);
});

test("nub-ia setup propagates a failing pi install's exit code with an actionable retry command", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const result = run(provisioning(f, { installExit: 7 }), ["--home", target, "setup"]);
	assert.equal(result.status, 7);
	assert.match(result.stderr, new RegExp(`nub-ia: could not install ${escapeForRegExp(TEAM)}; run \`nub-ia --home ${escapeForRegExp(target)} install ${escapeForRegExp(TEAM)}\` to retry`));
});

test("nub-ia setup shell-quotes a --home path containing a space in the retry command", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom home");
	const result = run(provisioning(f, { installExit: 3 }), ["--home", target, "setup"]);
	assert.equal(result.status, 3);
	assert.match(result.stderr, new RegExp(`nub-ia --home '${escapeForRegExp(target)}' install`));
});

test("manual setup never times out even past the auto-mode ceiling override", (t) => {
	const f = fixture(t);
	const env = provisioning(f, { installSleepMs: 300 }, { GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS: "50" });
	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /timed out/);
});

// --- automatic first-run provisioning ----------------------------------------

test("first launch auto-provisions the isolated home, writes the marker, then launches pi; stdout carries only pi's output", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const env = enableAutoProvision(provisioning(f, { log }));

	const result = run(env, ["--mode", "rpc", "-p", "hi"]);
	assert.equal(result.status, 0, result.stderr);

	const runs = installRuns(log);
	assert.equal(runs.length, 1, log);
	assert.deepEqual(JSON.parse(runs[0]).args, ["install", TEAM]);

	// stdout carries only the final pi invocation's own output (the flow's
	// stdout and stderr, and the launcher's own notices, all went to stderr).
	const stdoutLines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
	assert.equal(stdoutLines.length, 1, result.stdout);
	assert.deepEqual(JSON.parse(stdoutLines[0]).args.slice(-4), ["--mode", "rpc", "-p", "hi"]);

	assert.match(result.stderr, /nub-ia: first run in .+: installing the team packages \(one time; set GENTLE_SHELL_NO_AUTO_SETUP=1 to skip\)/);

	const config = JSON.parse(readFileSync(join(f.home, ".nub-ia", "config.json"), "utf8"));
	const homeKey = realpathSync(f.gentleShellHome);
	assert.equal(config.provisioned[homeKey].gentleAi, undefined, "new markers never carry a gentle-ai pin");
	assert.equal(config.provisioned[homeKey].gentlePi, ownGentlePiVersion());
	assert.equal(typeof config.provisioned[homeKey].at, "string");
	assert.equal(existsSync(join(f.gentleShellHome, ".nub-ia-setup.lock")), false);
});

test("a second launch against an already-provisioned home skips the flow entirely", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const env = enableAutoProvision(provisioning(f, { log }));

	assert.equal(run(env, []).status, 0);
	assert.equal(installRuns(log).length, 1);

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stderr, /nub-ia: first run in/);
	assert.doesNotMatch(second.stderr, /nub-ia changed/);
	assert.equal(installRuns(log).length, 1, "the flow must not run a second time");
});

test("a marker without a gentlePi field re-runs the flow and backfills it", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const env = enableAutoProvision(provisioning(f, { log }));
	assert.equal(run(env, []).status, 0);

	const configPath = join(f.home, ".nub-ia", "config.json");
	const homeKey = realpathSync(f.gentleShellHome);
	const staleConfig = JSON.parse(readFileSync(configPath, "utf8"));
	delete staleConfig.provisioned[homeKey].gentlePi;
	writeFileSync(configPath, JSON.stringify(staleConfig));

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(installRuns(log).length, 2, "the flow must re-run once the marker predates version tracking");
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).provisioned[homeKey].gentlePi, ownGentlePiVersion());
});

test("a legacy marker that still carries a gentle-ai pin re-runs the flow once and drops the field", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const env = enableAutoProvision(provisioning(f, { log }));
	assert.equal(run(env, []).status, 0);

	const configPath = join(f.home, ".nub-ia", "config.json");
	const homeKey = realpathSync(f.gentleShellHome);
	const legacyConfig = JSON.parse(readFileSync(configPath, "utf8"));
	legacyConfig.provisioned[homeKey].gentleAi = "3.6.0";
	writeFileSync(configPath, JSON.stringify(legacyConfig));

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(installRuns(log).length, 2, "a legacy marker needs provisioning once");
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).provisioned[homeKey].gentleAi, undefined);

	const third = run(env, []);
	assert.equal(third.status, 0, third.stderr);
	assert.equal(installRuns(log).length, 2, "the rewritten marker no longer re-runs");
});

test("a changed nub-ia version re-runs the flow and prints the changed line", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const env = enableAutoProvision(provisioning(f, { log }));
	assert.equal(run(env, []).status, 0);

	const configPath = join(f.home, ".nub-ia", "config.json");
	const homeKey = realpathSync(f.gentleShellHome);
	const staleConfig = JSON.parse(readFileSync(configPath, "utf8"));
	staleConfig.provisioned[homeKey].gentlePi = "0.0.0-previous-launcher";
	writeFileSync(configPath, JSON.stringify(staleConfig));

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stderr, new RegExp(`nub-ia changed \\(0\\.0\\.0-previous-launcher -> ${escapeForRegExp(ownGentlePiVersion())}\\): updating`));
	assert.equal(installRuns(log).length, 2);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).provisioned[homeKey].gentlePi, ownGentlePiVersion());
});

test("a failing auto-provision flow warns, still launches pi, and writes no marker", (t) => {
	const f = fixture(t);
	const env = enableAutoProvision(provisioning(f, { installExit: 5 }));

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /nub-ia: automatic setup failed \(exit 5\); starting anyway and retrying next run\. Run `nub-ia setup` to see the full output\./);
	assert.match(result.stderr, /nub-ia: could not install npm:example-a/);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!).args.slice(-2), ["--mode", "rpc"]);

	const configPath = join(f.home, ".nub-ia", "config.json");
	if (existsSync(configPath)) assert.equal(JSON.parse(readFileSync(configPath, "utf8")).provisioned, undefined);
});

test("a failing auto-provision flow names the --home selector in its retry remediation", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const env = enableAutoProvision(provisioning(f, { installExit: 5 }));

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, new RegExp(`Run \`nub-ia --home ${escapeForRegExp(target)} setup\` to see the full output\\.`));
});

test("GENTLE_SHELL_NO_AUTO_SETUP=1 skips auto-provisioning entirely", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const result = run(provisioning(f, { log }), []);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 0);
	assert.equal(existsSync(join(f.home, ".nub-ia", "config.json")), false);
});

test("--link never auto-provisions", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	const log = join(f.root, "install-runs.log");
	const env = enableAutoProvision(provisioning(f, { log }, { PI_CODING_AGENT_DIR: piAgentDir }));

	const result = run(env, ["--link", "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 0);
	assert.equal(existsSync(join(piAgentDir, ".nub-ia-setup.lock")), false);
});

test("a pi subcommand (list) never auto-provisions", (t) => {
	const f = fixture(t);
	const log = join(f.root, "install-runs.log");
	const result = run(enableAutoProvision(provisioning(f, { log })), ["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 0);
	assert.deepEqual(JSON.parse(result.stdout).args, ["list"]);
});

test("a fresh concurrent lock skips auto-provisioning for this run, without removing the lock", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const lockPath = join(f.gentleShellHome, ".nub-ia-setup.lock");
	writeFileSync(lockPath, "");
	const log = join(f.root, "install-runs.log");

	const result = run(enableAutoProvision(provisioning(f, { log })), ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 0);
	assert.match(result.stderr, /already provisioning/);
	assert.equal(existsSync(lockPath), true);
});

test("a stale lock (older than 15 minutes) is removed and auto-provisioning proceeds", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const lockPath = join(f.gentleShellHome, ".nub-ia-setup.lock");
	writeFileSync(lockPath, "");
	const staleTime = new Date(Date.now() - 16 * 60 * 1000);
	utimesSync(lockPath, staleTime, staleTime);
	const log = join(f.root, "install-runs.log");

	const result = run(enableAutoProvision(provisioning(f, { log })), ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 1);
	assert.equal(existsSync(lockPath), false, "the lock must be released once the flow completes");
});

// --- auto-provisioning only touches homes nub-ia owns (R1-001) -------

test("a --home pointing at an existing non-empty, unmarked directory is never auto-provisioned", (t) => {
	const f = fixture(t);
	const target = join(f.root, "existing-pi-home");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "settings.json"), JSON.stringify({}));
	const log = join(f.root, "install-runs.log");

	const result = run(enableAutoProvision(provisioning(f, { log })), ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 0, "the install must never run against a foreign, unmarked home");
	assert.match(result.stderr, new RegExp(`nub-ia: ${escapeForRegExp(target)} already has content and was not set up by nub-ia`));
	assert.match(result.stderr, new RegExp(`run \`nub-ia --home ${escapeForRegExp(target)} setup\` to provision it`));
});

test("an empty or nonexistent --home is still auto-provisioned", (t) => {
	const f = fixture(t);
	const target = join(f.root, "brand-new-home");
	const log = join(f.root, "install-runs.log");

	const result = run(enableAutoProvision(provisioning(f, { log })), ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 1, "a fresh --home must still be auto-provisioned");
});

test("a --home equal to pi's own default agent home is never auto-provisioned, even when empty", (t) => {
	const f = fixture(t);
	const defaultPiHome = join(f.home, ".pi", "agent");
	const log = join(f.root, "install-runs.log");
	// Exercise the default Pi home, not an ambient PI_CODING_AGENT_DIR override.
	const env = enableAutoProvision(provisioning(f, { log }, { PI_CODING_AGENT_DIR: undefined }));

	const result = run(env, ["--home", defaultPiHome, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(installRuns(log).length, 0, "the install must never run against pi's own default agent home");
	assert.match(result.stderr, /never auto-provisions it/);
});

// --- --home ownership marker and retry after a failed first attempt (R3-001) -----

test("a freshly bootstrapped isolated or --home directory gets a nub-ia ownership marker file", (t) => {
	const f = fixture(t);
	const target = join(f.root, "marked-home");
	const result = run(f.env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const marker = JSON.parse(readFileSync(join(target, ".nub-ia-home"), "utf8"));
	assert.equal(marker.createdBy, "nub-ia");
	assert.equal(marker.version, ownGentlePiVersion());
});

test("a --home directory nub-ia itself bootstrapped is retried after its first auto-provision attempt fails", (t) => {
	const f = fixture(t);
	const target = join(f.root, "retry-home");

	const first = run(enableAutoProvision(provisioning(f, { installExit: 1 })), ["--home", target, "--mode", "rpc"]);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stderr, /nub-ia: automatic setup failed/);
	assert.ok(existsSync(join(target, "settings.json")), "bootstrap must have seeded settings.json before the failed attempt");
	assert.ok(existsSync(join(target, ".nub-ia-home")), "bootstrap must mark the home as nub-ia-owned");

	const log = join(f.root, "install-runs.log");
	const second = run(enableAutoProvision(provisioning(f, { log })), ["--home", target, "--mode", "rpc"]);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stderr, /already has content and was not set up by nub-ia/);
	assert.equal(installRuns(log).length, 1, "the retry must actually run the install against the previously-failed home");
});

// --- auto-provisioning interrupts, resilience, timeouts, atomic writes -----

// Waits until `child`'s stderr has emitted a line matching `pattern`, so a
// test can send a signal only once the flow has actually started (never
// racing the signal against the child process not existing yet).
function waitForStderrMatch(child, pattern) {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const onData = (chunk) => {
			buffer += chunk.toString("utf8");
			if (pattern.test(buffer)) {
				child.stderr.off("data", onData);
				resolve(buffer);
			}
		};
		child.stderr.on("data", onData);
		child.once("error", reject);
	});
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

test("SIGINT during automatic provisioning kills the child and exits 130 without launching pi", { timeout: 10000 }, async (t) => {
	const f = fixture(t);
	const env = enableAutoProvision(provisioning(f, { installSleepMs: 20000 }));

	const child = spawn(process.execPath, [binPath, "--mode", "rpc", "-p", "hi"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});

	// The child writes the token the instant it starts, so the signal can only
	// arrive once spawnAndWait's forwarding listeners exist.
	await waitForStderrMatch(child, new RegExp(CHILD_READY_TOKEN));
	child.kill("SIGINT");
	const { code, signal } = await waitForExit(child);

	assert.equal(signal, null, "the launcher process itself must exit normally, not be killed by the signal");
	assert.equal(code, 130);
	assert.equal(stdout.trim(), "", "pi must never launch once an auto-provision spawn was interrupted");
});

test("a child that dies by a signal on its own during automatic provisioning is an ordinary failure, not a launcher interrupt: pi still launches", (t) => {
	const f = fixture(t);
	const result = run(enableAutoProvision(provisioning(f, { signalSelf: true })), ["--mode", "rpc", "-p", "hi"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /nub-ia: automatic setup failed/);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!).args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
});

test(
	"an unexpected error writing the provisioning marker (e.g. an unwritable config directory) still launches pi",
	{ skip: process.platform === "win32" ? "chmod-based write restriction is not portable to Windows" : false },
	(t) => {
		const f = fixture(t);
		// Only the config directory's parent is read+execute, so the marker write
		// (run after a successful install) fails with EACCES.
		const restrictedRoot = join(f.root, "locked-config-root");
		mkdirSync(restrictedRoot, { recursive: true });
		const configPath = join(restrictedRoot, ".nub-ia", "config.json");
		chmodSync(restrictedRoot, 0o500);

		const env = enableAutoProvision(provisioning(f, {}, { GENTLE_SHELL_CONFIG: configPath }));
		const result = run(env, ["--mode", "rpc", "-p", "hi"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /nub-ia: automatic setup failed unexpectedly/);
		assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!).args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
	},
);

test("a hung install during automatic provisioning is killed after the timeout ceiling, treated as a failure, and pi still launches", (t) => {
	const f = fixture(t);
	const env = enableAutoProvision(provisioning(f, { installSleepMs: 60000 }, { GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS: "300" }));

	const started = Date.now();
	const result = run(env, ["--mode", "rpc", "-p", "hi"]);
	const elapsed = Date.now() - started;
	assert.equal(result.status, 0, result.stderr);
	assert.ok(elapsed < 15000, `expected the hung child to be killed quickly, took ${elapsed}ms`);
	assert.match(result.stderr, /nub-ia: automatic setup failed/);
	// The message reports the effective ceiling (300ms is not a whole number of
	// minutes, so it renders in seconds).
	assert.match(result.stderr, /pi install npm:example-a timed out after 0\.3 seconds/);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!).args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
});

test("the provisioning marker write leaves no stray temp file behind", (t) => {
	const f = fixture(t);
	const result = run(enableAutoProvision(provisioning(f)), []);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readdirSync(join(f.home, ".nub-ia")), ["config.json"]);
});

// --- default Nub-IA theme -------------------------------------------

test("a freshly bootstrapped home defaults to the Nub-IA theme", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.equal(settings.theme, "Nub-IA");
});

const SET_THEME_JS = (theme: string) =>
	`const settingsPath = join(process.env.PI_CODING_AGENT_DIR, 'settings.json'); const settings = JSON.parse(readFileSync(settingsPath, 'utf8')); settings.theme = ${JSON.stringify(theme)}; writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n');`;

function ownedHome(f: ReturnType<typeof fixture>, name: string, settings: Record<string, unknown>) {
	const target = join(f.root, name);
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "settings.json"), JSON.stringify(settings));
	writeFileSync(join(target, ".nub-ia-home"), JSON.stringify({ createdBy: "nub-ia", version: ownGentlePiVersion() }));
	return target;
}

test("automatic setup never overwrites a theme the home already declared", (t) => {
	const f = fixture(t);
	const target = ownedHome(f, "themed-home", { tuiMode: "fullscreen", theme: "rose" });
	const result = run(enableAutoProvision(provisioning(f)), ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")).theme, "rose");
});

test("nub-ia --link setup never touches the home's theme", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent-link");
	mkdirSync(piAgentDir, { recursive: true });
	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));

	const result = run(provisioning(f, {}, { PI_CODING_AGENT_DIR: piAgentDir }), ["--link", "setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(join(piAgentDir, "settings.json"), "utf8")).theme, undefined, "link mode must never gain a theme");
});

test("automatic setup replaces a theme the install wrote into a home that had none with the default Nub-IA theme", (t) => {
	const f = fixture(t);
	const target = ownedHome(f, "theme-home", { tuiMode: "fullscreen" });
	const env = enableAutoProvision(provisioning(f, { installJs: SET_THEME_JS("kanagawa") }));

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")).theme, "Nub-IA");
});

test("automatic setup restores the bootstrapped default theme when the install overwrites it on a fresh home", (t) => {
	const f = fixture(t);
	const env = enableAutoProvision(provisioning(f, { installJs: SET_THEME_JS("kanagawa") }));

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8")).theme, "Nub-IA");
});

test("automatic setup restores the home's own theme when the install overwrites it", (t) => {
	const f = fixture(t);
	const target = ownedHome(f, "themed-home-to-restore", { tuiMode: "fullscreen", theme: "dracula" });
	const env = enableAutoProvision(provisioning(f, { installJs: SET_THEME_JS("kanagawa") }));

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")).theme, "dracula");
});

// --- builtin codemode exclusion ----------------------------------------------
//
// gentle-pi registers its own decorated codemode tool, so Pi's replaceable
// builtin codemode always loses to it and Pi prints a startup warning. The
// only per-builtin opt-out Pi supports is a `-builtin:codemode` entry in the
// settings `extensions` array, which every normal launch ensures in a home
// nub-ia owns — never in --link, a foreign --home, pi's own default
// agent home, a pi subcommand, or `setup --dry-run`.

const CODEMODE_EXCLUSION = "-builtin:codemode";

function settingsText(dir: string): string {
	return readFileSync(join(dir, "settings.json"), "utf8");
}

test("a fresh isolated home excludes Pi's builtin codemode, and a second launch changes nothing", (t) => {
	const f = fixture(t);
	const first = run(f.env, ["--mode", "rpc"]);
	assert.equal(first.status, 0, first.stderr);
	const settings = JSON.parse(settingsText(f.gentleShellHome));
	assert.deepEqual(settings.extensions, [CODEMODE_EXCLUSION]);
	assert.equal(settings.tuiMode, "fullscreen");
	assert.equal(settings.theme, "Nub-IA");

	const before = settingsText(f.gentleShellHome);
	const second = run(f.env, ["--mode", "rpc"]);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(settingsText(f.gentleShellHome), before);
	assert.doesNotMatch(second.stderr, /builtin codemode/);
});

test("an existing isolated home gains the exclusion after its own extension entries, keeping every other key and its formatting", (t) => {
	for (const [indent, newline] of [[4, "\n"], [undefined, ""]] as const) {
		const f = fixture(t);
		mkdirSync(f.gentleShellHome, { recursive: true });
		const original = { tuiMode: "fullscreen", theme: "rose", extensions: ["./ext/a.ts", "!./ext/b.ts"], packages: ["npm:pi-btw"] };
		writeFileSync(join(f.gentleShellHome, "settings.json"), `${JSON.stringify(original, null, indent)}${newline}`);

		const result = run(f.env, ["--mode", "rpc"]);
		assert.equal(result.status, 0, result.stderr);
		const expected = { ...original, extensions: [...original.extensions, CODEMODE_EXCLUSION] };
		assert.equal(settingsText(f.gentleShellHome), `${JSON.stringify(expected, null, indent)}${newline}`);
		assert.match(result.stderr, /builtin codemode/);
	}
});

test("an explicit user entry for builtin:codemode is left byte-identical", (t) => {
	for (const entry of ["+builtin:codemode", "!builtin:codemode", "builtin:codemode", CODEMODE_EXCLUSION]) {
		const f = fixture(t);
		mkdirSync(f.gentleShellHome, { recursive: true });
		const text = JSON.stringify({ tuiMode: "fullscreen", extensions: ["./ext/a.ts", entry] });
		writeFileSync(join(f.gentleShellHome, "settings.json"), text);

		const result = run(f.env, ["--mode", "rpc"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(settingsText(f.gentleShellHome), text, entry);
	}
});

test("a malformed or unexpected settings.json is never overwritten and pi still starts", (t) => {
	for (const text of ["{ not json", "[]", '{"extensions":"oops"}']) {
		const f = fixture(t);
		mkdirSync(f.gentleShellHome, { recursive: true });
		writeFileSync(join(f.gentleShellHome, "settings.json"), text);

		const result = run(f.env, ["--mode", "rpc"]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).args.slice(-2), ["--mode", "rpc"]);
		assert.equal(settingsText(f.gentleShellHome), text);
	}
});

test("an owned home without settings.json is not given one", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(f.gentleShellHome, "settings.json")), false);
});

test("--link never gains the exclusion", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent-link");
	mkdirSync(piAgentDir, { recursive: true });
	const text = JSON.stringify({ tuiMode: "fullscreen" });
	writeFileSync(join(piAgentDir, "settings.json"), text);

	const result = run({ ...f.env, PI_CODING_AGENT_DIR: piAgentDir }, ["--link", "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(settingsText(piAgentDir), text);
});

test("a foreign --home and pi's own default agent home are never edited, while a bootstrapped --home is", (t) => {
	const f = fixture(t);
	const foreign = join(f.root, "existing-pi-home");
	const defaultPiHome = join(f.home, ".pi", "agent");
	const text = JSON.stringify({ tuiMode: "fullscreen" });
	for (const dir of [foreign, defaultPiHome]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), text);
		const result = run({ ...f.env, PI_CODING_AGENT_DIR: undefined }, ["--home", dir, "--mode", "rpc"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(settingsText(dir), text, dir);
	}

	const bootstrapped = join(f.root, "brand-new-home");
	const result = run(f.env, ["--home", bootstrapped, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(settingsText(bootstrapped)).extensions, [CODEMODE_EXCLUSION]);
});

test("a pi subcommand and setup --dry-run never edit the home's settings", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const text = JSON.stringify({ tuiMode: "fullscreen" });
	writeFileSync(join(f.gentleShellHome, "settings.json"), text);
	const env = provisioning(f);

	for (const args of [["list"], ["setup", "--dry-run"]]) {
		const result = run(env, args);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(settingsText(f.gentleShellHome), text, args.join(" "));
	}
});

test("the exclusion is ensured after automatic setup rewrites settings.json", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), `${JSON.stringify({ tuiMode: "fullscreen", extensions: [CODEMODE_EXCLUSION] }, null, 2)}\n`);
	const dropExtensions = "const settingsPath = join(process.env.PI_CODING_AGENT_DIR, 'settings.json'); const { extensions, ...settings } = JSON.parse(readFileSync(settingsPath, 'utf8')); writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n');";
	const env = enableAutoProvision(provisioning(f, { installJs: dropExtensions }));

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(settingsText(f.gentleShellHome)).extensions, [CODEMODE_EXCLUSION]);
});

// --- atomic writes keep symlinked config files intact ------------------------
//
// Dotfile managers (Nix home-manager, stow, ...) ship settings.json and
// config.json as symlinks. Every atomic launcher write must rename onto the
// link's real target, so the link survives and the target gets the new
// bytes with its own permission bits.

// File symlinks need extra privileges on Windows; skip where unavailable.
const fileSymlinkSkip = (() => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-shell-symlink-probe-"));
	try {
		writeFileSync(join(dir, "target"), "");
		symlinkSync(join(dir, "target"), join(dir, "link"), "file");
		return false;
	} catch {
		return "file symlinks are unavailable here";
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

function symlinkedFile(linkPath: string, targetPath: string, text: string, mode: number) {
	mkdirSync(dirname(linkPath), { recursive: true });
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, text);
	chmodSync(targetPath, mode);
	symlinkSync(targetPath, linkPath, "file");
}

function assertStillLinkedTo(linkPath: string, targetPath: string, mode: number) {
	assert.ok(lstatSync(linkPath).isSymbolicLink(), `${linkPath} is still a symlink`);
	assert.equal(realpathSync(linkPath), realpathSync(targetPath));
	if (process.platform !== "win32") assert.equal(statSync(targetPath).mode & 0o777, mode);
	for (const dir of [dirname(linkPath), dirname(targetPath)]) {
		assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], `no temp file left in ${dir}`);
	}
}

test("the builtin codemode exclusion writes through a symlinked settings.json", { skip: fileSymlinkSkip }, (t) => {
	const f = fixture(t);
	const linkPath = join(f.gentleShellHome, "settings.json");
	const targetPath = join(f.root, "dotfiles", "settings.json");
	symlinkedFile(linkPath, targetPath, JSON.stringify({ tuiMode: "fullscreen", theme: "rose" }), 0o640);

	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assertStillLinkedTo(linkPath, targetPath, 0o640);
	assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), { tuiMode: "fullscreen", theme: "rose", extensions: [CODEMODE_EXCLUSION] });
});

test("the automatic setup theme restore writes through a symlinked settings.json", { skip: fileSymlinkSkip }, (t) => {
	const f = fixture(t);
	const target = join(f.root, "linked-themed-home");
	const linkPath = join(target, "settings.json");
	const targetPath = join(f.root, "dotfiles", "themed-settings.json");
	symlinkedFile(linkPath, targetPath, JSON.stringify({ tuiMode: "fullscreen", theme: "dracula" }), 0o600);
	writeFileSync(join(target, ".nub-ia-home"), JSON.stringify({ createdBy: "nub-ia", version: ownGentlePiVersion() }));

	const env = enableAutoProvision(provisioning(f, { installJs: SET_THEME_JS("kanagawa") }));

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assertStillLinkedTo(linkPath, targetPath, 0o600);
	assert.equal(JSON.parse(readFileSync(targetPath, "utf8")).theme, "dracula");
});

test("'home' persistence writes through a symlinked config.json", { skip: fileSymlinkSkip }, (t) => {
	const f = fixture(t);
	const linkPath = join(f.root, "config", "config.json");
	const targetPath = join(f.root, "dotfiles", "config.json");
	symlinkedFile(linkPath, targetPath, "{}\n", 0o600);

	const result = run({ ...f.env, GENTLE_SHELL_CONFIG: linkPath }, ["home", "link"]);
	assert.equal(result.status, 0, result.stderr);
	assertStillLinkedTo(linkPath, targetPath, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), { home: "link" });
});

test("a dangling config.json symlink is replaced in place, never followed to create its target", { skip: fileSymlinkSkip }, (t) => {
	const f = fixture(t);
	const linkPath = join(f.root, "config", "config.json");
	const missingTarget = join(f.root, "missing", "config.json");
	mkdirSync(dirname(linkPath), { recursive: true });
	symlinkSync(missingTarget, linkPath, "file");

	const result = run({ ...f.env, GENTLE_SHELL_CONFIG: linkPath }, ["home", "link"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(lstatSync(linkPath).isSymbolicLink(), false);
	assert.deepEqual(JSON.parse(readFileSync(linkPath, "utf8")), { home: "link" });
	assert.equal(existsSync(dirname(missingTarget)), false);
});

// --- --package-root silently ignored in a declared non-link home ----------

test("--package-root warns and is ignored when an isolated home already declares gentle-pi", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["npm:gentle-pi@3.5.1"], tuiMode: "fullscreen" }));
	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const result = run(f.env, ["--package-root", forcedRoot, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		new RegExp(
			`--package-root only forces a take-over in --link mode; ${f.gentleShellHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} declares gentle-pi, so the installed package is used and ${forcedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is ignored`,
		),
	);
	assert.doesNotMatch(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--mode", "rpc"]);
});

test("--package-root prints no warning when the home does not declare gentle-pi", (t) => {
	const f = fixture(t);
	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const result = run(f.env, ["--package-root", forcedRoot, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /--package-root only forces a take-over/);
});

test("--help mentions the setup subcommand", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\bsetup\b/);
});

// --- --link takeover of a conflicting path package -----------------------
//
// Regression coverage for the settings.json shape that triggered the tool
// conflict bug: gentle-pi declared as a relative *path* package (not
// npm:gentle-pi) alongside another package. findGentlePiDeclaration now
// recognises that path declaration by reading its package.json "name", and
// the launcher takes over the pi invocation instead of also injecting its
// own -e, which used to load two copies of gentle-pi side by side.

test("--link takes over a path-declared conflicting gentle-pi: --no-extensions, the other package's dir, then this launcher's own -e, settings byte-identical", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	// "npm:some-other" must actually be installed under
	// <agentDir>/npm/node_modules for it to be re-injected (R3-001): a
	// declared-but-missing package dir is now skipped with a warning instead.
	mkdirSync(join(piAgentDir, "npm", "node_modules", "some-other"), { recursive: true });

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other", "../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--mode", "rpc"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	assert.match(result.stderr, /taking over gentle-pi from/);
	assert.match(result.stderr, /other-gentle-pi/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(piAgentDir, "npm", "node_modules", "some-other"),
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);

	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
	assert.equal(payload.PI_CODING_AGENT_DIR, piAgentDir);
});

test("--link install npm:x with a path-declared conflicting gentle-pi in settings forwards the bare subcommand, no take-over", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other", "../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "install", "npm:x"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "npm:x"]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
	assert.equal(payload.PI_CODING_AGENT_DIR, piAgentDir);
});

test("--link does not take over a git-sourced other package: it is skipped with a warning, not injected", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	const settingsPath = join(piAgentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ packages: ["git:github.com/foo/bar", "../other-gentle-pi"] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /skipping git-sourced package/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

test("--package-root forces a takeover even when settings already declare a matching npm:gentle-pi", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", forcedRoot], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from npm:gentle-pi/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", forcedRoot]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--package-root forces a takeover even with no gentle-pi declaration at all: --no-extensions and the other packages are still injected", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	// "npm:some-other" must actually be installed under
	// <agentDir>/npm/node_modules for it to be re-injected (R3-001).
	mkdirSync(join(piAgentDir, "npm", "node_modules", "some-other"), { recursive: true });
	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other"] });
	writeFileSync(settingsPath, settingsText);

	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", forcedRoot], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from the requested package root/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(piAgentDir, "npm", "node_modules", "some-other"),
		"-e",
		forcedRoot,
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--link take-over with --package-root injects exactly one -e when a settings path entry reaches the same physical directory through a symlink (R4-forced-root-symlink-double-injection)", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const packagesDir = join(piAgentDir, "packages");
	const realOtherDir = join(packagesDir, "real-other");
	mkdirSync(realOtherDir, { recursive: true });
	const linkOtherDir = join(packagesDir, "link-other");
	symlinkSync(realOtherDir, linkOtherDir, "dir");

	// settings declares the SYMLINK path; --package-root names the REAL path
	// directly. Both spellings reach the same physical directory, so it must
	// be injected exactly once instead of twice (once as an "other package"
	// via the symlink, once as this launcher's own package root).
	const settingsPath = join(piAgentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ packages: [join("packages", "link-other")] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", realOtherDir], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.equal(payload.args.filter((arg: string) => arg === "-e").length, 1);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		realOtherDir,
	]);
});

// --- loose extension files re-injected during a take-over -----------------
//
// Regression coverage for R4-003/R3-003 (and the follow-up bug it left
// behind): --no-extensions drops pi's normal settings-driven extension
// discovery, which also happens to be how pi finds loose (non-package)
// extensions under <agentDir>/extensions and the project-local
// <cwd>/.pi/extensions. Re-injecting those two directories wholesale as
// `-e <dir>` does not work: pi's `-e` flag hands the path straight to its
// module loader (no directory-discovery pass), so a bare directory holding
// only loose files fails with "Cannot find module ...". A take-over must
// instead discover each loose file the same way pi's own directory scan
// would (see discoverLooseExtensionEntries) and inject it individually.

test("--link take-over re-injects loose extension files, one -e per discovered file, from <agentDir>/extensions and the project-local .pi/extensions", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	// <agentDir>/extensions: a.ts, b.js, c.ts.bak-pre-fullscreen-fix (skipped,
	// suffix doesn't end in .ts/.js/.mjs), sub/index.ts, .hidden.ts (skipped).
	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(join(looseAgentExtensions, "sub"), { recursive: true });
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");
	writeFileSync(join(looseAgentExtensions, "b.js"), "export default () => {};");
	writeFileSync(join(looseAgentExtensions, "gentle-agent-state.ts.bak-pre-fullscreen-fix"), "stale backup");
	writeFileSync(join(looseAgentExtensions, ".hidden.ts"), "export default () => {};");
	writeFileSync(join(looseAgentExtensions, "sub", "index.ts"), "export default () => {};");

	const projectDir = join(f.root, "project");
	const looseProjectExtensions = join(projectDir, ".pi", "extensions");
	mkdirSync(looseProjectExtensions, { recursive: true });
	writeFileSync(join(looseProjectExtensions, "project-ext.mjs"), "export default () => {};");
	// The launcher derives this dir from process.cwd() inside the spawned
	// child, which resolves symlinks (e.g. macOS's /tmp -> /private/tmp);
	// realpath the expectation the same way so the two agree everywhere.
	const resolvedLooseProjectExtensions = join(realpathSync(projectDir), ".pi", "extensions");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--mode", "rpc"], { cwd: projectDir });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "a.ts"),
		"-e",
		join(looseAgentExtensions, "b.js"),
		"-e",
		join(looseAgentExtensions, "sub", "index.ts"),
		"-e",
		join(resolvedLooseProjectExtensions, "project-ext.mjs"),
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--link take-over injects a root-level index.ts as its own loose file entry, alongside a sibling loose file (R4-loose-index-collapses-sibling-extensions)", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "index.ts"), "export default () => {};");
	// A root-level index.ts is just another loose file, not a marker that
	// collapses the whole directory into a single -e <dir>: pi's own
	// discovery loads every direct *.ts/*.js/*.mjs file individually, so a
	// sibling like extra.ts must keep loading too instead of being dropped.
	writeFileSync(join(looseAgentExtensions, "extra.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "extra.ts"),
		"-e",
		join(looseAgentExtensions, "index.ts"),
		"-e",
		packageRoot,
	]);
});

test("--link take-over injects a subdirectory's own index.ts entry point even when the loose extensions dir has no other direct files", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	const subDir = join(looseAgentExtensions, "sub");
	mkdirSync(subDir, { recursive: true });
	writeFileSync(join(subDir, "index.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(subDir, "index.ts"),
		"-e",
		packageRoot,
	]);
});

test("--link take-over omits -e flags for loose extension dirs that do not exist", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

// --- R3-001/R4-takeover-injects-unverified-package-dirs -------------------
//
// A settings.json package that is declared but not actually installed on
// disk (hand-edited file, a failed or interrupted `pi install`, an npm store
// laid out anywhere other than <agentDir>/npm/node_modules) must not be
// handed to pi as an unresolvable -e: pi's module loader fails on it with
// "Cannot find module", which would break every take-over launch against a
// partially-installed home. It is filtered the same way loose extension
// candidates already are, with one stderr warning naming the source and the
// resolved path, and the launch still succeeds.

test("--link take-over skips a declared package directory that is not installed, warns, and still launches; an installed one is still injected", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	// "npm:some-other" is declared but never installed under
	// <agentDir>/npm/node_modules, so its resolved directory does not exist.
	// "npm:installed-other" IS installed, so it must still be injected.
	const installedOtherDir = join(piAgentDir, "npm", "node_modules", "installed-other");
	mkdirSync(installedOtherDir, { recursive: true });

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other", "npm:installed-other", "../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--mode", "rpc"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	assert.match(result.stderr, /skipping declared package "npm:some-other"/);
	assert.match(result.stderr, /is not a directory/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		installedOtherDir,
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--link take-over injects the launcher's own package root once when --package-root names a directory settings also declare as a plain path entry", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const settingsPath = join(piAgentDir, "settings.json");
	// The forced root is also declared as an ordinary (non-gentle-pi) path
	// package, so otherPackageInjections would resolve it to the same
	// directory as --package-root.
	const settingsText = JSON.stringify({ packages: ["../forced-root"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", forcedRoot], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	const eFlags = payload.args.filter((arg: string, index: number) => payload.args[index - 1] === "-e");
	assert.deepEqual(eFlags, [forcedRoot]);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		forcedRoot,
	]);
});

test("--isolated --package-root produces the plain injection (no --no-extensions): the take-over path is gated on link mode", (t) => {
	const f = fixture(t);
	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const result = run(f.env, ["--isolated", "--package-root", forcedRoot, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		forcedRoot,
		"--mode",
		"rpc",
	]);
});

test("--package-root naming a directory that does not exist fails with a clear error instead of launching", (t) => {
	const f = fixture(t);
	const missingRoot = join(f.root, "does-not-exist");

	const result = run(f.env, ["--package-root", missingRoot]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--package-root/);
	assert.match(result.stderr, /does not exist|not a directory/);
});

// --- R4-loose-extension-enumeration-fails-silently -------------------------

test("--link take-over warns once when a loose extensions directory cannot be read, instead of failing silently", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "mode bits do not block readdir here" : false }, (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");
	chmodSync(looseAgentExtensions, 0o000);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	// Restore permissions immediately, before any assertion can throw and
	// skip cleanup: fixture()'s own t.after (registered before this test body
	// runs) removes f.root recursively, which requires read/execute
	// permission on every subdirectory, including this one.
	chmodSync(looseAgentExtensions, 0o755);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /could not read loose extension directory/);
	assert.match(result.stderr, /extensions/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

// --- R3-004: loose-extensions manifest branch coverage ----------------------

test("--link take-over falls through to per-file discovery when a loose dir's package.json declares an empty pi.extensions array", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "package.json"), JSON.stringify({ pi: { extensions: [] } }));
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "a.ts"),
		"-e",
		packageRoot,
	]);
});

test("--link take-over treats a malformed package.json as no manifest and falls through to per-file discovery", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "package.json"), "{ not valid json");
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "a.ts"),
		"-e",
		packageRoot,
	]);
});

// --- R4-takeover-leaves-two-gentle-pi-skill-sets-loaded ---------------------

test("--link take-over stderr message also notes that the taken-over declaration's skills, prompts, and themes still load alongside this launcher's", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from/);
	assert.match(result.stderr, /skills, prompts, and themes/);
});

test("--link take-over treats a file named `extensions` as not a loose extension dir", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));
	writeFileSync(join(piAgentDir, "extensions"), "not a directory");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

// --- resume-hint handoff (lib/gentle-shell-resume-hint.ts) ----------------------

// A stand-in pi that writes a resume handoff like extensions/resume-hint.ts
// does, prints pi's own exit hint, and exits with the given code.
function writeHandoffPiScript(path: string, exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"const { writeFileSync } = require('node:fs');",
			"const args = process.argv.slice(2);",
			"if (args.includes('--version')) { console.log('0.99.1'); process.exit(0); }",
			"const handoff = process.env.GENTLE_SHELL_RESUME_HANDOFF;",
			"if (handoff) writeFileSync(handoff, JSON.stringify({ sessionId: 'abc' }));",
			"if (process.env.PI_STUB_PRINT_ENV) console.log(JSON.stringify({ args, handoff }));",
			"process.stdout.write('To resume this session: pi --session abc\\n');",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

test("interactive launch hands pi a private resume handoff and cleans it up", (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "handoff-pi.cjs");
	writeHandoffPiScript(piScript);
	const result = run({ ...f.env, GENTLE_SHELL_PI: piScript, PI_STUB_PRINT_ENV: "1" }, []);
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.trim().split("\n");
	const { handoff } = JSON.parse(lines[0]);
	assert.equal(typeof handoff, "string");
	assert.match(handoff, /nub-ia-resume-/);
	assert.equal(existsSync(dirname(handoff)), false, "handoff dir must be removed after pi exits");
	// Not a TTY: like pi's own hint, the nub-ia line is not printed.
	assert.deepEqual(lines.slice(1), ["To resume this session: pi --session abc"]);
});

test("pi subcommands get no resume handoff", (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "handoff-pi.cjs");
	writeHandoffPiScript(piScript);
	const result = run({ ...f.env, GENTLE_SHELL_PI: piScript, PI_STUB_PRINT_ENV: "1" }, ["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout.trim().split("\n")[0]).handoff, undefined);
});

// The hint is only printed to a real TTY, so drive the launcher through a
// pseudo-terminal. Python's pty module is the portable POSIX way to get one
// without a native dependency; skipped where it is unavailable.
const hasPythonPty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
const PTY_RUNNER = [
	"import fcntl, os, pty, struct, subprocess, sys, termios",
	"m, s = pty.openpty()",
	"fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 120, 0, 0))",
	"p = subprocess.Popen(sys.argv[1:], stdin=s, stdout=s, stderr=s)",
	"os.close(s)",
	"out = b''",
	// PTY_SIGNAL_AFTER: once this text appears, send PTY_SIGNAL to the launcher.
	"after = os.environ.get('PTY_SIGNAL_AFTER', '').encode()",
	"while True:",
	"    try: d = os.read(m, 4096)",
	"    except OSError: break",
	"    if not d: break",
	"    out += d",
	"    if after and after in out:",
	"        after = b''",
	"        os.kill(p.pid, int(os.environ['PTY_SIGNAL']))",
	"sys.stdout.write(out.decode())",
	"sys.exit(p.wait())",
].join("\n");

function runInPty(env: NodeJS.ProcessEnv, args: string[], expectedStatus = 0): string {
	// Pin the color environment so the launcher's hasColors() check does not
	// depend on the machine running the tests; a test can still override it.
	const { NO_COLOR, FORCE_COLOR, NODE_DISABLE_COLORS, ...rest } = env;
	const colorEnv = { ...rest, TERM: "xterm-256color", ...(env.PTY_NO_COLOR ? { NO_COLOR: "1" } : {}) };
	// Bounded so a stand-in pi that never exits fails the test instead of hanging CI.
	const result = spawnSync("python3", ["-c", PTY_RUNNER, process.execPath, binPath, ...args], { encoding: "utf8", env: colorEnv, timeout: 30_000 });
	assert.equal(result.error, undefined, String(result.error));
	assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
	return result.stdout;
}

const PI_HINT = "To resume this session: pi --session abc\r\n";
const GENTLE_HINT = "\u001b[2mTo resume in nub-ia:\u001b[22m nub-ia --link --session abc\r\n";

test("on a TTY the launcher appends a nub-ia resume line below pi's hint", { skip: !hasPythonPty && "needs python3 pty" }, (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "tty-pi.cjs");
	writeHandoffPiScript(piScript);
	const out = runInPty({ ...f.env, GENTLE_SHELL_PI: piScript }, ["--link"]);
	assert.ok(out.endsWith(PI_HINT + GENTLE_HINT), JSON.stringify(out));
});

test("on a TTY the nub-ia line still follows a non-zero pi exit, keeping the code", { skip: !hasPythonPty && "needs python3 pty" }, (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "tty-pi.cjs");
	writeHandoffPiScript(piScript, 3);
	const out = runInPty({ ...f.env, GENTLE_SHELL_PI: piScript }, ["--link"], 3);
	assert.ok(out.endsWith(PI_HINT + GENTLE_HINT), JSON.stringify(out));
});

// A stand-in pi that writes the handoff and then waits: it quits with its
// own hint on SIGHUP/SIGTERM, but survives SIGINT (like an interrupted turn)
// and quits only on the next line of input.
function writeWaitingPiScript(path: string) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"const { writeFileSync } = require('node:fs');",
			"if (process.argv.includes('--version')) { console.log('0.99.1'); process.exit(0); }",
			"writeFileSync(process.env.GENTLE_SHELL_RESUME_HANDOFF, JSON.stringify({ sessionId: 'abc' }));",
			"const quit = () => { process.stdout.write('To resume this session: pi --session abc\\n'); process.exit(0); };",
			"process.on('SIGHUP', quit);",
			"process.on('SIGTERM', quit);",
			"process.on('SIGINT', () => { process.stdout.write('interrupted\\n'); setTimeout(quit, 50); });",
			"process.stdout.write('ready\\n');",
			"setInterval(() => {}, 1000);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

test("on a TTY the launcher prints nothing extra after the terminal hangs up", { skip: !hasPythonPty && "needs python3 pty" }, (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "tty-pi.cjs");
	writeWaitingPiScript(piScript);
	const out = runInPty({ ...f.env, GENTLE_SHELL_PI: piScript, PTY_SIGNAL_AFTER: "ready", PTY_SIGNAL: "1" }, ["--link"]);
	// pi quit cleanly with its own hint; only the nub-ia line is withheld.
	assert.ok(out.endsWith(PI_HINT), JSON.stringify(out));
	assert.equal(out.includes("nub-ia --"), false, JSON.stringify(out));
});

test("on a TTY a forwarded SIGINT that pi survives does not silence the nub-ia line", { skip: !hasPythonPty && "needs python3 pty" }, (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "tty-pi.cjs");
	writeWaitingPiScript(piScript);
	const out = runInPty({ ...f.env, GENTLE_SHELL_PI: piScript, PTY_SIGNAL_AFTER: "ready", PTY_SIGNAL: "2" }, ["--link"]);
	assert.ok(out.includes("interrupted"), JSON.stringify(out));
	assert.ok(out.endsWith(PI_HINT + GENTLE_HINT), JSON.stringify(out));
});

test("on a TTY a cross-project session resumes by its session file", { skip: !hasPythonPty && "needs python3 pty" }, (t) => {
	const f = fixture(t);
	const sessionFile = join(f.root, "other project", "session.jsonl");
	const piScript = join(f.root, "tty-pi.cjs");
	writeFileSync(
		piScript,
		[
			"#!/usr/bin/env node",
			"const { writeFileSync } = require('node:fs');",
			"if (process.argv.includes('--version')) { console.log('0.99.1'); process.exit(0); }",
			`writeFileSync(process.env.GENTLE_SHELL_RESUME_HANDOFF, JSON.stringify({ sessionId: 'abc', sessionFile: ${JSON.stringify(sessionFile)} }));`,
			"process.stdout.write('To resume this session: pi --session abc\\n');",
			"",
		].join("\n"),
	);
	chmodSync(piScript, 0o755);
	const out = runInPty({ ...f.env, GENTLE_SHELL_PI: piScript }, ["--link"]);
	assert.ok(
		out.endsWith(`${PI_HINT}\u001b[2mTo resume in nub-ia:\u001b[22m nub-ia --link --session '${sessionFile}'\r\n`),
		JSON.stringify(out),
	);
});

test("on a TTY without colors the nub-ia line has no ANSI styling", { skip: !hasPythonPty && "needs python3 pty" }, (t) => {
	const f = fixture(t);
	const piScript = join(f.root, "tty-pi.cjs");
	writeHandoffPiScript(piScript);
	const out = runInPty({ ...f.env, GENTLE_SHELL_PI: piScript, PTY_NO_COLOR: "1" }, ["--link"]);
	assert.ok(out.endsWith(`${PI_HINT}To resume in nub-ia: nub-ia --link --session abc\r\n`), JSON.stringify(out));
});

// --- rtk self-heal and provider hint -----------------------------------------

test("launch installs a missing rtk once through the installer and only warns on failure", (t) => {
	const f = standaloneLauncher(t);
	writePiScript(join(f.root, "pi"), "0.99.2");
	const installer = join(f.root, "fake-rtk-installer.mjs");
	const marker = join(f.root, "installer-ran");
	writeFileSync(installer, `import { writeFileSync } from "node:fs";\nexport async function installRtk({ root }) { writeFileSync(${JSON.stringify(marker)}, root); }\n`);
	const env = { ...f.env, GENTLE_PI_SKIP_RTK_INSTALL: "", GENTLE_SHELL_RTK_INSTALLER: installer };
	const result = spawnSync(process.execPath, [f.launcher, "--home", join(f.root, "h")], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /nub-ia: rtk v[\d.]+ is missing; installing it once/);
	assert.equal(readFileSync(marker, "utf8"), f.root);

	writeFileSync(installer, "export async function installRtk() { throw new Error('offline'); }\n");
	const failed = spawnSync(process.execPath, [f.launcher, "--home", join(f.root, "h")], { env, encoding: "utf8" });
	assert.equal(failed.status, 0, failed.stderr);
	assert.match(failed.stderr, /could not install rtk \(offline\); continuing without it/);
});

test("GENTLE_PI_SKIP_RTK_INSTALL=1 suppresses the rtk self-heal", (t) => {
	const f = standaloneLauncher(t);
	writePiScript(join(f.root, "pi"), "0.99.2");
	const result = spawnSync(process.execPath, [f.launcher, "--home", join(f.root, "h")], { env: { ...f.env, GENTLE_SHELL_RTK_INSTALLER: join(f.root, "missing.mjs") }, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /rtk/);
});

test("nub-ia setup prints the provider sign-in hint, but --dry-run does not", (t) => {
	const f = fixture(t);
	const env = provisioning(f);
	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /sign in to at least one provider inside the shell/);
	assert.match(result.stderr, /\/login github-copilot/);
	assert.match(result.stderr, /Amazon Bedrock uses your AWS_\* credentials/);
	const dry = run(env, ["setup", "--dry-run"]);
	assert.doesNotMatch(dry.stderr, /sign in to at least one provider/);
});

// --- `nub-ia update` self-update of the package checkout ---------------------

test("nub-ia update fast-forwards a Git checkout before forwarding update to pi, and respects NUB_IA_NO_SELF_UPDATE", (t) => {
	const f = fixture(t);
	// A throwaway package checkout: a bare "origin" with one extra commit ahead.
	const origin = join(f.root, "origin.git");
	const checkout = join(f.root, "checkout");
	const seed = join(f.root, "seed");
	const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	mkdirSync(seed, { recursive: true });
	cpSync(new URL("../bin/", import.meta.url), join(seed, "bin"), { recursive: true });
	cpSync(new URL("../runtime/", import.meta.url), join(seed, "runtime"), { recursive: true });
	cpSync(new URL("../scripts/", import.meta.url), join(seed, "scripts"), { recursive: true });
	writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "nub-ia", version: "0.1.0", type: "module" }));
	git(seed, "init", "-q", "-b", "trunk"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "v1");
	spawnSync("git", ["clone", "-q", "--bare", seed, origin]);
	spawnSync("git", ["clone", "-q", "--branch", "trunk", origin, checkout]);
	writeFileSync(join(seed, "NEW.txt"), "v2"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "v2"); git(seed, "push", "-q", origin, "trunk:trunk");
	const before = git(checkout, "rev-parse", "HEAD").stdout.trim();
	const env = { ...f.env, NUB_IA_NO_SELF_UPDATE: "1" };

	const skipped = spawnSync(process.execPath, [join(checkout, "bin", "nub-ia.mjs"), "update"], { encoding: "utf8", env });
	assert.equal(skipped.status, 0, skipped.stderr);
	assert.doesNotMatch(skipped.stderr, /updating/);
	assert.equal(git(checkout, "rev-parse", "HEAD").stdout.trim(), before, "opt-out leaves the checkout alone");

	delete (env as Record<string, string | undefined>).NUB_IA_NO_SELF_UPDATE;
	const updated = spawnSync(process.execPath, [join(checkout, "bin", "nub-ia.mjs"), "update"], { encoding: "utf8", env });
	assert.equal(updated.status, 0, updated.stderr);
	assert.match(updated.stderr, /nub-ia: updating .*checkout \(git pull --ff-only\)/);
	assert.match(updated.stderr, /package updated [0-9a-f]+ -> [0-9a-f]+; installing dependencies/);
	assert.notEqual(git(checkout, "rev-parse", "HEAD").stdout.trim(), before, "the checkout fast-forwarded to origin");
	assert.ok(existsSync(join(checkout, "NEW.txt")));
	const forwarded = JSON.parse(updated.stdout.trim().split("\n").filter(Boolean).at(-1)!);
	assert.deepEqual(forwarded.args, ["update"], "pi's own update still runs for the home's packages");
});
