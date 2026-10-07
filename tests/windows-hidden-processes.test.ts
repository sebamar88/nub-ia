import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import test from "node:test";

type Options = Record<string, unknown>;
type Capture = {
	kind: "execFileSync" | "execFile" | "spawnSync";
	command: string;
	args: readonly string[];
	options: Options;
};
type Trace = { label: string; captures: Capture[] };
type ExpectedCall = Pick<Capture, "kind" | "command" | "args">;

async function trace<T>(captures: Capture[], traces: Trace[], label: string, action: () => T | Promise<T>, expected: readonly ExpectedCall[]): Promise<T> {
	const start = captures.length;
	const result = await action();
	const route = captures.slice(start);
	assert.deepEqual(route.map(({ kind, command, args }) => ({ kind, command, args })), expected, `${label} must use its documented public route`);
	traces.push({ label, captures: route });
	return result;
}

function childProcess(): typeof import("node:child_process") {
	return createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
}

function fakeGitResult(command: string, args: readonly string[], cwd: string): string {
	if (command !== "git") return "";
	if (args.includes("--show-toplevel")) return cwd;
	throw new Error(`windows-hidden fixture: unexpected execFileSync git argv ${args.join(" ")}`);
}

async function captureOwnedRoutes(t: TestContext): Promise<{ captures: Capture[]; traces: Trace[] }> {
	const cp = childProcess();
	const original = { execFileSync: cp.execFileSync, execFile: cp.execFile, spawnSync: cp.spawnSync };
	const captures: Capture[] = [];
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-windows-hidden-workspace-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, ".git"), { recursive: true });
	const fakeSync = ((command: string, args: readonly string[], options: Options = {}) => {
		captures.push({ kind: "execFileSync", command, args, options });
		return fakeGitResult(command, args, String(options.cwd ?? cwd));
	}) as unknown as typeof cp.execFileSync;
	const fakeAsync = function(command: string, args: readonly string[], options: Options, callback: (error: null, stdout: string, stderr: string) => void) {
		captures.push({ kind: "execFile", command, args, options });
		if (process.platform === "win32" && command === "codegraph") {
			callback(Object.assign(new Error("fixture shim missing"), { code: "ENOENT" }) as never, "", "");
		} else {
			callback(null, "indexed", "");
		}
		return undefined;
	} as unknown as typeof cp.execFile;
	(fakeAsync as unknown as { [promisify.custom]?: unknown })[promisify.custom] = async (command: string, args: readonly string[], options: Options) => {
		captures.push({ kind: "execFile", command, args, options });
		if (process.platform === "win32" && command === "codegraph") throw Object.assign(new Error("fixture shim missing"), { code: "ENOENT" });
		return { stdout: "indexed", stderr: "" };
	};
	const fakeSpawn = ((command: string, args: readonly string[], options: Options = {}) => {
		captures.push({ kind: "spawnSync", command, args, options });
		return { status: 0, stdout: "", stderr: "" };
	}) as unknown as typeof cp.spawnSync;
	try {
		cp.execFileSync = fakeSync;
		cp.execFile = fakeAsync;
		cp.spawnSync = fakeSpawn;
		syncBuiltinESMExports();
		let fallbackRoot: string | undefined;
		let fallbackCalls: ExpectedCall[] = [];
	if (process.platform === "win32") {
		fallbackRoot = mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-contract-"));
		t.after(() => rmSync(fallbackRoot!, { recursive: true, force: true }));
		const packageRoot = join(fallbackRoot, "node_modules", "@colbymchenry", "codegraph");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(fallbackRoot, "codegraph.cmd"), "@ECHO off\n");
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ bin: { codegraph: "entry.js" } }));
		writeFileSync(join(packageRoot, "entry.js"), "// fixture entry\n");
		const previousPath = process.env.Path;
		const previousUpperPath = process.env.PATH;
		t.after(() => { if (previousPath === undefined) delete process.env.Path; else process.env.Path = previousPath; });
		t.after(() => { if (previousUpperPath === undefined) delete process.env.PATH; else process.env.PATH = previousUpperPath; });
		process.env.Path = fallbackRoot;
		process.env.PATH = fallbackRoot;
		fallbackCalls = [{ kind: "execFile", command: process.execPath, args: [join(fallbackRoot, "node_modules", "@colbymchenry", "codegraph", "entry.js"), "init", cwd] }];
	}
	// The fixed query prevents accidental cache misses from becoming a fake proof.
		const query = "?windows-hidden-contract";
		const codegraph = await import(`../extensions/codegraph-tools.ts${query}`);
		const traces: Trace[] = [];
		const graph = codegraph.createCodeGraphTool();
		assert.equal(typeof graph.execute, "function", "CodeGraph public handler must be registered");
		const graphResult = await trace(captures, traces, "CodeGraph init", () => graph.execute("capture", { operation: "init" }, undefined, undefined, { cwd } as never), [
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "execFile", command: "codegraph", args: ["init", cwd] },
			...fallbackCalls,
		]);
		const graphText = String((graphResult as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");
		assert.match(graphText, /indexed/, "CodeGraph must return the fixture command result");

		return { captures, traces };
	} finally {
		cp.execFileSync = original.execFileSync;
		cp.execFile = original.execFile;
		cp.spawnSync = original.spawnSync;
		syncBuiltinESMExports();
		t.after(() => {
			cp.execFileSync = original.execFileSync;
			cp.execFile = original.execFile;
			cp.spawnSync = original.spawnSync;
			syncBuiltinESMExports();
		});
	}
}

test("owned public adapters pass windowsHide at every mapped Node child-process boundary", async (t) => {
	const { traces } = await captureOwnedRoutes(t);
	assert.deepEqual(traces.map(({ label }) => label), ["CodeGraph init"], "all mapped public actions must complete before flag assertions");
	for (const trace of traces) {
		for (const capture of trace.captures) {
			assert.equal(capture.options.windowsHide, true, `${trace.label}: ${capture.kind} ${capture.command} must hide Windows consoles`);
		}
	}
});

test("external editor remains the explicit interactive exemption", async () => {
	const shell = await import("../extensions/nubia-shell.ts");
	let received: Options | undefined;
	const host = { stop() {}, start() {}, requestRender() {} };
	assert.equal(shell.openInExternalEditor(host, "editor.txt", { EDITOR: "fixture-editor" }, ((_command: string, _args: readonly string[], options: Options) => {
		received = options;
		return { status: 0 };
	}) as never, process.cwd()), true);
	assert.equal(received?.shell, process.platform === "win32");
	assert.equal(received?.stdio, "inherit");
	assert.equal(received?.windowsHide, undefined, "the interactive editor intentionally remains unhidden");
});
