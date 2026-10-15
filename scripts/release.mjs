#!/usr/bin/env node
// Semver release from Conventional Commits (.github/workflows/release.yml).
// Every push to main cuts a release so `nub-ia` can announce "New version
// 1.4.0" instead of a commit hash:
//
//   node scripts/release.mjs             # bump, changelog, commit, tag; prints the plan
//   node scripts/release.mjs --dry-run   # print the plan only
//
// Bump rule over the commits since the last release tag (v<package.json
// version>): a `!` after the type/scope or a `BREAKING CHANGE:` footer →
// major; `feat` → minor; anything else → patch. The release commit itself
// (`chore(release): vX.Y.Z`) never triggers another release. When the current
// version has no tag yet (first run), HEAD is tagged as is, without a bump.
// Exit codes: 0 released (or dry-run), 3 nothing to release.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RELEASE_COMMIT_PREFIX = "chore(release): v";
export const CHANGELOG_FILE = "CHANGELOG.md";
const CHANGELOG_HEADER = "# Changelog\n\nReleases de Nub-IA. Generado por `scripts/release.mjs` a partir de los Conventional Commits de `main`.\n";

// --- pure (unit-tested) ---------------------------------------------------------

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<description>.+)$/;

/** One commit (`subject` first line, `body` the rest) → { type, scope, breaking, description, hash }. */
export function parseCommit({ hash, subject, body = "" }) {
	const match = SUBJECT.exec(subject.trim());
	const breakingFooter = /^BREAKING[ -]CHANGE:/m.test(body);
	if (!match) return { hash, type: "other", scope: undefined, breaking: breakingFooter, description: subject.trim() };
	const { type, scope, bang, description } = match.groups;
	return { hash, type, scope: scope || undefined, breaking: bang === "!" || breakingFooter, description };
}

/** True for the commit the release itself makes. */
export function isReleaseCommit(subject) {
	return subject.trim().startsWith(RELEASE_COMMIT_PREFIX);
}

/** "major" | "minor" | "patch" | undefined when there is nothing but release commits. */
export function bumpKind(commits) {
	const relevant = commits.filter((commit) => !isReleaseCommit(commit.subject));
	if (relevant.length === 0) return undefined;
	const parsed = relevant.map(parseCommit);
	if (parsed.some((commit) => commit.breaking)) return "major";
	if (parsed.some((commit) => commit.type === "feat")) return "minor";
	return "patch";
}

export function nextVersion(current, kind) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
	if (!match) throw new Error(`package.json version is not a plain semver: ${current}`);
	const [major, minor, patch] = match.slice(1).map(Number);
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

const SECTIONS = [
	["breaking", "Cambios incompatibles"],
	["feat", "Nuevo"],
	["fix", "Correcciones"],
	["perf", "Rendimiento"],
	["refactor", "Refactors"],
	["docs", "Documentación"],
	["other", "Otros"],
];

/** Markdown notes for one release (also the GitHub Release body). */
export function renderReleaseNotes({ version, date, commits, repoUrl, previousTag }) {
	const parsed = commits.filter((commit) => !isReleaseCommit(commit.subject)).map(parseCommit);
	const groups = new Map(SECTIONS.map(([key]) => [key, []]));
	for (const commit of parsed) {
		const key = commit.breaking ? "breaking" : groups.has(commit.type) ? commit.type : "other";
		groups.get(key).push(commit);
	}
	const lines = [`## v${version} (${date})`, ""];
	for (const [key, title] of SECTIONS) {
		const items = groups.get(key);
		if (items.length === 0) continue;
		lines.push(`### ${title}`, "");
		for (const commit of items) {
			const scope = commit.scope ? `**${commit.scope}**: ` : "";
			const link = repoUrl && commit.hash ? ` ([${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash}))` : "";
			lines.push(`- ${scope}${commit.description}${link}`);
		}
		lines.push("");
	}
	if (repoUrl && previousTag) lines.push(`Diff completo: ${repoUrl}/compare/${previousTag}...v${version}`, "");
	return lines.join("\n");
}

