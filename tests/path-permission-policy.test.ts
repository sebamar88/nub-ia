// Path permissions (roadmap T7.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bashWriteTargets, evaluatePaths, matchesGlob, mergePathPolicies, parsePathPolicy } from "../lib/path-permission-policy.ts";

test("parsePathPolicy and mergePathPolicies: readOnly folds into deny, layers only add", () => {
	assert.deepEqual(parsePathPolicy(JSON.stringify({ paths: { deny: [".github/**"], confirm: ["package.json"], readOnly: ["vendor/**"] } })), { deny: [".github/**", "vendor/**"], confirm: ["package.json"] });
	assert.deepEqual(parsePathPolicy(JSON.stringify({ guardedCommands: {} })), { deny: [], confirm: [] });
	assert.deepEqual(parsePathPolicy("nope"), { deny: [], confirm: [] });
	assert.deepEqual(parsePathPolicy(JSON.stringify({ paths: { deny: [1, "", "  ok  "] } })), { deny: ["ok"], confirm: [] });
	assert.deepEqual(mergePathPolicies({ deny: ["a"], confirm: ["b"] }, { deny: ["a", "c"], confirm: [] }), { deny: ["a", "c"], confirm: ["b"] });
});

test("matchesGlob: **, *, ?, {a,b}, basename patterns and anchored paths", () => {
	assert.ok(matchesGlob(".github/workflows/ci.yml", ".github/**"));
	assert.ok(matchesGlob(".github/ci.yml", ".github/**"));
	assert.ok(matchesGlob("infra/prod/main.tf", "infra/**/*.tf"));
	assert.ok(matchesGlob("infra/main.tf", "infra/**/*.tf"));
	assert.ok(matchesGlob("pnpm-lock.yaml", "*.lock") === false);
	assert.ok(matchesGlob("src/deep/pnpm-lock.yaml", "pnpm-lock.yaml"), "a bare name matches anywhere");
	assert.ok(matchesGlob("a/b/x.lock", "*.lock"));
	assert.ok(matchesGlob("src/a.ts", "src/*.ts"));
	assert.ok(!matchesGlob("src/dir/a.ts", "src/*.ts"));
	assert.ok(matchesGlob("src/a.ts", "src/*.{ts,tsx}"));
	assert.ok(matchesGlob(".env.local", ".env*"));
	assert.ok(matchesGlob("a?c", "a?c") && matchesGlob("abc", "a?c"));
	assert.ok(matchesGlob(".github\\ci.yml", ".github/**"), "Windows separators normalise");
	assert.ok(!matchesGlob("github/ci.yml", ".github/**"));
});

test("evaluatePaths: deny beats confirm across all paths; none when nothing matches", () => {
	const policy = { deny: [".github/**", "*.lock"], confirm: ["package.json", "migrations/**"] };
	assert.deepEqual(evaluatePaths(policy, ["src/a.ts"]), undefined);
	assert.deepEqual(evaluatePaths(policy, ["package.json"]), { rule: "confirm", path: "package.json", glob: "package.json" });
	assert.deepEqual(evaluatePaths(policy, ["package.json", ".github/ci.yml"]), { rule: "deny", path: ".github/ci.yml", glob: ".github/**" });
	assert.deepEqual(evaluatePaths({ deny: [], confirm: [] }, ["anything"]), undefined);
});

test("bashWriteTargets: redirections, tee and the operands of writing programs; options and expressions skipped", () => {
	assert.deepEqual(bashWriteTargets("echo hi > out.txt"), ["out.txt"]);
	assert.deepEqual(bashWriteTargets("cat a >> 'logs/b.log'"), ["logs/b.log"]);
	assert.deepEqual(bashWriteTargets("ls | tee -a notes.md"), ["notes.md"]);
	assert.deepEqual(bashWriteTargets("rm -rf dist build").sort(), ["build", "dist"]);
	assert.deepEqual(bashWriteTargets("mv src/a.ts src/b.ts").sort(), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(bashWriteTargets("sed -i 's/a/b/' .github/workflows/ci.yml"), [".github/workflows/ci.yml"]);
	assert.deepEqual(bashWriteTargets("git checkout -- package.json"), ["package.json"]);
	assert.deepEqual(bashWriteTargets("FOO=1 rtk rm x && git status"), ["x"]);
	assert.deepEqual(bashWriteTargets("git status; ls"), []);
	assert.deepEqual(bashWriteTargets("echo x > /dev/null"), []);
	assert.deepEqual(bashWriteTargets("if [ -f a ]; then echo a; fi"), []);
});
