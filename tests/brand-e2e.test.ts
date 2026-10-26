import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { acme, png, rebrand, repo, SKILLS, tempRepo } from "./support/brand-temp-repo.ts";

const node = ["--experimental-strip-types", "--no-warnings"];

// cwd = root: skill-registry skips loading when cwd holds a different copy of itself.
function runChild(root: string, brandFile?: string) {
	const env: NodeJS.ProcessEnv = { ...process.env, NUB_IA_CONFIG_HOME: mkdtempSync(join(tmpdir(), "brand-e2e-cfg-")) };
	delete env.NUB_IA_BRAND_FILE;
	delete env.NUB_IA_AGENTS_CHILD;
	if (brandFile) env.NUB_IA_BRAND_FILE = brandFile;
	const result = spawnSync(process.execPath, [...node, join(repo, "tests/fixtures/brand-e2e-child.mjs"), root], { cwd: root, encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "", "every extension loads under the stub API");
	return JSON.parse(result.stdout) as { commands: string[]; banner: string };
}

const art = (root: string) => JSON.parse(readFileSync(join(root, "assets/brand/banner-art.json"), "utf8")) as { wordmark: string[]; isologo: string[] };
const rowsOf = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);

test("applying the Acme brand rebrands commands, banner, theme, bin and skills end to end", () => {
	const dir = tempRepo(["extensions", "runtime", "bin", "assets", "prompts", "package.json"]);
	symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
	const result = rebrand(dir, acme, "--wordmark", png("wordmark.png"), "--isologo", png("isologo.png"));
	assert.equal(result.status, 0, result.stderr);

	// (a) same command set as the default brand, with the prefix swapped.
	const base = runChild(repo);
	const branded = runChild(dir, acme);
	assert.deepEqual(branded.commands, base.commands.map((c) => c.replace(/^nubia:/, "acme:")).sort());
	assert.ok(branded.commands.filter((c) => c.startsWith("acme:")).length > 20);
	assert.ok(!branded.commands.some((c) => c.startsWith("nubia:")));

	// (b) the banner draws the Acme artwork and not the Nubiral wordmark.
	const text = stripAnsi(branded.banner);
	const newArt = art(dir);
	const oldArt = art(repo);
	assert.ok(rowsOf(newArt.isologo).every((row) => text.includes(row)), "Acme isologo rows are rendered");
	// The fixture wordmark is wider than the banner's wordmark column, so only its tail is compared.
	assert.ok(rowsOf(newArt.wordmark).every((row) => text.includes(row.slice(-20))), "Acme wordmark rows are rendered");
	assert.ok(!rowsOf(oldArt.wordmark).some((row) => text.includes(row)), "Nubiral wordmark rows are gone");
	assert.ok(stripAnsi(base.banner).includes(rowsOf(oldArt.wordmark)[0]), "sanity: default banner shows the Nubiral wordmark");

	// (c) generated theme swapped and consistent.
	assert.ok(existsSync(join(dir, "themes/Acme.json")));
	assert.ok(!existsSync(join(dir, "themes/Nub-IA.json")));
	const check = spawnSync(process.execPath, [...node, join(dir, "scripts/build-brand-assets.mjs"), "--check"], { cwd: dir, encoding: "utf8", env: { ...process.env, NUB_IA_BRAND_FILE: acme } });
	assert.equal(check.status, 0, check.stdout + check.stderr);

	// (d) launcher help speaks the new name and home.
	const home = mkdtempSync(join(tmpdir(), "brand-e2e-home-"));
	const help = spawnSync(process.execPath, [join(dir, "bin/nub-ia.mjs"), "--help"], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, NUB_IA_BRAND_FILE: acme } });
	assert.match(help.stdout, /\bacme\b/);
	assert.ok(help.stdout.includes("~/.acme/agent"), help.stdout);
	assert.ok(!help.stdout.includes("~/.nub-ia"));

	// (e) skills and bin key.
	for (const rel of SKILLS) {
		const body = readFileSync(join(dir, rel), "utf8");
		assert.ok(!body.includes("/nubia:workflow"), rel);
	}
	assert.ok(SKILLS.some((rel) => readFileSync(join(dir, rel), "utf8").includes("/acme:workflow")));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).bin, { acme: "bin/nub-ia.mjs" });
});
