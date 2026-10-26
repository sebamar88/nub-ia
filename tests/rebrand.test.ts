import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
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