/** Existing CHANGELOG.md text (or undefined) + new notes → new file text. */
export function prependChangelog(existing, notes) {
	const base = existing && existing.trim().length > 0 ? existing : CHANGELOG_HEADER;
	const headerEnd = base.indexOf("\n## ");
	if (headerEnd === -1) return `${base.trimEnd()}\n\n${notes.trimEnd()}\n`;
	return `${base.slice(0, headerEnd).trimEnd()}\n\n${notes.trimEnd()}\n${base.slice(headerEnd)}`;
}

/** Rewrites only the top-level "version" value, keeping the file's formatting. */
export function bumpPackageJson(text, version) {
	const replaced = text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
	if (replaced === text) throw new Error("package.json has no top-level version field");
	return replaced;
}

/** Full plan from repository facts; the only decision point, kept pure. */
export function planRelease({ currentVersion, currentTagExists, commitsSinceTag, date, repoUrl }) {
	if (!currentTagExists) {
		return { action: "bootstrap", version: currentVersion, tag: `v${currentVersion}`, notes: renderReleaseNotes({ version: currentVersion, date, commits: [], repoUrl }) };
	}
	const kind = bumpKind(commitsSinceTag);
	if (!kind) return { action: "none", reason: "no commits since the last release" };
	const version = nextVersion(currentVersion, kind);
	return {
		action: "release",
		kind,
		version,
		tag: `v${version}`,
		notes: renderReleaseNotes({ version, date, commits: commitsSinceTag, repoUrl, previousTag: `v${currentVersion}` }),
	};
}

// --- git glue -----------------------------------------------------------------

function git(...args) {
	return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitsSince(tag) {
	const raw = git("log", "--reverse", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", `${tag}..HEAD`);
	return raw.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		const [hash, subject, body] = entry.split("\x1f");
		return { hash, subject, body: body ?? "" };
	});
}

function tagExists(tag) {
	try {
		git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
		return true;
	} catch {
		return false;
	}
}

/** The package name recorded at a ref, or undefined (no package.json there). */
function packageNameAt(ref) {
	try {
		return JSON.parse(git("show", `${ref}:package.json`)).name;
	} catch {
		return undefined;
	}
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	const packagePath = join(ROOT, "package.json");
	const packageText = readFileSync(packagePath, "utf8");
	const currentVersion = JSON.parse(packageText).version;
	const currentTag = `v${currentVersion}`;
	const currentTagExists = tagExists(currentTag);
	// Only Nub-IA's own tags count; a foreign tag of the same name is a setup error.
	if (currentTagExists && packageNameAt(currentTag) !== JSON.parse(packageText).name) {
		throw new Error(`${currentTag} is not a Nub-IA release tag (it points at ${packageNameAt(currentTag) ?? "no package"})`);
	}
	const repoUrl = process.env.RELEASE_REPO_URL || "https://github.com/sebamar88/nub-ia";
	const date = new Date().toISOString().slice(0, 10);
	const plan = planRelease({ currentVersion, currentTagExists, commitsSinceTag: currentTagExists ? commitsSince(currentTag) : [], date, repoUrl });

	if (plan.action === "none") {
		process.stdout.write(`release: ${plan.reason}\n`);
		process.exit(3);
	}
	process.stdout.write(`release: ${plan.action} ${plan.tag}${plan.kind ? ` (${plan.kind})` : ""}\n\n${plan.notes}\n`);
	if (dryRun) return;

	if (plan.action === "release") {
		writeFileSync(packagePath, bumpPackageJson(packageText, plan.version), "utf8");
		const changelogPath = join(ROOT, CHANGELOG_FILE);
		writeFileSync(changelogPath, prependChangelog(existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : undefined, plan.notes), "utf8");
		git("add", "package.json", CHANGELOG_FILE);
		git("commit", "--quiet", "-m", `${RELEASE_COMMIT_PREFIX}${plan.version}`, "-m", "Automatic semver release from Conventional Commits (scripts/release.mjs).");
	}
	git("tag", "-a", plan.tag, "-m", `Nub-IA ${plan.tag}`);
	writeFileSync(join(ROOT, "release-notes.md"), plan.notes, "utf8");
	if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `tag=${plan.tag}\nversion=${plan.version}\n`, { flag: "a" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
	main().catch((error) => {
		process.stderr.write(`release: ${error.message}\n`);
		process.exit(1);
	});
}
