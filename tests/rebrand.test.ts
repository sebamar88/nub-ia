import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_WORDMARK_WIDTH } from "../lib/brand.ts";
import { acme, git, png, rebrand, SKILLS, tempRepo } from "./support/brand-temp-repo.ts";

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

function variant(change: Record<string, unknown>) {
	const base = JSON.parse(readFileSync(join(import.meta.dirname, "..", "brand.json"), "utf8"));
	const file = join(mkdtempSync(join(tmpdir(), "brand-variant-")), "brand.json");
	writeFileSync(file, JSON.stringify({ ...base, ...change }));
	return file;
}

test("--check passes on the committed state and writes nothing", () => {
	const dir = tempRepo();
	assert.equal(rebrand(dir, undefined, "--check").status, 0);
	assert.equal(git(dir, "status", "--porcelain"), "");
});

for (const [label, change] of [["prefix", { prefix: "zed" }], ["bin", { bin: "zed-cli" }]] as const) {
	test(`--check detects ${label}-only drift until rebrand runs`, () => {
		const dir = tempRepo();
		const file = variant(change);
		const before = rebrand(dir, file, "--check");
		assert.equal(before.status, 1);
		assert.match(before.stderr, /out of date/);
		assert.equal(git(dir, "status", "--porcelain"), "", "--check must not write");
		assert.equal(rebrand(dir, file).status, 0);
		assert.equal(rebrand(dir, file, "--check").status, 0);
	});
}

test("--check fails clearly when the artwork file is missing or malformed", () => {
	const dir = tempRepo();
	const missing = rebrand(dir, variant({ artwork: "assets/brand/nope.json" }), "--check");
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /nope\.json/);
	writeFileSync(join(dir, "assets/brand/banner-art.json"), JSON.stringify({ wordmark: "x", isologo: [], letterWeights: [1] }));
	const bad = rebrand(dir, undefined, "--check");
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /wordmark: string\[\]/);
});

test("rebrand fails with a clear error when package.json has no recognizable bin block", () => {
	const dir = tempRepo();
	const pkg = join(dir, "package.json");
	writeFileSync(pkg, readFileSync(pkg, "utf8").replace(/"bin": \{[^}]*\}/, '"bin": {"nub-ia": "bin/nub-ia.mjs"}'));
	const result = rebrand(dir, variant({ bin: "zed" }));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /"bin"/);
});

test("a tampered .applied.json theme file name is refused", () => {
	const dir = tempRepo();
	writeFileSync(join(dir, "assets/brand/.applied.json"), JSON.stringify({ prefix: "nubia", themeFile: "../x" }));
	const result = rebrand(dir, acme);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /unsafe theme file name/);
});

test("case-only rename keeps the regenerated theme", () => {
	const dir = tempRepo();
	assert.equal(rebrand(dir, variant({ name: "NUB-IA" })).status, 0);
	assert.ok(readdirSync(join(dir, "themes")).includes("NUB-IA.json"));
	assert.ok(!readdirSync(join(dir, "themes")).includes("Nub-IA.json"));
});

test("a wordmark wider than the banner logo column warns on stderr but succeeds", () => {
	const wide = rebrand(tempRepo(), acme, "--wordmark", png("wide.png"));
	assert.equal(wide.status, 0, wide.stderr);
	assert.match(wide.stderr, new RegExp(`warning: traced wordmark is \\d+ columns wide; the banner logo column holds ${MAX_WORDMARK_WIDTH}`));
	const narrow = rebrand(tempRepo(), acme, "--wordmark", png("wordmark.png"));
	assert.equal(narrow.status, 0, narrow.stderr);
	assert.doesNotMatch(narrow.stderr, /warning/);
});
