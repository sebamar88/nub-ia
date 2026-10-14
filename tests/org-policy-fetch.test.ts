import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearOrgPolicy, describeStatus, fetchOrgPolicy, parseSource, resolveSource, saveSource } from "../scripts/org-policy-fetch.mjs";
import { parseOrgPolicySource } from "../lib/org-policy.ts";

test("fetcher and lib agree on the source grammar", () => {
	for (const text of ["git:github.com/o/r", "git:github.com/o/r#main:p/x.json", "git@github.com:o/r.git", "/srv/p", '{"repository":"/x","path":"p.json"}', "nope", ""]) {
		assert.deepEqual(parseSource(text), parseOrgPolicySource(text), text);
	}
});

test("fetchOrgPolicy from a local directory: validates schema, writes with provenance, keeps the previous on failure", () => {
	const root = mkdtempSync(join(tmpdir(), "nubia-orgpol-"));
	try {
		const configHome = join(root, "cfg");
		const env = { NUB_IA_CONFIG_HOME: configHome } as NodeJS.ProcessEnv;
		const repo = join(root, "policy");
		mkdirSync(repo);
		writeFileSync(join(repo, "org-policy.json"), JSON.stringify({ schema: "nub-ia.org-policy/v1", name: "Org", reviewGate: "strict" }));
		const now = () => new Date("2026-01-02T03:04:05Z");
		const ok = fetchOrgPolicy({ repository: repo, path: "org-policy.json" }, env, { now });
		assert.equal(ok.ok, true, ok.message);
		const written = JSON.parse(readFileSync(join(configHome, "org-policy.json"), "utf8"));
		assert.deepEqual(written.fetched, { source: repo, at: "2026-01-02T03:04:05.000Z" });
		assert.equal(written.reviewGate, "strict");
		writeFileSync(join(repo, "org-policy.json"), JSON.stringify({ schema: "other" }));
		const bad = fetchOrgPolicy({ repository: repo, path: "org-policy.json" }, env, { now });
		assert.equal(bad.ok, false);
		assert.match(bad.message, /does not declare schema/);
		assert.equal(JSON.parse(readFileSync(join(configHome, "org-policy.json"), "utf8")).reviewGate, "strict", "the previous policy survives");
		const missing = fetchOrgPolicy({ repository: repo, path: "nope.json" }, env, { now });
		assert.match(missing.message, /nope\.json not found/);
		assert.equal(saveSource(repo, env), join(configHome, "org-policy.source"));
		assert.deepEqual(resolveSource(env), { source: { repository: repo, path: "org-policy.json" }, origin: join(configHome, "org-policy.source") });
		assert.deepEqual(resolveSource({ ...env, NUB_IA_ORG_POLICY: "git:github.com/o/r" }), { source: { repository: "https://github.com/o/r.git", path: "org-policy.json" }, origin: "NUB_IA_ORG_POLICY" });
		assert.match(describeStatus(env).join("\n"), /policy: Org · fetched 2026-01-02T03:04:05\.000Z · sections: reviewGate/);
		assert.equal(clearOrgPolicy(env).length, 2);
		assert.match(describeStatus(env).join("\n"), /source: none[\s\S]*policy: none/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
