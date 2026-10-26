import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/build-brand-assets.mjs", import.meta.url).pathname;
const acme = new URL("./fixtures/brand-acme.json", import.meta.url).pathname;

function envWith(brandFile?: string) {
	const env = { ...process.env };
	delete env.NUB_IA_BRAND_FILE;
	if (brandFile) env.NUB_IA_BRAND_FILE = brandFile;
	return env;
}

function run(mode: string, dir: string, brandFile?: string) {
	return spawnSync(process.execPath, ["--experimental-strip-types", script, mode, "--themes-dir", dir], { encoding: "utf8", env: envWith(brandFile) });
}

test("check passes on the committed repo themes", () => {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--check"], { encoding: "utf8", env: envWith() });
	assert.equal(result.status, 0, result.stderr);
});

test("custom brand: check fails until write creates themes/<name>.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "brand-themes-"));
	assert.notEqual(run("--check", dir, acme).status, 0);
	assert.equal(run("--write", dir, acme).status, 0);
	assert.equal(run("--check", dir, acme).status, 0);
	assert.equal(JSON.parse(readFileSync(join(dir, "Acme.json"), "utf8")).name, "Acme");
});
