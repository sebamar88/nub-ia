import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/skill-registry.ts";

const repoRoot = join(import.meta.dirname, "..");

function readSkillName(dir: string): string | undefined {
	const source = readFileSync(join(repoRoot, "skills", dir, "SKILL.md"), "utf8");
	return __testing.parseFrontmatter(source).name;
}

const PREFIXED_NAMES: Record<string, string> = {
	"branch-pr": "nubia-branch-pr",
	"chained-pr": "nubia-chained-pr",
	"cognitive-doc-design": "nubia-cognitive-doc-design",
	"comment-writer": "nubia-comment-writer",
	"issue-creation": "nubia-issue-creation",
	"judgment-day": "nubia-judgment-day",
	"skill-creator": "nubia-skill-creator",
	"skill-improver": "nubia-skill-improver",
	"skill-registry": "nubia-skill-registry",
	"work-unit-commits": "nubia-work-unit-commits",
};

const UNPREFIXED_DIRS = ["nubia"];

for (const [dir, expectedName] of Object.entries(PREFIXED_NAMES)) {
	test(`skills/${dir}/SKILL.md frontmatter name is prefixed`, () => {
		assert.equal(readSkillName(dir), expectedName);
	});
}

test("technical reference documents legacy skill-name compatibility aliases", () => {
	const readme = readFileSync(join(repoRoot, "docs", "readme-reference.md"), "utf8");
	for (const [legacyName, prefixedName] of [
		["branch-pr", "nubia-branch-pr"],
		["judgment-day", "nubia-judgment-day"],
		["skill-creator", "nubia-skill-creator"],
	] as const) {
		assert.match(readme, new RegExp(`former package names such as[\\s\\S]*${legacyName}`));
		assert.match(readme, new RegExp(`runtime skill selection should use[\\s\\S]*${prefixedName}`));
	}
});

for (const dir of UNPREFIXED_DIRS) {
	test(`skills/${dir}/SKILL.md frontmatter name carries no gentle-ai- prefix`, () => {
		const name = readSkillName(dir);
		assert.ok(name, `expected a name for ${dir}`);
		assert.ok(!name?.startsWith("gentle-ai-"), `${dir} should not be prefixed, got ${name}`);
	});
}
