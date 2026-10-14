// Team stack skills (roadmap T3.4): valid frontmatter, the required section order, bounded size.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/agents-config.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS = ["nubia-aws", "nubia-bedrock", "nubia-terraform"];
const SECTIONS = ["Activation Contract", "Hard Rules", "Decision Gates", "Execution Steps", "Output Contract", "References"];

for (const name of SKILLS) {
	test(`skill ${name}: frontmatter, section order and size follow docs/skill-style-guide.md`, () => {
		const text = readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
		const { data, body } = parseFrontmatter(text);
		assert.equal(data.name, name);
		assert.match(String(data.description), /^Trigger: /);
		assert.ok(String(data.description).length <= 400);
		let previous = -1;
		for (const section of SECTIONS) {
			const index = body.indexOf(`## ${section}`);
			assert.ok(index > previous, `${name}: ## ${section} in order`);
			previous = index;
		}
		assert.ok(text.split("\n").length <= 150, `${name} stays under 150 lines`);
		assert.doesNotMatch(text, /AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36}/, "no example credentials in a skill");
	});
}
