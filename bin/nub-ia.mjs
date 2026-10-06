#!/usr/bin/env node
// Thin process/fs/exec glue around lib/gentle-shell-launcher.ts (built to
// runtime/gentle-shell-launcher.mjs). All decision logic — argv parsing, home
// resolution, pi resolution order, the version gate, and the pi invocation —
// lives in that pure, unit-tested module; this file only wires it to the real
// process, filesystem, and child process.
import {
	accessSync,
	chmodSync,
	closeSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	buildPiInvocation,
	checkPiVersion,
	decideTakeOver,
	describeVersion,
	discoverLooseExtensionEntries,
	findGentlePiDeclaration,
	forceJsonFieldIfAbsentInOriginal,
	helpText,
	homeSelectorFlags,
	launcherConfigPath,
	missingPiMessage,
	needsProvisioning,
	otherPackageInjections,
	parseLauncherArgs,
	parseLauncherConfig,
	parseRawLauncherConfig,
	planSpawn,
	resolveTeamPackageSources,
	teamPackagesToInstall,
	provisionedEntry,
	recordProvisioned,
	resolveHome,
	resolvePiRuntime,
	restoreJsonField,
	shellQuote,
} from "../runtime/gentle-shell-launcher.mjs";
import {
	parseResumeHandoff,
	planResumeHint,
	RESUME_HANDOFF_DIR_PREFIX,
	RESUME_HANDOFF_ENV,
	RESUME_HANDOFF_FILE,
} from "../runtime/gentle-shell-resume-hint.mjs";
import { DEFAULT_THEME_NAME, installIsolatedTuiModeSetting } from "../scripts/install-tui-mode-setting.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message, code) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function readJsonIfExists(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

// Resolve the public ESM entry without importing the agent or reaching through
// its exports map. Only an absent optional peer permits PATH fallback; malformed
// installed metadata must not silently select a different runtime.
function resolveBundledCli() {
	let publicEntry;
	try {
		publicEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	} catch (error) {
		if (error.code === "ERR_MODULE_NOT_FOUND") return undefined;
		throw error;
	}
	const entry = realpathSync(publicEntry);
	const root = dirname(dirname(entry));
	const expectedEntry = join(root, "dist", "index.js");
	const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (entry !== expectedEntry || metadata.name !== "@earendil-works/pi-coding-agent" ||
		metadata.bin?.pi !== "dist/bundle/cli.js") {
		throw new Error("Unsupported adjacent Pi package entry/name/bin metadata");
	}
	const cliPath = join(root, metadata.bin.pi);
	if (realpathSync(cliPath) !== cliPath || !statSync(cliPath).isFile()) {
		throw new Error("Unsupported adjacent Pi CLI path");
	}
	return cliPath;
}

function findOnPath(name) {
	const dirs = (process.env.PATH || "").split(delimiter).filter((entry) => entry.length > 0);
	const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	for (const dir of dirs) {
		for (const extension of extensions) {
			const candidate = join(dir, `${name}${extension}`);
			try {
				accessSync(candidate, fsConstants.X_OK);
				return candidate;
			} catch {
				// keep scanning
			}
		}
	}
	return undefined;
}

function signalExitCode(signal) {
	const number = osConstants.signals[signal];
	return 128 + (typeof number === "number" ? number : 0);
}

function ownPackageVersion() {
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	return packageJson.version;
}

function emptyArgs() {
	return {
		link: false,
		isolated: false,
		home: undefined,
		packageRoot: undefined,
		help: false,
		version: false,
		command: undefined,
		commandArgs: [],
		passthrough: [],
		piSubcommand: undefined,
		error: undefined,
	};
}

// package.json "name" reader injected into findGentlePiDeclaration: a
// missing or unreadable package.json, or a non-string "name", is never an
// error here — it just means that path package is not gentle-pi.
function readPackageName(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return typeof pkg.name === "string" ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

// Best-effort realpath: a directory that does not exist (yet, or ever)
// cannot be realpath'd, so the take-over decision falls back to comparing
// the raw path instead of failing.
function safeRealpath(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

// Used to filter the loose extension dirs a take-over re-injects: a missing
// path, or one that is not a directory (for example a stray file named
// "extensions"), is silently excluded rather than passed to pi as -e.
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

// Reuse Herdr's managed bridge, never its transport. This process-boundary
// lookup is deliberately best-effort and does not modify either agent home.
function managedHerdrExtensionArgs(home, args) {
	const env = process.env;
	if (home.mode !== "isolated" || args.piSubcommand !== undefined || args.passthrough[0] === "mcp") return [];
	if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH?.trim() || !env.HERDR_PANE_ID?.trim()) return [];
	if (env.GENTLE_PI_AGENTS_CHILD === "1" || !process.stdin.isTTY || !process.stdout.isTTY) return [];
	// Only automatic interactive loading: a user opt-out must not become an
	// explicit -e (which Pi loads even under --no-extensions). Conservatively
	// skip ambiguous mode flags too; --mode text alone still allows a TUI.
	const forwarded = args.passthrough;
	if (forwarded.some((arg) => ["--no-extensions", "-ne", "--print", "-p", "--export", "--list-models", "-v"].includes(arg))) return [];
	if (forwarded.some((arg, i) => (arg === "--mode" && forwarded[i + 1] !== "text") || arg.startsWith("--mode="))) return [];
	try {
		if (!statSync(env.HERDR_SOCKET_PATH).isSocket()) return [];
	} catch {
		return [];
	}
	// Prefer a bridge in the selected home over adding a competing copy; keep
	// the incoming Pi home override before falling back to Herdr's usual home.
	const agentHomes = [home.dir, env.PI_CODING_AGENT_DIR, join(homedir(), ".pi", "agent")];
	for (const agentHome of agentHomes) {
		if (!agentHome) continue;
		const bridge = join(agentHome, "extensions", "herdr-agent-state.ts");
		try {
			if (!statSync(bridge).isFile()) continue;
			accessSync(bridge, fsConstants.R_OK);
			// Pi's package-manager.toResolvedPaths and resource-loader.mergePaths
			// dedupe canonical files across discovery, explicit -e and manifests.
			// Existence alone is NOT proof of loading: declare the resource and
			// let that resolver dedupe it, including explicit aliases from argv.
			return ["-e", realpathSync(bridge)];
		} catch {
			// An absent/unreadable bridge never prevents the ordinary launch.
		}
	}
	return [];
}

// Real-fs adapter for discoverLooseExtensionEntries (lib/gentle-shell-launcher.ts):
// statSync-based isFile/isDirectory (not readdirSync's Dirent, which uses
// lstat and so would treat a symlinked file or directory as neither) so a
// symlinked loose extension resolves the same way pi's own fs.existsSync-based
// checks would.
const looseExtensionFs = {
	readdir(dir) {
		let names;
		try {
			names = readdirSync(dir);
		} catch (error) {
			// resolveLooseExtensionEntries only calls this once isDirectory(dir)
			// has already confirmed the directory exists, so a failure here (for
			// example EACCES) is a real read failure, not a missing directory.
			// Warn instead of silently dropping every loose extension it would
			// have contributed (R4-loose-extension-enumeration-fails-silently).
			process.stderr.write(`nub-ia: could not read loose extension directory ${dir}: ${error.message} (skipping)\n`);
			return [];
		}
		return names.map((name) => {
			const entryPath = join(dir, name);
			try {
				const entryStat = statSync(entryPath);
				return { name, isFile: entryStat.isFile(), isDirectory: entryStat.isDirectory() };
			} catch {
				return { name, isFile: false, isDirectory: false };
			}
		});
	},
	exists: existsSync,
};

// A loose extensions directory that is itself a self-contained extension —
// a package.json declaring a non-empty "pi.extensions" manifest — is passed
// through as a single -e <dir> instead of being broken into per-file
// entries: pi's own module loader (jiti) resolves that case directly,
// exactly as it would for any other explicitly configured package path. A
// root-level index.ts/index.js is deliberately NOT treated as that same
// marker: pi's own discovery loads it as just another loose file, so
// collapsing the whole directory on its presence silently dropped sibling
// loose files like extra.ts (R4-loose-index-collapses-sibling-extensions).
function readPiManifestExtensions(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : undefined;
	} catch {
		return undefined;
	}
}

