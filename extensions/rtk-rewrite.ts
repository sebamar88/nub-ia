// RTK command rewriting for Nub-IA. Before the bash tool runs, the command is
// handed to `rtk rewrite` (https://github.com/rtk-ai/rtk, MIT), which returns
// the token-saving equivalent (`git status` → `rtk git status`, `pnpm test` →
// `rtk pnpm test`, …) or signals that none exists. All rewrite rules live in
// rtk itself, so this file never needs to learn a new command.
//
// Shipping this inside the package means every Nub-IA home (isolated or
// --link) gets it without an `rtk init` step. It fails open: without an rtk
// binary (or with one older than 0.23.0, which introduced `rtk rewrite`)
// commands pass through unchanged and a one-line status says how to install
// it. RTK_DISABLED=1 turns the rewriting off for a session.
//
// Based on the extension `rtk init --agent pi` generates (rtk 0.51.0), adapted
// to the package: uses the package-local pinned binary (scripts/rtk-installer.mjs)
// before PATH, Nub-IA install hint, shared helpers exported for tests.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { RTK_VERSION } from "../scripts/rtk-installer.mjs";

export const RTK_REWRITE_TIMEOUT_MS = 2_000;
export const RTK_MIN_VERSION: readonly [number, number] = [0, 23];
export const RTK_INSTALL_HINT = "RTK off: no rtk binary — run `pnpm run install:rtk` in the nub-ia package (or put `rtk` on PATH) to cut tool-output tokens";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The rtk executable to use: an explicit GENTLE_SHELL_RTK_BIN, else the copy
 * the postinstall pinned under `<package>/.rtk/<version>/` (every Nub-IA
 * install ships it, so teammates need no separate rtk install), else a PATH
 * `rtk`.
 */
export function resolveRtkBinary(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT, platform: NodeJS.Platform = process.platform): string {
	const explicit = env.GENTLE_SHELL_RTK_BIN;
	if (explicit && explicit.length > 0) return explicit;
	const local = join(root, ".rtk", RTK_VERSION, platform === "win32" ? "rtk.exe" : "rtk");
	return existsSync(local) ? local : "rtk";
}

export interface ExecLike {
	(command: string, args: string[], options: { timeout?: number; signal?: AbortSignal }): Promise<{ code: number; stdout: string; killed?: boolean }>;
}

