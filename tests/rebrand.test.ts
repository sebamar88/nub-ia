import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = new URL("..", import.meta.url).pathname;
const fixtures = join(repo, "tests", "fixtures");
const acme = join(fixtures, "brand-acme.json");
const SKILLS = ["skills/nubia-spec-design-tasks/SKILL.md", "skills/nubia-svsd-spec/SKILL.md"];

// Temp copy of the files rebrand touches; the script resolves its root from its own location.
function tempRepo() {
	const dir = mkdtempSync(join(tmpdir(), "rebrand-"));
	for (const p of ["scripts", "lib", "brand.json", "package.json", "assets/brand", "themes", ...SKILLS]) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		cpSync(join(repo, p), join(dir, p), { recursive: true });
	}
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
	return dir;
}

function git(dir: string, ...args: string[]) {
	return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout;
}

function rebrand(dir: string, brandFile?: string, ...args: string[]) {
	const env = { ...process.env };
	delete env.NUB_IA_BRAND_FILE;
	if (brandFile) env.NUB_IA_BRAND_FILE = brandFile;
	return spawnSync(process.execPath, ["--experimental-strip-types", join(dir, "scripts", "rebrand.mjs"), ...args], { cwd: dir, encoding: "utf8", env });
}

const png = (name: string) => join(fixtures, "brand", name);

test("transparent PNGs rewrite banner-art.json with one weight per letter", () => {
	const dir = tempRepo();
	const result = rebrand(dir, acme, "--wordmark", png("wordmark.png"), "--isologo", png("isologo.png"));
	assert.equal(result.status, 0, result.stderr);
	const art = JSON.parse(readFileSync(join(dir, "assets/brand/banner-art.json"), "utf8"));
	assert.equal(art.letterWeights.length, 3);
	assert.ok(art.isologo.length > 0);
	assert.notEqual(git(dir, "diff", "--stat", "assets/brand/banner-art.json"), "");
	assert.ok(existsSync(join(dir, "themes/Acme.json")));
	assert.ok(!existsSync(join(dir, "themes/Nub-IA.json")), "previous generated theme is deleted");
});

test("opaque PNG exits 2 and mentions alpha", () => {
	const result = rebrand(tempRepo(), acme, "--wordmark", png("opaque.png"));
	assert.equal(result.status, 2);
	assert.match(result.stderr, /alpha/);
});

test("prefix and bin are rewritten, and a second run changes nothing more", () => {
	const dir = tempRepo();
	assert.equal(rebrand(dir, acme).status, 0);
	for (const rel of SKILLS) {
		const text = readFileSync(join(dir, rel), "utf8");
		assert.ok(text.includes("/acme:") && !text.includes("/nubia:"), rel);
	}
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).bin, { acme: "bin/nub-ia.mjs" });
	git(dir, "add", "-A");
	assert.equal(rebrand(dir, acme).status, 0);
	assert.equal(git(dir, "diff", "--", ...SKILLS, "package.json", "assets/brand/.applied.json"), "");
});

test("default brand with no flags changes nothing", () => {
	const dir = tempRepo();
	assert.equal(rebrand(dir).status, 0);
	assert.equal(git(dir, "status", "--porcelain"), "");
});
