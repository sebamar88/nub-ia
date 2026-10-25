// SVSD phase skills: style-guide shape and the invariants each phase must state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/agents-config.ts";
import { workflowDirective } from "../lib/workflow-config.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECTIONS = ["Activation Contract", "Hard Rules", "Decision Gates", "Execution Steps", "Output Contract", "References"];

function load(name: string) {
	const text = readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
	const { data, body } = parseFrontmatter(text);
	assert.equal(data.name, name);
	assert.match(String(data.description), /^Trigger: /);
	let previous = -1;
	for (const section of SECTIONS) {
		const index = body.indexOf(`## ${section}`);
		assert.ok(index > previous, `${name}: ## ${section} in order`);
		previous = index;
	}
	assert.ok(text.split("\n").length <= 100, `${name} stays small`);
	return body;
}

test("nubia-svsd-spec: what and why only, no invention, no code, stops at a checkpoint", () => {
	const body = load("nubia-svsd-spec");
	assert.match(body, /\*\*what and why\*\*/);
	assert.match(body, /Do not invent requirements/);
	assert.match(body, /Write no code and create no files/);
	assert.match(body, /nubia-grill-me/);
	assert.match(body, /Never continue into the Backlog yourself/);
	for (const heading of ["Goal", "Scope", "Out of Scope", "Invariants", "Acceptance Outcomes", "Expensive-to-change Decisions", "Open Questions"]) assert.match(body, new RegExp(`## ${heading}`));
	assert.match(body, /never `\.atl\/`/);
});

test("nubia-svsd-backlog: vertical value stories only, no criteria yet, human picks the Story", () => {
	const body = load("nubia-svsd-backlog");
	assert.match(body, /\*\*Vertical only\.\*\*/);
	assert.match(body, /No technical Stories/);
	assert.match(body, /walking skeleton/);
	assert.match(body, /No acceptance criteria, mini plans or designs yet/);
	assert.match(body, /Do not invent requirements/);
	assert.match(body, /Never refine Story 1 on your own/);
	assert.match(body, /Infrastructure belongs inside the first Story/);
	assert.match(body, /smallest Spec amendment/);
});

test("nubia-svsd-story: one Story, behavioral criteria, bounded plan, explicit scope, no code", () => {
	const body = load("nubia-svsd-story");
	assert.match(body, /Only one Story is active at a\s+time/);
	assert.match(body, /\*\*No code\*\*/);
	assert.match(body, /observable behavior/);
	assert.match(body, /split before bloating/);
	assert.match(body, /at most 5 bullets/);
	assert.match(body, /Out of Scope is mandatory/);
	assert.match(body, /Manual Verification/);
	assert.match(body, /Never start Pair yourself/);
	assert.match(body, /Do not invent requirements/);
});

test("nubia-svsd-pair: Story boundary, protected tests, stop conditions, ODD serves the step", () => {
	const body = load("nubia-svsd-pair");
	assert.match(body, /\*\*The Story is the execution boundary\.\*\*/);
	assert.match(body, /horizontal phases/);
	assert.match(body, /never replace the Story/);
	assert.match(body, /Do not touch an agreed test/);
	assert.match(body, /Real RED\/GREEN only/);
	assert.match(body, /verification list/);
	assert.match(body, /Stop and ask the human when/);
	assert.match(body, /no autonomous team per layer|No autonomous team per layer/);
	assert.match(body, /Permission mode governs commits and push/);
	assert.match(body, /Never start it automatically/);
});

test("the svsd directive names exactly the four phase skills that ship", () => {
	const directive = workflowDirective("svsd")!;
	for (const skill of ["nubia-svsd-spec", "nubia-svsd-backlog", "nubia-svsd-story", "nubia-svsd-pair"]) {
		assert.ok(directive.includes(skill), skill);
		load(skill);
	}
});

test("nubia-spec-design-tasks: sequential phases with checkpoints, Task as the unit, reuses agents, adds none", () => {
	const body = load("nubia-spec-design-tasks");
	assert.match(body, /human checkpoint/);
	assert.match(body, /\*\*Task is the unit of execution\*\*/);
	for (const agent of ["nubia-explore", "nubia-worker", "nubia-verify"]) assert.match(body, new RegExp(agent));
	assert.match(body, /adds no agents, commands or files/);
	assert.match(body, /suggest SVSD/);
	assert.match(workflowDirective("sdd")!, /skill nubia-spec-design-tasks/);
	assert.doesNotMatch(body, /sdd-(init|apply|explore|propose)|openspec/i, "retired SDD names stay retired");
});
