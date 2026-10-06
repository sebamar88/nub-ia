import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
	encoding: "utf8";
	timeout: number;
	maxBuffer: number;
	windowsHide?: boolean;
}

export type GitAsyncRunner = (command: string, args: readonly string[], options: GitCommandOptions) => Promise<{ stdout: string }>;

export type GitSyncRunner = (command: string, args: readonly string[], options: GitCommandOptions) => string;

export interface SessionManagerLike {
	getSessionId(): unknown;
}

export interface SessionContext {
	cwd: string;
	mode?: string;
	hasUI: boolean;
	ui?: { getAllThemes?: () => readonly unknown[] };
	sessionManager: SessionManagerLike;
}

export interface SessionIdentity {
	readonly sessionManager: SessionManagerLike;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	// A SHA-256 digest of the canonical Git common directory. It is stable for
	// sibling worktrees of one clone without serializing a filesystem path.
	readonly repositoryIdentity: string;
}

function exactSessionId(sessionManager: SessionManagerLike): string | undefined {
	try {
		const value = sessionManager.getSessionId();
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function canonicalRepositoryIdentity(commonDir: string): string {
	return `sha256:${createHash("sha256").update(commonDir).digest("hex")}`;
}

function validAbsoluteGitPath(value: string): boolean {
	return isAbsolute(value) && value.length > 0 && !value.includes("\n") && !value.includes("\r");
}

export async function resolveCanonicalGitWorktreeRoot(
	cwd: string,
	run: GitAsyncRunner = execFileAsync as unknown as GitAsyncRunner,
): Promise<string | undefined> {
	try {
		const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const output = result.stdout.trim();
		if (!validAbsoluteGitPath(output)) return undefined;
		return await realpath(output);
	} catch {
		return undefined;
	}
}

/** Resolves a non-secret, clone-stable identity from Git's canonical common dir. */
export async function resolveCanonicalGitRepositoryIdentity(
	cwd: string,
	run: GitAsyncRunner = execFileAsync as unknown as GitAsyncRunner,
): Promise<string | undefined> {
	try {
		const result = await run("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const output = result.stdout.trim();
		if (output.length === 0 || output.includes("\n") || output.includes("\r")) return undefined;
		return canonicalRepositoryIdentity(await realpath(resolve(cwd, output)));
	} catch {
		return undefined;
	}
}

/** The parent AgentRunner binds a child task to this same digest at spawn time. */
export function resolveCanonicalGitRepositoryIdentitySync(
	cwd: string,
	run: GitSyncRunner = execFileSync as unknown as GitSyncRunner,
): string | undefined {
	try {
		const output = run("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }).trim();
		if (output.length === 0 || output.includes("\n") || output.includes("\r")) return undefined;
		return canonicalRepositoryIdentity(realpathSync(resolve(cwd, output)));
	} catch {
		return undefined;
	}
}

function hasInteractiveTui(context: SessionContext): boolean {
	if (context.mode !== undefined) return context.mode === "tui";
	try {
		// Pi 0.85 exposes ctx.mode in the documented SDK surface, while its
		// compatibility runner omits that property. In the latter, the real TUI
		// has themes and RPC's deliberately unsupported TUI surface returns none.
		return (context.ui?.getAllThemes?.().length ?? 0) > 0;
	} catch {
		return false;
	}
}

export async function captureSessionIdentity(
	context: SessionContext,
	processEnv: NodeJS.ProcessEnv = process.env,
	resolveRoot: (cwd: string) => Promise<string | undefined> = resolveCanonicalGitWorktreeRoot,
	resolveRepositoryIdentity: (cwd: string) => Promise<string | undefined> = resolveCanonicalGitRepositoryIdentity,
): Promise<SessionIdentity | undefined> {
	if (processEnv.GENTLE_PI_AGENTS_CHILD === "1" || context.hasUI !== true || !hasInteractiveTui(context)) return undefined;
	const sessionManager = context.sessionManager;
	if (typeof sessionManager !== "object" || sessionManager === null) return undefined;
	const sessionId = exactSessionId(sessionManager);
	if (sessionId === undefined) return undefined;
	const [worktreeRoot, repositoryIdentity] = await Promise.all([resolveRoot(context.cwd), resolveRepositoryIdentity(context.cwd)]);
	if (worktreeRoot === undefined || repositoryIdentity === undefined) return undefined;
	return { sessionManager, sessionId, worktreeRoot, repositoryIdentity };
}

export function sameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
	return left.sessionManager === right.sessionManager && left.sessionId === right.sessionId && left.repositoryIdentity === right.repositoryIdentity;
}
