// Startup cost control for bin/nub-ia.mjs.
//
// 1. Stage trace: NUB_IA_TRACE_STARTUP=1 prints the elapsed time of every
//    launcher stage to stderr, so a slow start (cold Windows caches,
//    antivirus scanning node_modules, a slow git) can be attributed instead
//    of guessed.
// 2. pi version probe cache: `pi --version` boots pi's whole bundle just to
//    read three numbers. The result is cached next to config.json keyed by
//    the runtime's path, size and mtime, so a cold start boots pi once, not
//    twice. Any change to the pi install (update, reinstall, different
//    runtime) changes the fingerprint and re-probes.
import { readFileSync, statSync, realpathSync } from "node:fs";

export const TRACE_ENV = "NUB_IA_TRACE_STARTUP";
export const PI_VERSION_CACHE_FILE = "pi-version-cache.json";

/** Returns a `stage(label)` reporter; a no-op unless env[TRACE_ENV] === "1". */
export function createStartupTrace(env = process.env, { write = (line) => process.stderr.write(line), now = () => performance.now() } = {}) {
	if (env[TRACE_ENV] !== "1") return () => {};
	const start = now();
	let last = start;
	return (label) => {
		const current = now();
		write(`nub-ia: [startup] ${label.padEnd(28)} +${Math.round(current - last)} ms (total ${Math.round(current - start)} ms)\n`);
		last = current;
	};
}

/** Identity of the pi runtime: command + args + size/mtime of the file actually executed. */
export function piRuntimeFingerprint(runtime, { stat = statSync, realpath = realpathSync } = {}) {
	// Bundled: node <cli.js>; env/path: the pi binary or shim itself.
	const executed = runtime.args.length > 0 ? runtime.args[runtime.args.length - 1] : runtime.command;
	try {
		const real = realpath(executed);
		const info = stat(real);
		return { command: runtime.command, args: runtime.args, path: real, size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return undefined;
	}
}

/** Pure: the cached version when the entry matches `fingerprint` exactly, else undefined. */
export function cachedPiVersion(entry, fingerprint) {
	if (!entry || !fingerprint || entry.schema !== "nub-ia.pi-version-cache/v1") return undefined;
	const same = entry.command === fingerprint.command
		&& Array.isArray(entry.args) && entry.args.length === fingerprint.args.length && entry.args.every((arg, i) => arg === fingerprint.args[i])
		&& entry.path === fingerprint.path && entry.size === fingerprint.size && entry.mtimeMs === fingerprint.mtimeMs;
	return same && typeof entry.version === "string" ? entry.version : undefined;
}

/** Pure: the entry to persist after a successful probe. */
export function piVersionCacheEntry(fingerprint, version) {
	return { schema: "nub-ia.pi-version-cache/v1", ...fingerprint, version, probedAt: new Date().toISOString() };
}

/** Reads the cache file; any problem means "no cache". */
export function readPiVersionCache(path, read = readFileSync) {
	try {
		return JSON.parse(read(path, "utf8"));
	} catch {
		return undefined;
	}
}
