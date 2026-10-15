import assert from "node:assert/strict";
import test from "node:test";
import {
	bumpKind,
	bumpPackageJson,
	isReleaseCommit,
	nextVersion,
	parseCommit,
	planRelease,
	prependChangelog,
	renderReleaseNotes,
} from "../scripts/release.mjs";

const c = (subject: string, body = "", hash = "0123456789abcdef") => ({ hash, subject, body });

test("parseCommit: conventional subjects, scopes, bang and BREAKING CHANGE footer", () => {
	assert.deepEqual(parseCommit(c("feat(review): add lens")), { hash: "0123456789abcdef", type: "feat", scope: "review", breaking: false, description: "add lens" });
	assert.equal(parseCommit(c("fix!: drop legacy flag")).breaking, true);
	assert.equal(parseCommit(c("refactor(core): x", "Body\n\nBREAKING CHANGE: config moved")).breaking, true);
	assert.equal(parseCommit(c("Merge branch 'x'")).type, "other");
	assert.equal(parseCommit(c("docs: readme")).scope, undefined);
});

test("bumpKind: breaking > feat > anything else; release commits alone mean nothing to release", () => {
	assert.equal(bumpKind([]), undefined);
	assert.equal(bumpKind([c("chore(release): v1.2.0")]), undefined);
	assert.equal(bumpKind([c("docs: x"), c("chore: y")]), "patch");
	assert.equal(bumpKind([c("fix: a"), c("feat: b")]), "minor");
	assert.equal(bumpKind([c("feat: b"), c("fix!: c")]), "major");
	assert.equal(bumpKind([c("chore: y", "BREAKING CHANGE: yes")]), "major");
	assert.equal(isReleaseCommit("chore(release): v1.0.1"), true);
	assert.equal(isReleaseCommit("chore: release notes"), false);
});

test("nextVersion", () => {
	assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
	assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
	assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
	assert.throws(() => nextVersion("1.2.3-beta", "patch"), /plain semver/);
});

test("renderReleaseNotes groups by type with commit links and compare line", () => {
	const notes = renderReleaseNotes({
		version: "1.1.0",
		date: "2026-01-02",
		repoUrl: "https://github.com/sebamar88/nub-ia",
		previousTag: "v1.0.0",
		commits: [c("feat(review): new lens", "", "aaaaaaa1111"), c("fix: typo", "", "bbbbbbb2222"), c("chore(release): v1.0.0"), c("weird subject", "", "ccccccc3333")],
	});
	assert.equal(notes, [
		"## v1.1.0 (2026-01-02)",
		"",
		"### Nuevo",
		"",
		"- **review**: new lens ([aaaaaaa](https://github.com/sebamar88/nub-ia/commit/aaaaaaa1111))",
		"",
		"### Correcciones",
		"",
		"- typo ([bbbbbbb](https://github.com/sebamar88/nub-ia/commit/bbbbbbb2222))",
		"",
		"### Otros",
		"",
		"- weird subject ([ccccccc](https://github.com/sebamar88/nub-ia/commit/ccccccc3333))",
		"",
		"Diff completo: https://github.com/sebamar88/nub-ia/compare/v1.0.0...v1.1.0",
		"",
	].join("\n"));
});

test("prependChangelog: creates the header once and inserts newest first", () => {
	const first = prependChangelog(undefined, "## v1.0.1 (d)\n\n- a\n");
	assert.match(first, /^# Changelog\n/);
	assert.match(first, /\n\n## v1\.0\.1 \(d\)\n\n- a\n$/);
	const second = prependChangelog(first, "## v1.1.0 (e)\n\n- b\n");
	assert.equal(second.indexOf("## v1.1.0") < second.indexOf("## v1.0.1"), true);
	assert.equal((second.match(/# Changelog/g) ?? []).length, 1);
});

test("bumpPackageJson rewrites only the version", () => {
	const text = '{\n\t"name": "nub-ia",\n\t"version": "1.0.0",\n\t"pi": { "version": "x" }\n}\n';
	assert.equal(bumpPackageJson(text, "1.1.0"), '{\n\t"name": "nub-ia",\n\t"version": "1.1.0",\n\t"pi": { "version": "x" }\n}\n');
	assert.throws(() => bumpPackageJson("{}", "1.0.0"), /no top-level version/);
});

test("planRelease: bootstrap when the current version has no tag, none without commits, release otherwise", () => {
	const boot = planRelease({ currentVersion: "1.0.0", currentTagExists: false, commitsSinceTag: [], date: "d", repoUrl: "u" });
	assert.equal(boot.action, "bootstrap");
	assert.equal(boot.tag, "v1.0.0");

	assert.equal(planRelease({ currentVersion: "1.0.0", currentTagExists: true, commitsSinceTag: [c("chore(release): v1.0.0")], date: "d" }).action, "none");

	const rel = planRelease({ currentVersion: "1.0.0", currentTagExists: true, commitsSinceTag: [c("feat: x")], date: "d", repoUrl: "u" });
	assert.equal(rel.action, "release");
	assert.equal(rel.kind, "minor");
	assert.equal(rel.tag, "v1.1.0");
	assert.match(rel.notes, /^## v1\.1\.0 \(d\)/);
	assert.match(rel.notes, /u\/compare\/v1\.0\.0\.\.\.v1\.1\.0/);
});