function looseDirHasOwnEntryPoint(dir) {
	const manifestExtensions = readPiManifestExtensions(dir);
	return manifestExtensions !== undefined && manifestExtensions.length > 0;
}

// Resolves one candidate loose-extensions directory (<agentDir>/extensions or
// <cwd>/.pi/extensions) into the -e entries a take-over must re-inject: the
// directory itself when it is a self-contained extension, otherwise every
// loose file discoverLooseExtensionEntries finds inside it. A missing or
// non-directory candidate resolves to no entries.
function resolveLooseExtensionEntries(dir) {
	if (!isDirectory(dir)) return [];
	if (looseDirHasOwnEntryPoint(dir)) return [dir];
	return discoverLooseExtensionEntries(dir, looseExtensionFs);
}

// Test/development-only override for the launcher config.json path
// (normally launcherConfigPath(homedir())). Lets a test — or the
// packed-artifact E2E script, which also needs `--link` probes against the
// real pi home and so cannot just redirect HOME wholesale — read and write
// the `home` subcommand's and the auto-provisioning marker's config file
// without ever touching the real ~/.nub-ia/config.json. Never
// consulted outside these two call sites; see docs/readme-reference.md.
function resolveConfigPath() {
	const override = process.env.GENTLE_SHELL_CONFIG;
	return override !== undefined && override.length > 0 ? override : launcherConfigPath(homedir());
}

// Raw config.json as a plain object (see RawLauncherConfig in
// lib/gentle-shell-launcher.ts): unlike parseLauncherConfig, this preserves
// every key, so a write (home persistence, or the provisioning marker below)
// never drops a key it does not itself understand.
function readRawConfig(configPath) {
	return parseRawLauncherConfig(readJsonIfExists(configPath));
}

