import assert from "node:assert/strict";
import { test } from "node:test";
import registerNubiaGrill, { GRILL_SKILL_PATH, grillRequest } from "../extensions/nubia-grill.ts";

test("grillRequest names the skill file, the topic and the no-action rule", () => {
	const text = grillRequest("migrate the auth service to OIDC", "/pkg/skills/nubia-grill-me/SKILL.md");
	assert.match(text, /^Grill me about this: migrate the auth service to OIDC\./);
	assert.match(text, /read \/pkg\/skills\/nubia-grill-me\/SKILL\.md/);
	assert.match(text, /do not implement, delegate or create tasks until I confirm/);
	assert.match(grillRequest("   "), /the plan or decision we are currently discussing/);
	assert.ok(GRILL_SKILL_PATH.endsWith("skills/nubia-grill-me/SKILL.md"));
});

test("/nubia:grill and /nubia:quiz send the request as a user message; headless sessions are ignored", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: string[] = [];
	const pi = { registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec), sendUserMessage: (text: string) => sent.push(text) };
	registerNubiaGrill(pi as never);
	assert.deepEqual([...commands.keys()], ["nubia:grill", "nubia:quiz"]);
	await commands.get("nubia:quiz")!.handler("ship on Friday?", { hasUI: true, ui: { notify: () => {} } });
	assert.equal(sent.length, 1);
	assert.match(sent[0]!, /Grill me about this: ship on Friday\?/);
	await commands.get("nubia:grill")!.handler("", { hasUI: false, ui: { notify: () => {} } });
	assert.equal(sent.length, 1, "no UI, no grill");
});
