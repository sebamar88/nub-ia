import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { parseProfileExportTextWithDrops } from "../lib/agent-profiles.ts";

const root = join(import.meta.dirname, "..", "assets");
const agents = new Set(readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")));
const presets = readdirSync(join(root, "profiles")).filter((f) => f.endsWith(".json"));

test("the expected presets ship", () => {
	assert.deepEqual(
		presets.map((f) => basename(f, ".json")).sort(),
		["bedrock-claude", "copilot-claude", "nvidia", "openai-gpt6", "opencode-go", "opencode-zen", "router"],
	);
});

for (const file of presets) {
	test(`preset ${file} imports cleanly and names only packaged agents`, () => {
		const parsed = parseProfileExportTextWithDrops(readFileSync(join(root, "profiles", file), "utf8"));
		assert.ok(parsed, "parses as an agent-model profile export");
		assert.equal(parsed.name, basename(file, ".json"));
		assert.deepEqual(parsed.droppedAgents, []);
		assert.deepEqual(Object.keys(parsed.config).sort(), [...agents].sort(), "every packaged agent is routed");
		for (const entry of Object.values(parsed.config)) {
			assert.ok(entry.model && entry.thinking);
		}
	});
}

test("the router preset keeps each agent on its frontmatter tier", () => {
	const parsed = parseProfileExportTextWithDrops(readFileSync(join(root, "profiles", "router.json"), "utf8"));
	assert.ok(parsed);
	for (const agent of agents) {
		const text = readFileSync(join(root, "agents", `${agent}.md`), "utf8");
		assert.equal(parsed.config[agent].model, /^model:\s*(\S+)/m.exec(text)?.[1]);
		assert.equal(parsed.config[agent].thinking, /^thinking:\s*(\S+)/m.exec(text)?.[1]);
	}
});