export function parseSemver(raw: string): [number, number, number] | undefined {
	const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Whether `rtk --version` output names a build that supports `rtk rewrite`. */
export function rtkVersionSupported(versionOutput: string): boolean {
	const parsed = parseSemver(versionOutput.replace(/^rtk\s+/, ""));
	if (!parsed) return true; // an unparsable version is not a reason to disable rewriting
	const [major, minor] = parsed;
	return major > RTK_MIN_VERSION[0] || (major === RTK_MIN_VERSION[0] && minor >= RTK_MIN_VERSION[1]);
}

/**
 * The rewritten command, or undefined to pass through. `rtk rewrite` exit
 * codes: 0 or 3 with stdout → rewrite; 1 → no equivalent; anything else or a
 * kill → pass through.
 */
export async function rewriteWithRtk(exec: ExecLike, command: string, signal?: AbortSignal, binary = "rtk"): Promise<string | undefined> {
	if (command.startsWith("rtk ")) return undefined;
	let result: Awaited<ReturnType<ExecLike>>;
	try {
		result = await exec(binary, ["rewrite", command], { timeout: RTK_REWRITE_TIMEOUT_MS, signal });
	} catch {
		return undefined;
	}
	if (result.killed || (result.code !== 0 && result.code !== 3)) return undefined;
	const rewritten = result.stdout.trim();
	if (rewritten.length === 0 || rewritten === command) return undefined;
	// The rewrite runs after every other tool_call guard evaluated the
	// original command (extensions load alphabetically; this one is last). A
	// rewrite may therefore only wrap the original with rtk: new control
	// characters, separators, redirections, substitutions, or a longer tail
	// than "rtk " + original would mean executing something nobody evaluated.
	if (!isSafeRewrite(command, rewritten)) return undefined;
	// `rtk rewrite` emits a bare `rtk …`; when rtk is not on PATH the command
	// must name the binary that answered, so the rewrite stays runnable.
	return binary === "rtk" || !rewritten.startsWith("rtk ") ? rewritten : `${quoteForShell(binary)}${rewritten.slice(3)}`;
}

/**
 * Accept a rewrite only when it is the original command with `rtk ` (or the
 * resolved rtk binary) prefixed at the start of the same shell segments, and
 * nothing else changed. rtk's rules may also drop/insert its own flags
 * right after the `rtk <sub>` head, so the check is: strip every
 * occurrence of a leading rtk prefix per segment and compare the remainder
 * after collapsing whitespace; and the rewrite may not introduce control
 * characters or shell metacharacters the original did not have.
 */
export function isSafeRewrite(original: string, rewritten: string): boolean {
	if (/[\0\r\n]/.test(rewritten)) return false;
	const meta = (text: string) => new Set(text.match(/[;&|<>`$(){}\\]/g) ?? []);
	for (const char of meta(rewritten)) if (!meta(original).has(char)) return false;
	const stripRtk = (text: string) => text.replace(/(^|[;&|]\s*)(?:'[^']*rtk(?:\.exe)?'|"[^"]*rtk(?:\.exe)?"|\S*rtk(?:\.exe)?)\s+/g, "$1");
	const normalize = (text: string) => stripRtk(text).replace(/\s+/g, " ").trim();
	const base = normalize(original);
	const next = normalize(rewritten);
	if (next === base) return true;
	// Beyond the rtk prefix, the rewrite may only add or drop plain flags
	// (`-n 20`, `--stat`): never new words, and never a flag value that looks
	// like a path (no slashes or colons), so `--output=/etc/x` is refused.
	const isFlagLike = (token: string) => /^-[A-Za-z0-9-]+(=[A-Za-z0-9._-]*)?$/.test(token) || /^[0-9]+$/.test(token);
	const words = (text: string) => text.split(" ").filter((token) => token.length > 0 && !isFlagLike(token));
	const added = next.split(" ").filter((token) => token.length > 0 && !base.split(" ").includes(token));
	return words(next).join(" ") === words(base).join(" ") && added.every(isFlagLike);
}

/**
 * Pi runs the bash tool through Git Bash on Windows, so a Windows path must
 * use forward slashes (backslashes are escapes there); any path with spaces,
 * quotes, or non-ASCII characters is single-quoted.
 */
export function quoteForShell(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return /^[A-Za-z0-9_./:-]+$/.test(normalized) ? normalized : `'${normalized.replace(/'/g, "'\\''")}'`;
}

function isBashCall(event: ToolCallEvent): event is ToolCallEvent & { input: { command?: unknown } } {
	return event.toolName === "bash";
}

export default function registerRtkRewrite(pi: ExtensionAPI): void {
	// Resolved once per process: undefined while probing, then the reason
	// rewriting is off, or null when rtk is usable.
	let disabledReason: string | null | undefined;
	let sessionContext: ExtensionContext | undefined;
	const binary = resolveRtkBinary();

	const showStatus = () => {
		if (!disabledReason || !sessionContext?.hasUI) return;
		try {
			sessionContext.ui.setStatus("rtk", disabledReason);
		} catch {
			// Status is advisory; never let it affect command execution.
		}
	};

	const probe = (async () => {
		try {
			const version = await pi.exec(binary, ["--version"], { timeout: RTK_REWRITE_TIMEOUT_MS });
			if (version.code !== 0) disabledReason = RTK_INSTALL_HINT;
			else if (!rtkVersionSupported(version.stdout)) disabledReason = `RTK off: ${version.stdout.trim()} is too old (need >= ${RTK_MIN_VERSION.join(".")}.0)`;
			else disabledReason = null;
		} catch {
			disabledReason = RTK_INSTALL_HINT;
		}
		showStatus();
	})();

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		showStatus();
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isBashCall(event)) return;
			if (process.env.RTK_DISABLED === "1") return;
			await probe;
			if (disabledReason !== null) return;
			const command = event.input.command;
			if (typeof command !== "string" || command.trim() === "") return;
			const rewritten = await rewriteWithRtk((cmd, args, options) => pi.exec(cmd, args, options), command, ctx.signal, binary);
			if (rewritten !== undefined) event.input.command = rewritten;
		} catch (error) {
			// Fail open: a rewriting problem must never block the command itself.
			console.warn("[rtk] passing the command through unchanged:", error instanceof Error ? error.message : String(error));
		}
	});
}
