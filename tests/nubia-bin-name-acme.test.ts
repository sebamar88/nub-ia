import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const ACME = fileURLToPath(new URL("./fixtures/brand-acme.json", import.meta.url));

// Runs `code` as an ES module under the Acme brand and returns its JSON stdout.
function underAcme(code: string): unknown {
	const out = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
		cwd: root,
		env: { ...process.env, NUB_IA_BRAND_FILE: ACME, HOME: root },
		encoding: "utf8",
	});
	assert.equal(out.status, 0, out.stderr);
	return JSON.parse(out.stdout);
}

test("user-facing command hints use the brand binary name", () => {
	const out = underAcme(`
		const { parseUsageArgs } = await import("./scripts/usage-cli.mjs");
		const { formatUpdateNotice } = await import("./scripts/update-check.mjs");
		const { parseHeadlessArgs } = await import("./lib/nub-review.ts");
		const { describeOrgPolicy } = await import("./lib/org-policy.ts");
		console.log(JSON.stringify([
			parseUsageArgs(["--bogus"]).error,
			parseUsageArgs(["--month", "x"]).error,
			formatUpdateNotice({ behind: 1, upstream: "origin/main", remoteSha: "abc" }).command,
			parseHeadlessArgs(["--bogus"]).error,
			describeOrgPolicy(undefined, "/p")[0],
		]));
	`) as string[];
	assert.match(out[0]!, /'acme usage'/);
	assert.match(out[1]!, /^acme usage: /);
	assert.equal(out[2], "acme update");
	assert.match(out[3]!, /usage: acme review /);
	assert.match(out[4]!, /run acme update\)/);
	for (const text of out) assert.doesNotMatch(text, /nub-ia/);
});
