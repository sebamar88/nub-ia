// grill-me skill: valid frontmatter, section order, attribution, bounded size.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/agents-config.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("nubia-grill-me follows the skill style guide and credits its MIT upstream", () => {
	const text = readFileSync(join(ROOT, "skills", "nubia-grill-me", "SKILL.md"), "utf8");
	const { data, body } = parseFrontmatter(text);
	assert.equal(data.name, "nubia-grill-me");
	assert.match(String(data.description), /^Trigger: grill me/);
	assert.equal(data.license, "MIT");
	let previous = -1;
	for (const section of ["Activation Contract", "Hard Rules", "Decision Gates", "Execution Steps", "Output Contract", "References"]) {
		const index = body.indexOf(`## ${section}`);
		assert.ok(index > previous, `## ${section} in order`);
		previous = index;
	}
	assert.match(body, /mattpocock\/skills/);
	assert.match(body, /"yes" accepts your recommended answer/);
	assert.match(body, /never start implementing/);
	assert.match(body, /ask_user_question/);
	assert.ok(text.split("\n").length <= 150);
});
