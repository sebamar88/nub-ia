import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Nub-IA config homes. WRITES always go to the nub-ia home (`~/.pi/nub-ia/`,
// `.pi/nub-ia/`); READS look there first and then fall back to the legacy
// gentle-ai home so existing user configuration keeps working unchanged.

export const NUB_IA_DIR = "nub-ia";
export const LEGACY_DIR = "gentle-ai";

/** First defined value among the given env names (earlier names take precedence). */
export function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Canonical config home: NUB_IA_CONFIG_HOME, else ~/.pi/nub-ia. */
export function nubIaConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.NUB_IA_CONFIG_HOME || join(homedir(), ".pi", NUB_IA_DIR);
}

/** Legacy read-fallback home: ~/.pi/gentle-ai (the pre-rebrand config home). */
export function legacyConfigHome(): string {
	return join(homedir(), ".pi", LEGACY_DIR);
}

type HintNotifier = (message: string) => void;
let hintNotifier: HintNotifier | undefined;
let hintShown = false;

/** Route the one-time legacy hint to the UI instead of stderr. Pass undefined to restore stderr. */
export function setLegacyHintNotifier(notifier: HintNotifier | undefined): void {
	hintNotifier = notifier;
}

/** Test seam: allow the once-per-process hint to fire again. */
export function resetLegacyHintForTests(): void {
	hintShown = false;
}

function hintLegacyRead(legacyPath: string, file: string, writeHome: string): void {
	if (hintShown) return;
	hintShown = true;
	const message = `Nub-IA reads ${legacyPath}; it will be written to ${join(writeHome, file)} on the next save.`;
	if (hintNotifier) hintNotifier(message);
	else process.stderr.write(`${message}\n`);
}

/**
 * Path to READ `file` from a config home. When `home` is the nub-ia home and the
 * file is missing there but present in the legacy home, the legacy path is
 * returned (with a one-time hint). Otherwise the `home` path is returned, so a
 * missing file still reports the canonical location.
 */
export function configReadPath(home: string, file: string, env: NodeJS.ProcessEnv = process.env): string {
	const primary = join(home, file);
	if (existsSync(primary)) return primary;
	if (home !== nubIaConfigHome(env)) return primary;
	const legacyHome = legacyConfigHome();
	if (legacyHome === home) return primary;
	const legacy = join(legacyHome, file);
	if (!existsSync(legacy)) return primary;
	hintLegacyRead(legacy, file, home);
	return legacy;
}

/** Project-level WRITE path: `<cwd>/.pi/nub-ia/<file>`. */
export function projectConfigWritePath(cwd: string, file: string): string {
	return join(cwd, ".pi", NUB_IA_DIR, file);
}

/** Project-level READ path: `.pi/nub-ia/<file>`, falling back to `.pi/gentle-ai/<file>`. */
export function projectConfigReadPath(cwd: string, file: string): string {
	const primary = projectConfigWritePath(cwd, file);
	if (existsSync(primary)) return primary;
	const legacy = join(cwd, ".pi", LEGACY_DIR, file);
	if (!existsSync(legacy)) return primary;
	hintLegacyRead(legacy, file, join(cwd, ".pi", NUB_IA_DIR));
	return legacy;
}
