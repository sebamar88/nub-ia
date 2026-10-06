import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

// isPiManagedInstall gates the POSTINSTALL entry point only (no package postinstall calls it any more):
// it decides whether the running gentle-pi package sits under a directory
// pattern Pi's own package manager creates (npm-backed or git-backed), so an
// `npm install -g gentle-pi`, a plain development git checkout, or an npx
// cache directory never writes to the user's global Pi settings. It is
// deliberately unrelated to installTuiModeSetting's own ownership check
// (which compares the package location against one specific resolved agent
// home) and to installIsolatedTuiModeSetting (gentle-shell's own bootstrap of
// a directory it just created), covered in the other two test files.

const helperUrl = new URL("../scripts/install-tui-mode-setting.mjs", import.meta.url);
const { isPiManagedInstall } = await import(helperUrl.href);

test("isPiManagedInstall recognizes the user-scope npm-managed layout", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".pi", "agent", "npm", "node_modules", "gentle-pi")), true);
});

test("isPiManagedInstall recognizes the project-scope npm-managed layout", () => {
	assert.equal(isPiManagedInstall(join("/repo", ".pi", "npm", "node_modules", "gentle-pi")), true);
});

test("isPiManagedInstall recognizes Pi's git-managed layout", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".pi", "agent", "git", "github.com", "Gentleman-Programming", "gentle-pi")), true);
});

test("isPiManagedInstall rejects a global npm -g install", () => {
	assert.equal(isPiManagedInstall("/usr/local/lib/node_modules/gentle-pi"), false);
});

test("isPiManagedInstall rejects a plain development git checkout", () => {
	assert.equal(isPiManagedInstall("/Users/alan/work/gentle-pi"), false);
});

test("isPiManagedInstall rejects an npx cache directory", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".npm", "_npx", "abc123", "node_modules", "gentle-pi")), false);
});

test("isPiManagedInstall rejects a pnpm content-addressable store", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".pnpm", "gentle-pi@1.0.0", "node_modules", "gentle-pi")), false);
});

test("isPiManagedInstall resolves a relative path before checking", () => {
	const cwd = process.cwd();
	try {
		process.chdir(join("/tmp"));
		assert.equal(isPiManagedInstall(join(".", "npm", "node_modules", "gentle-pi")), true);
	} finally {
		process.chdir(cwd);
	}
});