// Atomic (temp file in the same directory, then rename): a crash or kill
// mid-write must never leave config.json truncated or partially written,
// since it also carries the S7 provisioning marker every plain launch reads.
function writeRawConfig(configPath, config) {
	const configDir = dirname(configPath);
	if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
	writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

// The one atomic write every launcher-owned config/settings update goes
// through: a temp file next to the real target, then a rename onto it, so a
// crash or kill never leaves a partial file. When `path` is a symlink (Nix
// home-manager, stow, and similar dotfile managers ship settings.json and
// config.json that way), the write lands on the link's real target and the
// link itself stays in place; renaming onto `path` would replace the link
// with a regular file. A missing path or a dangling link has no real target
// to preserve, so it is written at `path` itself, exactly as before this
// helper existed, instead of creating a file wherever a dangling link points.
// The permission bits are `mode` when given, otherwise the real target's own
// (applied with chmod, so the umask cannot narrow them); a new file keeps
// the default creation mode. The temp file is removed when the write or
// rename throws, and the error propagates to the caller's own handling.
function writeFileAtomically(path, data, { mode } = {}) {
	let target = path;
	try {
		target = realpathSync(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	let targetMode = mode;
	if (targetMode === undefined) {
		try {
			targetMode = statSync(target).mode & 0o777;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	const tempPath = join(dirname(target), `.${basenameOf(target)}.gentle-shell-${process.pid}.tmp`);
	try {
		writeFileSync(tempPath, data);
		if (targetMode !== undefined) chmodSync(tempPath, targetMode);
		renameSync(tempPath, target);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function loadConfig() {
	const text = readJsonIfExists(resolveConfigPath());
	return text === undefined ? undefined : parseLauncherConfig(text);
}

function handleHomeCommand(commandArgs) {
	if (commandArgs.length === 0) {
		const resolved = resolveHome({ args: emptyArgs(), env: process.env, homedir: homedir(), config: loadConfig() });
		process.stdout.write(`${resolved.mode} ${resolved.dir}\n`);
		process.exit(0);
	}
	if (commandArgs.length > 1) fail("nub-ia home accepts at most one argument. Run 'nub-ia --help'.", 2);
	const [value] = commandArgs;
	if (value.length === 0) fail("nub-ia home requires a non-empty argument. Run 'nub-ia --help'.", 2);

	const configPath = resolveConfigPath();
	const existing = readRawConfig(configPath);

	if (value === "link" || value === "isolated") {
		writeRawConfig(configPath, { ...existing, home: value });
		process.stdout.write(`Saved home: ${value}\n`);
		process.exit(0);
	}
	const dir = resolvePath(value);
	writeRawConfig(configPath, { ...existing, home: dir });
	process.stdout.write(`Saved home: path ${dir}\n`);
	process.exit(0);
}

// Spawns `command` and resolves once it exits, instead of exiting the
// process directly: the shared core the manual `setup` subcommand and the
// automatic first-run provisioning flow (S7) both drive, deciding for
// themselves whether to `process.exit` (setup) or warn and continue (auto
// mode). `stdio` lets a silent caller route the child's stdout/stderr to the
// launcher's own stderr (see runSetupFlow) while a manual `setup` keeps the
// child's stdio inherited. A `signal` on the result records that the child
// exited via signal for any reason; `interrupted: true` additionally marks
// that it happened because *this launcher itself* received
// SIGINT/SIGTERM/SIGHUP and forwarded it — as opposed to the child dying by a
// signal entirely on its own (a crash, an OOM kill, an external `kill`),
// which is an ordinary failure, not a request to stop (R3-002). Only
// `interrupted` lets a caller skip printing remediation advice and abort the
// whole launch; a plain `signal` with no `interrupted` is treated like any
// other failure. `timeoutMs`, when given, kills the child and resolves with
// `timedOut: true` instead of waiting forever on a hung pi
// invocation; only the automatic first-run flow passes it (see
// AUTO_SETUP_CHILD_TIMEOUT_MS below) — manual `setup` never times out.
function spawnAndWait(command, args, env, stdio, timeoutMs) {
	return new Promise((resolve) => {
		const launchPlan = planSpawn({ command, args, platform: process.platform });
		const child = spawn(launchPlan.command, launchPlan.args, { stdio, env, shell: launchPlan.shell });
		let timedOut = false;
		let interrupted = false;
		const timer = timeoutMs !== undefined ? setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs) : undefined;
		const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
			const handler = () => {
				interrupted = true;
				child.kill(signal);
			};
			process.on(signal, handler);
			return [signal, handler];
		});
		const cleanup = () => {
			for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
			if (timer !== undefined) clearTimeout(timer);
		};
		child.on("error", (error) => {
			cleanup();
			resolve({ ok: false, exitCode: 1, error });
		});
		child.on("exit", (code, signal) => {
			cleanup();
			if (timedOut) {
				resolve({ ok: false, exitCode: 1, timedOut: true });
				return;
			}
			if (signal) {
				resolve(
					interrupted
						? { ok: false, exitCode: signalExitCode(signal), signal, interrupted: true }
						: { ok: false, exitCode: signalExitCode(signal), signal },
				);
				return;
			}
			const exitCode = code ?? 1;
			resolve({ ok: exitCode === 0, exitCode });
		});
	});
}

// Renders `ms` as a human ceiling for a "timed out after ..." message: whole
// minutes when `ms` is an exact multiple of 60000 (matching the production
// 15-minute default and any operator-chosen whole-minute override), seconds
// otherwise — including the sub-second overrides
// GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS sets in tests. Used at every "timed out
// after ..." call site instead of a hardcoded "15 minutes"
// (R2-timeout-message-hardcoded), so the message always reflects the ceiling
// that actually fired.
function formatTimeoutCeiling(ms) {
	if (ms % 60000 === 0) {
		const minutes = ms / 60000;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const seconds = ms / 1000;
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// Shared env for the pi install spawns below: PI_CODING_AGENT_DIR/
// GENTLE_PI_AGENT_HOME point at the resolved home, and the resolved pi
// runtime's directory is prepended to PATH so pi finds itself even when it is
// bundled or given through GENTLE_SHELL_PI.
function buildSetupEnv(home, runtime) {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: home.dir,
		GENTLE_PI_AGENT_HOME: home.dir,
		PATH: `${dirname(runtime.command)}${delimiter}${process.env.PATH ?? ""}`,
	};
}

function basenameOf(path) {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1];
}

// Reads a JSON file's raw text, tolerating a missing or unparsable file by
// returning undefined: there is nothing worth restoring later in that case.
function readParsableJsonText(path) {
	const text = readJsonIfExists(path);
	if (text === undefined) return undefined;
	try {
		JSON.parse(text);
	} catch {
		return undefined;
	}
	return text;
}

// Restores the home's own settings.json "theme" field to whatever it was
// right before the pi install spawns (`originalSettingsText`) — pi's
// managed install may write its own theme into settings.json, which would
// otherwise silently replace the theme Nub-IA had going in. This is a
// field-level snapshot/restore around the spawn, not a "only act if there
// was no theme before" check: on a brand-new home, the isolated-home
// bootstrap (installIsolatedTuiModeSetting, withIsolatedHomeDefaults in
// scripts/install-tui-mode-setting.mjs) already wrote DEFAULT_THEME_NAME
// into settings.json before this snapshot is taken, so `originalSettingsText`
// already declares a theme there too — a check that skipped restoring
// whenever the original had a theme would never fire on a fresh home and let
// the install's own theme win. When the original truly declared a theme
// (either that bootstrap default, or the user's own earlier choice),
// whatever the install changed it to afterward is restored via the pure
// restoreJsonField (lib/gentle-shell-launcher.ts). When the original had no
// theme at all, there is nothing to restore, so DEFAULT_THEME_NAME is forced
// instead via forceJsonFieldIfAbsentInOriginal, so a home still ends up
// themed. Unlike the persona/state restores above, this is not a shared file
// outside the home — it is the home's own settings.json, so no whole-file
// snapshot/restore pairing is needed, only a before/after comparison.
// Returns "restored" or "forced" when it actually wrote the file (so the
// caller can print the matching notice), or false when nothing changed.
function enforceDefaultThemeField(settingsPath, originalSettingsText) {
	if (originalSettingsText === undefined) return false;
	const currentText = readJsonIfExists(settingsPath);
	if (currentText === undefined) return false;
	let originalHadTheme;
	try {
		const originalValue = JSON.parse(originalSettingsText);
		originalHadTheme = typeof originalValue === "object" && originalValue !== null && !Array.isArray(originalValue) && Object.prototype.hasOwnProperty.call(originalValue, "theme");
	} catch {
		return false;
	}
	const newText = originalHadTheme
		? restoreJsonField(originalSettingsText, currentText, "theme")
		: forceJsonFieldIfAbsentInOriginal(originalSettingsText, currentText, "theme", DEFAULT_THEME_NAME);
	if (newText === undefined) return false;
	writeFileAtomically(settingsPath, newText);
	return originalHadTheme ? "restored" : "forced";
}

// Never let a snapshot/restore step itself abort setup: a persona.json or
// state.json this launcher cannot read or write for an unexpected reason
// (EACCES, ENOSPC, a path that turned into a directory, ...) must not crash
// `nub-ia setup` or block the automatic first-run flow from still
// launching pi — it only means that one file's shared-state protection did
// not apply this run. `label` and `path` identify what failed to the user;
// the caller decides what "safe" default to fall back to.
function safely(label, path, fallback, fn) {
	try {
		return fn();
	} catch (error) {
		process.stderr.write(`nub-ia: could not ${label} at ${path} (${error.message}); continuing\n`);
		return fallback;
	}
}

// gentle-pi replaces Pi's replaceable builtin codemode with its own decorated
// codemode tool (extensions/quiet-tools.ts -> registerCompactCodemode in
// lib/codemode-renderer.ts), and Pi prints a startup warning whenever a
// builtin loses its tool to another extension. Pi's only per-builtin opt-out
// is a `-builtin:<name>` entry in the settings `extensions` array, so every
// normal launch ensures that entry in the settings.json of a home
// nub-ia owns (see main, below).
const BUILTIN_CODEMODE_EXTENSION = "builtin:codemode";

// Pure: returns `settingsText` with `-<builtin>` appended to its `extensions`
// array (created when absent), or undefined when nothing should change — the
// text does not parse as a JSON object, `extensions` exists but is not an
// array, or the array already holds any explicit entry for the builtin
// (`+`, `-`, `!`, or bare), which is the user's own decision. Keeps every
// other key and entry in place, plus the text's own indentation and trailing
// newline (same detection as detectJsonFormatting in
// lib/gentle-shell-launcher.ts).
function withBuiltinExtensionExcluded(settingsText, builtin) {
	let settings;
	try {
		settings = JSON.parse(settingsText);
	} catch {
		return undefined;
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
	const extensions = Object.prototype.hasOwnProperty.call(settings, "extensions") ? settings.extensions : [];
	if (!Array.isArray(extensions)) return undefined;
	if (extensions.some((entry) => typeof entry === "string" && entry.replace(/^[+!-]/, "") === builtin)) return undefined;
	const indent = settingsText.match(/\{\r?\n([ \t]+)/)?.[1];
	const serialized = JSON.stringify({ ...settings, extensions: [...extensions, `-${builtin}`] }, null, indent);
	return settingsText.endsWith("\n") ? `${serialized}\n` : serialized;
}

// Applies withBuiltinExtensionExcluded to an existing settings.json with the
// same atomic temp-file-then-rename write as the restores above. A missing
// settings.json is left missing: only the brand-new-home bootstrap
// (installIsolatedTuiModeSetting) seeds that file, and this launch-time step
// never takes over that role. Returns true when it actually wrote the file.
function ensureBuiltinCodemodeExcluded(settingsPath) {
	const currentText = readJsonIfExists(settingsPath);
	if (currentText === undefined) return false;
	const newText = withBuiltinExtensionExcluded(currentText, BUILTIN_CODEMODE_EXTENSION);
	if (newText === undefined) return false;
	writeFileAtomically(settingsPath, newText);
	return true;
}

// Provisions `home`: installs the team companion packages (lib/gentle-shell-
// launcher.ts TEAM_PACKAGE_SOURCES) the home does not declare yet, through the
// resolved pi runtime's own `install`. `home` and `runtime` are resolved by the
// caller exactly as a normal run resolves them (including the isolated/--home
// bootstrap and the pi version gate).
//
// Returns {ok, exitCode, message?} instead of exiting the process: the manual
// `setup` subcommand (handleSetupCommand) exits on the result, and the
// automatic first-run flow (maybeAutoProvisionHome) warns and continues the
// launch on failure instead. `stdio` is threaded through to the child spawns
// unchanged -- "inherit" for a manual `setup`, or `["ignore", 2, 2]` in auto
// mode so every child's stdout/stderr lands on this launcher's own stderr and
// its real stdout stays clean for `--mode rpc`/`-p` consumers. `timeoutMs` is
// threaded into every child this flow spawns -- manual `setup` never passes it,
// so it never times out; the automatic flow does.
async function runSetupFlow(home, runtime, { dryRun, stdio, timeoutMs }) {
	process.stderr.write(`nub-ia: provisioning ${home.dir} with the team packages\n`);
	if (dryRun) {
		for (const source of resolveTeamPackageSources(process.env)) {
			process.stderr.write(`nub-ia: setup would then install team package ${source} unless the home already declares it\n`);
		}
		return { ok: true, exitCode: 0 };
	}
	// Theme enforcement (never for --link: that home is the user's own
	// pre-existing pi agent home): snapshot the home's own settings.json theme
	// right before the pi installs, so enforceDefaultThemeField can put it back
	// afterward if they changed it -- whether that theme was the isolated-home
	// bootstrap's own default or the user's own earlier choice.
	const trackTheme = home.mode !== "link";
	const settingsPath = join(home.dir, "settings.json");
	const originalSettingsText = trackTheme ? safely("read your Pi settings file", settingsPath, undefined, () => readParsableJsonText(settingsPath)) : undefined;
	try {
		return await installTeamPackages(home, runtime, stdio, timeoutMs);
	} finally {
		const themeOutcome = trackTheme ? safely("apply the default Nub-IA theme", settingsPath, false, () => enforceDefaultThemeField(settingsPath, originalSettingsText)) : false;
		if (themeOutcome === "forced") {
			process.stderr.write(`nub-ia: set the default ${DEFAULT_THEME_NAME} theme for ${home.dir} (no theme was set before this run)\n`);
		} else if (themeOutcome === "restored") {
			process.stderr.write(`nub-ia: kept your Pi theme unchanged (pi rewrote ${settingsPath})\n`);
		}
	}
}

// Installs the team companion packages (lib/gentle-shell-launcher.ts
// TEAM_PACKAGE_SOURCES) the home does not declare yet, via the resolved pi
// runtime's own `install`, after the conflict cleanup so settings.json is

async function installTeamPackages(home, runtime, stdio, timeoutMs) {
	const settingsText = readJsonIfExists(join(home.dir, "settings.json"));
	const pending = teamPackagesToInstall(settingsText, resolveTeamPackageSources(process.env));
	return installTeamPackageSources(pending, 0, home, runtime, stdio, timeoutMs);
}

async function installTeamPackageSources(sources, index, home, runtime, stdio, timeoutMs) {
	if (index >= sources.length) return { ok: true, exitCode: 0 };
	const source = sources[index];
	process.stderr.write(`nub-ia: installing team package ${source} into ${home.dir}\n`);
	const env = buildSetupEnv(home, runtime);
	const result = await spawnAndWait(runtime.command, [...runtime.args, "install", source], env, stdio, timeoutMs);
	if (result.timedOut) {
		return { ok: false, exitCode: 1, message: `nub-ia: pi install ${source} timed out after ${formatTimeoutCeiling(timeoutMs)}` };
	}
	if (result.error) {
		return { ok: false, exitCode: 1, message: `Could not run the pi runtime to install ${source}: ${result.error.message}` };
	}
	if (!result.ok) {
		if (result.interrupted) return result;
		const remediation = [...homeSelectorFlags(home).map(shellQuote), "install", source].join(" ");
		return { ok: false, exitCode: result.exitCode, message: `nub-ia: could not install ${source}; run \`nub-ia ${remediation}\` to retry` };
	}
	return installTeamPackageSources(sources, index + 1, home, runtime, stdio, timeoutMs);
}

// CLI entry for `nub-ia [home selectors] setup [--dry-run]`: parses
// --dry-run, runs the shared flow with the child's stdio inherited (today's
// behavior, unchanged), then exits with its result — this is the one place
// that keeps the pre-S7 exit semantics `handleSetupCommand` always had.
async function handleSetupCommand(commandArgs, home, runtime) {
	let dryRun = false;
	for (const arg of commandArgs) {
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		fail(`Unrecognized argument for 'nub-ia setup': ${arg}\nRun 'nub-ia --help' for usage.`, 2);
	}

	const result = await runSetupFlow(home, runtime, { dryRun, stdio: "inherit" });
	if (!result.ok && result.message !== undefined) process.stderr.write(`${result.message}\n`);
	process.exit(result.exitCode);
}

const AUTO_SETUP_OPT_OUT_ENV = "GENTLE_SHELL_NO_AUTO_SETUP";
const SETUP_LOCK_STALE_MS = 15 * 60 * 1000;

// nub-ia never auto-provisions a home it does not itself own: the
// dedicated isolated home is always owned outright, but a `--home <path>` (or
// a persisted `home <path>` config) can just as easily name the user's real
// pi agent directory, or any other pre-existing, unrelated directory. Only a
// path home that is new (does not exist yet) or empty — or one this launcher
// has already provisioned before, per the config marker — is fair game;
// everything else (R1-001) is left alone with a one-time hint instead.
function defaultPiAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function printForeignHomeHint(home, reason) {
	const remediation = [...homeSelectorFlags(home).map(shellQuote), "setup"].join(" ");
	process.stderr.write(`nub-ia: ${home.dir} ${reason}; run \`nub-ia ${remediation}\` to provision it\n`);
}

// Ownership marker (R3-001): written into a home's own directory by the
// isolated/--home bootstrap (main, below) the moment nub-ia creates
// that home — the same place it seeds settings.json with tuiMode. Lets
// homeIsForeign recognize a home nub-ia itself created even when the
// config.json provisioning marker was never written because the *first*
// auto-provision attempt against it failed (a --home directory whose
// bootstrap already seeded settings.json otherwise looks identical to an
// unrelated non-empty directory on the next launch, and would be treated as
// foreign and never retried). Content is a one-line JSON object naming the
// launcher version that created it, purely informational — homeIsForeign
// only checks the file's existence.
const HOME_OWNERSHIP_MARKER_FILENAME = ".nub-ia-home";

function homeOwnershipMarkerPath(home) {
	return join(home.dir, HOME_OWNERSHIP_MARKER_FILENAME);
}

function writeHomeOwnershipMarker(home) {
	const content = JSON.stringify({ createdBy: "nub-ia", version: ownPackageVersion() });
	writeFileSync(homeOwnershipMarkerPath(home), `${content}\n`, "utf8");
}

// `homeHadContentBeforeBootstrap` must be read by the caller (main, below)
// before the isolated/--home bootstrap runs: that bootstrap itself creates
// and seeds a brand-new directory (settings.json with tuiMode, and now the
// ownership marker above), so checking directory contents from inside this
// function would always see that seeded content and wrongly call a genuinely
// fresh home "foreign".
function homeIsForeign(home, previousEntry, homeHadContentBeforeBootstrap) {
	if (home.mode !== "path") return false; // the isolated home is always owned
	if (previousEntry !== undefined) return false; // already provisioned by nub-ia before; trust the marker
	if (safeRealpath(home.dir) === safeRealpath(defaultPiAgentDir())) return true; // never touch pi's own default home, even if empty
	if (existsSync(homeOwnershipMarkerPath(home))) return false; // nub-ia's own bootstrap created this home (R3-001); retry it even after a failed first attempt
	return homeHadContentBeforeBootstrap;
}

// Guards concurrent first-run auto-provisioning of the same home: an
// exclusive create (`wx`) fails when the lock already exists. A lock file
// younger than SETUP_LOCK_STALE_MS means another nub-ia process is (or
// very recently was) provisioning this home, so this run skips
// auto-provisioning entirely rather than racing another setup;
// the existing lock is left untouched since this run never owned it. An
// older lock is stale — a previous run crashed or was killed before its
// `finally` released it — so it is removed here, but only after re-stating
// it immediately before the removal to confirm it is *still* stale at that
// exact moment: a concurrent process may have refreshed it (or removed and
// recreated it) between the first check and now, and a lock a racing process
// just legitimately acquired must never be deleted out from under it. If the
// post-removal retry `wx` create itself then fails (another process won the
// race to recreate it first), this run simply skips provisioning rather than
// looping. Any unexpected fs error (permissions, a vanished lock between the
// EEXIST and a stat, …) must never block the launch, so it resolves to
// "proceed" rather than failing closed.
function lockAgeMs(lockPath) {
	return Date.now() - statSync(lockPath).mtimeMs;
}

function acquireSetupLock(lockPath) {
	try {
		closeSync(openSync(lockPath, "wx"));
		return true;
	} catch (error) {
		if (error.code !== "EEXIST") return true;
		let age;
		try {
			age = lockAgeMs(lockPath);
		} catch {
			return true;
		}
		if (age < SETUP_LOCK_STALE_MS) {
			process.stderr.write(
				`nub-ia: another nub-ia process is already provisioning ${dirname(lockPath)}; skipping automatic setup for this run\n`,
			);
			return false;
		}
		let ageNow;
		try {
			ageNow = lockAgeMs(lockPath);
		} catch {
			return false;
		}
		if (ageNow < SETUP_LOCK_STALE_MS) return false;
		try {
			rmSync(lockPath, { force: true });
		} catch {
			return false;
		}
		try {
			closeSync(openSync(lockPath, "wx"));
			return true;
		} catch {
			return false;
		}
	}
}

function releaseSetupLock(lockPath) {
	try {
		rmSync(lockPath, { force: true });
	} catch {
		// Best-effort cleanup only: a missing or unremovable lock file must
		// never fail an otherwise-successful (or already-failed) run.
	}
}

// Ceiling for every child this flow spawns (S9): a hung
// pi invocation must never hang a plain `nub-ia` launch forever.
// Test/development only: GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS overrides the
// 15-minute ceiling so a test can exercise it without actually waiting;
// documented as test/development-only in docs/readme-reference.md. Manual
// `setup` never passes a timeout at all (see handleSetupCommand).
const AUTO_SETUP_CHILD_TIMEOUT_MS = 15 * 60 * 1000;

function resolveAutoSetupTimeoutMs() {
	const override = process.env.GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS;
	const parsed = override !== undefined && override.length > 0 ? Number(override) : undefined;
	return parsed !== undefined && Number.isFinite(parsed) ? parsed : AUTO_SETUP_CHILD_TIMEOUT_MS;
}

// Runs the same flow as `nub-ia setup` automatically before a plain
// launch, for an isolated or `--home <path>` home that was never provisioned
// or was provisioned by a different nub-ia version (S7). Never runs for
// `--link` (the caller only calls this for home.mode "isolated"/"path") or a
// pi subcommand (the caller only calls this when args.piSubcommand is
// undefined) — see main() below. Never blocks the launch: a failure (an
// older pin, a missing binary the self-heal could not recover, a non-zero
// pi exit, a timeout, or a spawned child dying by a signal on
// its own — a crash, an OOM kill, an external `kill`, never something this
// launcher asked for) only warns and lets the plain launch continue with
// today's injection behavior, to retry automatically on a later run —
// except an interrupt (SIGINT/SIGTERM/SIGHUP) actually reaching *this
// launcher*, which forwards it to the spawned child and returns
// `{ exitCode }` instead (R3-002) so the caller (main, below) exits the
// whole launcher immediately without starting pi (S9): the user asked this
// process to stop, not to fall back to a plain launch. Returns undefined to
// mean "continue the launch normally".
async function maybeAutoProvisionHome(home, runtime, { homeHadContentBeforeBootstrap }) {
	if (process.env[AUTO_SETUP_OPT_OUT_ENV] === "1") return undefined;

	const configPath = resolveConfigPath();
	const homeKey = safeRealpath(home.dir);
	const gentlePiVersion = ownPackageVersion();
	const beforeConfig = readRawConfig(configPath);
	if (!needsProvisioning(beforeConfig, homeKey, gentlePiVersion)) return undefined;

	const previous = provisionedEntry(beforeConfig, homeKey);
	if (homeIsForeign(home, previous, homeHadContentBeforeBootstrap)) {
		const reason =
			safeRealpath(home.dir) === safeRealpath(defaultPiAgentDir())
				? "is pi's own default agent home; nub-ia never auto-provisions it"
				: "already has content and was not set up by nub-ia";
		printForeignHomeHint(home, reason);
		return undefined;
	}

	const lockPath = join(home.dir, ".nub-ia-setup.lock");
	if (!acquireSetupLock(lockPath)) return undefined;

	try {
		if (previous === undefined) {
			process.stderr.write(
				`nub-ia: first run in ${home.dir}: installing the team packages (one time; set ${AUTO_SETUP_OPT_OUT_ENV}=1 to skip)\n`,
			);
		} else {
			// A marker written before launcher version tracking (or by a build that
			// provisioned the gentle-ai binary) has no `gentlePi` field or still
			// carries a legacy `gentleAi` one: needsProvisioning above treats that
			// as changed, so this reports "unknown" as its prior version.
			process.stderr.write(`nub-ia changed (${previous.gentlePi ?? "unknown"} -> ${gentlePiVersion}): updating ${home.dir}\n`);
		}

		const result = await runSetupFlow(home, runtime, { dryRun: false, stdio: ["ignore", 2, 2], timeoutMs: resolveAutoSetupTimeoutMs() });
		// Abort the whole launch only for a launcher-forwarded interrupt
		// (R3-002); a child that exited via signal on its own (crash, OOM kill,
		// external kill) falls through to the ordinary-failure branch below,
		// which warns and still starts pi.
		if (result.interrupted) return { exitCode: result.exitCode };
		if (!result.ok) {
			const remediation = [...homeSelectorFlags(home).map(shellQuote), "setup"].join(" ");
			process.stderr.write(
				`nub-ia: automatic setup failed (exit ${result.exitCode}); starting anyway and retrying next run. Run \`nub-ia ${remediation}\` to see the full output.\n`,
			);
			if (result.message !== undefined) process.stderr.write(`${result.message}\n`);
			return undefined;
		}

		writeRawConfig(configPath, recordProvisioned(readRawConfig(configPath), homeKey, gentlePiVersion, new Date().toISOString()));
		return undefined;
	} finally {
		releaseSetupLock(lockPath);
	}
}

async function main() {
	const args = parseLauncherArgs(process.argv.slice(2));
	if (args.error !== undefined) fail(`${args.error}\nRun 'nub-ia --help' for usage.`, 2);
	if (args.help) {
		process.stdout.write(`${helpText()}\n`);
		process.exit(0);
	}
	if (args.command === "home") {
		handleHomeCommand(args.commandArgs);
		return;
	}

	const config = loadConfig();
	let home = resolveHome({ args, env: process.env, homedir: homedir(), config });
	if (home.mode === "path") home = { ...home, dir: resolvePath(home.dir) };

	const runtime = resolvePiRuntime({
		env: process.env,
		resolveBundledCli,
		findOnPath,
		nodeExecPath: process.execPath,
	});
	if (runtime === undefined) fail(missingPiMessage(), 1);

	const versionProbePlan = planSpawn({ command: runtime.command, args: [...runtime.args, "--version"], platform: process.platform });
	const versionProbe = spawnSync(versionProbePlan.command, versionProbePlan.args, {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15000,
		encoding: "utf8",
		shell: versionProbePlan.shell,
	});
	if (versionProbe.error) fail(`Could not run the pi runtime at "${runtime.command}": ${versionProbe.error.message}`, 1);
	const versionCheck = checkPiVersion(versionProbe.stdout ?? "");
	if (!versionCheck.ok) fail(versionCheck.message, 1);

	if (args.version) {
		process.stdout.write(`${describeVersion({ gentlePiVersion: ownPackageVersion(), piVersion: versionCheck.version, home })}\n`);
		process.exit(0);
	}

	// Home-ownership signal for auto-provisioning (S9, homeIsForeign): must be
	// read before the isolated-home bootstrap below creates and seeds a
	// brand-new --home directory with its own settings.json — after that
	// bootstrap runs, "did this home already have content" can no longer be
	// answered by looking at the directory.
	let homeHadContentBeforeBootstrap = false;
	if (existsSync(home.dir)) {
		try {
			homeHadContentBeforeBootstrap = readdirSync(home.dir).length > 0;
		} catch {
			homeHadContentBeforeBootstrap = false;
		}
	}

	// Isolated-home bootstrap: only on a home nub-ia has not seen before
	// (link never bootstraps — it reuses the user's own pi agent home as-is).
	if ((home.mode === "isolated" || home.mode === "path") && !existsSync(home.dir)) {
		mkdirSync(home.dir, { recursive: true });
		await installIsolatedTuiModeSetting(home.dir);
		writeHomeOwnershipMarker(home); // R3-001: lets a failed first auto-provision attempt still be retried later
		process.stderr.write(`nub-ia: using a separate home at ${home.dir}. Run 'nub-ia --link' to reuse your pi sign-ins and chats.\n`);
	}

	if (args.command === "setup") {
		await handleSetupCommand(args.commandArgs, home, runtime);
		return;
	}

	// Auto-provision (S7): a plain launch against an isolated or --home home
	// (never --link) runs the same flow as `nub-ia setup` automatically
	// before pi starts, so the maintainer's own packages install without ever
	// needing to know `setup` exists. Skipped for a pi subcommand
	// (`nub-ia install/remove/list/...`) — argv[0] must stay the bare
	// subcommand for pi to dispatch it, same reason the declaration/take-over
	// block below skips it. Must run before that block reads settings.json,
	// so that block sees settings.json exactly as this same auto-provision run
	// (if any) left it — notably with any npm:gentle-pi declaration already
	// removed again by runPostInstallCleanup, since the home never actually
	// keeps that declaration — instead of reading stale pre-setup content
	// within the same launch. Never lets an unexpected failure here (fs
	// errors, a lock, a malformed config) block the launch itself (R4): any
	// throw is caught and only warned about, exactly like an ordinary
	// setup-flow failure.
	if ((home.mode === "isolated" || home.mode === "path") && args.piSubcommand === undefined) {
		let autoProvisionResult;
		try {
			autoProvisionResult = await maybeAutoProvisionHome(home, runtime, { homeHadContentBeforeBootstrap });
		} catch (error) {
			process.stderr.write(`nub-ia: automatic setup failed unexpectedly (${error.message}); starting anyway and retrying next run.\n`);
			autoProvisionResult = undefined;
		}
		// Only an interrupt reaching the spawned child (SIGINT/SIGTERM/SIGHUP)
		// returns a result here: the user asked this process to stop, so it
		// exits with the same signal-derived code instead of falling through
		// to launch pi.
		if (autoProvisionResult !== undefined) process.exit(autoProvisionResult.exitCode);

		// Runs after auto-provision, so it sees settings.json exactly as that
		// run left it. Only a home nub-ia owns, by the same rule
		// auto-provisioning uses (homeIsForeign): never --link (excluded above),
		// a foreign --home, or pi's own default agent home, since plain pi may
		// share those and would lose its builtin codemode. `setup` (including
		// --dry-run) returned before this point.
		const settingsPath = join(home.dir, "settings.json");
		const excluded = safely("exclude Pi's builtin codemode in your Nub-IA settings", settingsPath, false, () => {
			const previous = provisionedEntry(readRawConfig(resolveConfigPath()), safeRealpath(home.dir));
			return !homeIsForeign(home, previous, homeHadContentBeforeBootstrap) && ensureBuiltinCodemodeExcluded(settingsPath);
		});
		if (excluded) {
			process.stderr.write(`nub-ia: disabled Pi's builtin codemode in ${settingsPath} (Nub-IA ships its own codemode tool)\n`);
		}
	}

	const packageRootExplicit = args.packageRoot !== undefined;
	const effectivePackageRoot = packageRootExplicit ? resolvePath(args.packageRoot) : packageRoot;
	// R4-forced-package-root-unvalidated / R3-005: an unvalidated --package-root
	// forces a take-over (dropping normal extension discovery via
	// --no-extensions) and then hands pi -e/--theme/--skill/--prompt-template
	// flags pointing at directories that do not exist, turning an operator typo
	// into an obscure pi loader failure instead of a clear launcher error.
	if (packageRootExplicit && !isDirectory(effectivePackageRoot)) {
		fail(`--package-root ${args.packageRoot} does not exist or is not a directory.`, 2);
	}

	let declaration;
	let takeOver = false;
	let otherPackagePaths = [];
	let looseExtensionEntries = [];

	// Every mode consults the home's own settings.json for a gentle-pi
	// declaration, not just --link: `nub-ia setup` installs
	// npm:gentle-pi into an isolated or --home home's settings.json, and once
	// that declaration exists the launcher must stop injecting its own copy
	// on top of it (buildPiInvocation skips injection whenever a declaration
	// is present and there is no take-over). A path declaration in a
	// non-link home follows the same take-over rules as --link. A home
	// without any declaration keeps the plain injection, unchanged.
	//
	// --package-root only forces a take-over in --link mode: an isolated or
	// --home target has no pre-existing pi installation to defer to, so
	// forcing --no-extensions there would just strip its own settings-driven
	// discovery for no benefit (see the "gated on link mode" bin test). A pi
	// subcommand skips this whole block: buildPiInvocation ignores
	// takeOver/declaration once piSubcommand is set, and running the
	// take-over/loose-dir discovery anyway would still print a misleading
	// "taking over gentle-pi..." message (and otherPackageInjections
	// warnings) for a plain `nub-ia install npm:x` that never actually
	// takes anything over.
	if (args.piSubcommand === undefined) {
		const settingsText = readJsonIfExists(join(home.dir, "settings.json"));
		declaration = findGentlePiDeclaration(settingsText, { agentDir: home.dir, readPackageName });
		// --package-root only forces a take-over in --link mode (see below);
		// in every other mode a declared home silently keeps using its
		// declared gentle-pi and --package-root has no effect at all. Warn
		// once so an operator does not assume --package-root took effect.
		if (packageRootExplicit && home.mode !== "link" && declaration !== undefined) {
			process.stderr.write(
				`nub-ia: --package-root only forces a take-over in --link mode; ${home.dir} declares gentle-pi, so the installed package is used and ${args.packageRoot} is ignored\n`,
			);
		}
		const realEffectivePackageRoot = safeRealpath(effectivePackageRoot);
		const realDeclaredDir = declaration?.kind === "path" ? safeRealpath(declaration.dir) : undefined;
		takeOver = decideTakeOver({
			declaration,
			realPackageRoot: realEffectivePackageRoot,
			realDeclaredDir,
			packageRootExplicit: home.mode === "link" && packageRootExplicit,
		});
		if (takeOver) {
			const skip = declaration ?? { kind: "path", dir: realEffectivePackageRoot };
			const injections = otherPackageInjections({ settingsText, agentDir: home.dir, skip, isDirectory, realpath: safeRealpath });
			otherPackagePaths = injections.paths;
			for (const warning of injections.warnings) process.stderr.write(`${warning}\n`);
			// --no-extensions drops pi's normal settings-driven extension
			// discovery, which also covers loose (non-package) extensions
			// under <agentDir>/extensions and the project-local
			// <cwd>/.pi/extensions. Re-injecting either directory wholesale
			// as `-e <dir>` does not work for a directory of loose files: pi's
			// -e flag hands the path straight to its module loader with no
			// directory-discovery pass, so a bare directory of loose files
			// fails with "Cannot find module ...". Resolve each candidate
			// into its actual loose file entries (or pass it through
			// unchanged when it is itself a self-contained extension) so a
			// take-over does not silently stop loading them.
			looseExtensionEntries = [join(home.dir, "extensions"), join(process.cwd(), ".pi", "extensions")].flatMap(resolveLooseExtensionEntries);
			const declaredFrom = declaration === undefined ? "the requested package root" : declaration.kind === "npm" ? "npm:gentle-pi" : declaration.dir;
			process.stderr.write(
				`nub-ia: taking over gentle-pi from ${declaredFrom} for this run (settings unchanged; its skills, prompts, and themes still load alongside this launcher's).\n`,
			);
		}
	}

	const invocation = buildPiInvocation({
		runtime,
		home,
		packageRoot: effectivePackageRoot,
		declaration,
		takeOver,
		otherPackagePaths,
		looseExtensionEntries,
		passthrough: [...managedHerdrExtensionArgs(home, args), ...args.passthrough],
		piSubcommand: args.piSubcommand,
		baseEnv: process.env,
		homedir: homedir(),
		// The spawn below sets no cwd, so pi runs in the launcher's own.
		cwd: process.cwd(),
	});

	// Only an interactive session ends with pi's exit resume hint, which
	// nub-ia completes with its own line; a pi subcommand gets no handoff.
	const resumeHandoff = args.piSubcommand === undefined ? createResumeHandoff() : undefined;
	const childEnv = resumeHandoff ? { ...invocation.env, [RESUME_HANDOFF_ENV]: resumeHandoff.path } : invocation.env;

	const launchPlan = planSpawn({ command: invocation.command, args: invocation.args, platform: process.platform });
	let child;
	try {
		child = spawn(launchPlan.command, launchPlan.args, { stdio: "inherit", env: childEnv, shell: launchPlan.shell });
	} catch (error) {
		resumeHandoff?.dispose();
		throw error;
	}
	// Only SIGHUP means the terminal is gone. pi may survive a forwarded
	// SIGINT and keep running, so other signals must not silence the hint.
	let terminalHungUp = false;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => {
			if (signal === "SIGHUP") terminalHungUp = true;
			child.kill(signal);
		});
	}
	child.on("error", (error) => {
		resumeHandoff?.dispose();
		fail(`Could not start pi: ${error.message}`, 1);
	});
	child.on("exit", (code, signal) => {
		const exitCode = signal ? signalExitCode(signal) : (code ?? 1);
		if (resumeHandoff) {
			const hint = planResumeHint({
				handoff: resumeHandoff.read(),
				homeFlags: homeSelectorFlags(home),
				stdoutIsTTY: process.stdout.isTTY === true,
				terminalHungUp,
				platform: process.platform,
				color: process.stdout.hasColors?.() === true,
			});
			resumeHandoff.dispose();
			// TTY writes are asynchronous on Windows: exit only once the
			// hint is flushed, or it can be lost.
			if (hint) {
				// A write error (e.g. EIO on a closed terminal) must not turn
				// pi's exit into a launcher crash.
				process.stdout.once("error", () => process.exit(exitCode));
				process.stdout.write(hint, () => process.exit(exitCode));
				return;
			}
		}
		process.exit(exitCode);
	});
}

// Private temp dir for the resume-hint handoff (lib/gentle-shell-resume-hint.ts).
// Best effort: if it cannot be created, only pi's own hint is printed.
function createResumeHandoff() {
	let dir;
	try {
		dir = mkdtempSync(join(tmpdir(), RESUME_HANDOFF_DIR_PREFIX));
	} catch {
		return undefined;
	}
	const path = join(dir, RESUME_HANDOFF_FILE);
	return {
		path,
		read: () => {
			try {
				const text = readJsonIfExists(path);
				return text === undefined ? undefined : parseResumeHandoff(text);
			} catch {
				return undefined;
			}
		},
		// Never throws: it runs inside the exit handler, where an EPERM on
		// Windows would otherwise replace pi's exit code with a crash.
		dispose: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// A leftover empty temp dir is harmless.
			}
		},
	};
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
