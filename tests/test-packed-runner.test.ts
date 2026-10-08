import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync(new URL("../scripts/test-packed-runner.mjs", import.meta.url), "utf8");

test("packed runner targets the nub-ia package, not gentle-pi", () => {
	assert.match(runner, /"node_modules", "nub-ia"/);
	assert.match(runner, /entry\.name !== "nub-ia"/);
	assert.doesNotMatch(runner, /"node_modules", "gentle-pi"/);
	assert.doesNotMatch(runner, /entry\.name !== "gentle-pi"/);
});

test("packed runner never downloads rtk during its install and checks the bundled launcher", () => {
	assert.match(runner, /NUB_IA_SKIP_RTK_INSTALL: "1"/);
	assert.match(runner, /bin\/nub-ia\.mjs/);
	assert.match(runner, /assets\/nub-ia-logo\.png/);
});
