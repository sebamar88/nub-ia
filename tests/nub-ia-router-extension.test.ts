// Router extension wiring that is not pure: the project catalog override (roadmap T2.2).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTierCatalog } from "../extensions/nub-ia-router.ts";

test("loadTierCatalog: a repository override replaces routing but can only tighten the packaged budget", () => {
	const cwd = mkdtempSync(join(tmpdir(), "nubia-router-"));
	try {
		mkdirSync(join(cwd, ".pi", "nub-ia"), { recursive: true });
		const write = (budget: unknown) => writeFileSync(join(cwd, ".pi", "nub-ia", "model-tiers.json"), JSON.stringify({ providerPriority: ["openai"], tiers: { strong: ["^openai/gpt-6-astra$"], "strong-alt": [], balanced: [], fast: [] }, ...(budget ? { budget } : {}) }));
		const warnings: string[] = [];
		write({ dailyUsd: 999, onExceed: "warn" });
		const packaged = loadTierCatalog(join(cwd, "elsewhere"), () => {});
		const overridden = loadTierCatalog(cwd, (message) => warnings.push(message));
		assert.deepEqual(overridden.providerPriority, ["openai"]);
		assert.equal(warnings.length, 1, "the override is announced once");
		if (packaged.budget) {
			assert.ok(overridden.budget!.dailyUsd! <= packaged.budget.dailyUsd!, "a looser daily limit does not win");
		} else {
			assert.deepEqual(overridden.budget, { dailyUsd: 999, onExceed: "warn" }, "without a packaged budget the project one applies");
		}
		write({ dailyUsd: 1, onExceed: "degrade" });
		assert.deepEqual(loadTierCatalog(cwd, () => {}).budget, { dailyUsd: 1, onExceed: "degrade", ...(packaged.budget?.sessionUsd ? { sessionUsd: packaged.budget.sessionUsd } : {}) });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
