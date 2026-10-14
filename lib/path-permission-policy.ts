// Path permissions (roadmap T7.1): which repository paths the agent may not
// touch, or must confirm before touching, declared as globs in the `paths`
// section of runtime-guardrails.json and evaluated by the permission-mode
// extension before the write/edit/bash tools run.
//
//   "paths": {
//     "deny":     [".github/**", "infra/**", "*.lock"],      never written by the agent
//     "confirm":  ["migrations/**", "package.json"],         always confirmed, in every mode (yolo included)
//     "readOnly": ["vendor/**"]                              alias of deny (reads stay allowed)
//   }
//
// The user's file sets the baseline; a repository's file can only add paths.
// Pure: glob matching and bash target extraction only.

export type PathRule = "deny" | "confirm";

export interface PathPolicy {
	deny: string[];
	confirm: string[];
}

export const EMPTY_PATH_POLICY: PathPolicy = { deny: [], confirm: [] };

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 400).map((entry) => entry.trim()) : []);

/** The `paths` section of one guardrails file; readOnly folds into deny. */
export function parsePathPolicy(text: string | undefined): PathPolicy {
	if (!text) return EMPTY_PATH_POLICY;
	try {
		const parsed = JSON.parse(text) as { paths?: { deny?: unknown; confirm?: unknown; readOnly?: unknown } };
		const section = parsed.paths;
		if (typeof section !== "object" || section === null) return EMPTY_PATH_POLICY;
		return { deny: [...list(section.deny), ...list(section.readOnly)], confirm: list(section.confirm) };
	} catch {
		return EMPTY_PATH_POLICY;
	}
}

/** Union: every layer can only add protected paths. */
export function mergePathPolicies(...layers: PathPolicy[]): PathPolicy {
	const dedupe = (values: string[]) => [...new Set(values)];
	return { deny: dedupe(layers.flatMap((layer) => layer.deny)), confirm: dedupe(layers.flatMap((layer) => layer.confirm)) };
}

// --- glob matching (subset: `**`, `*`, `?`, `{a,b}`; `/`-separated, repo-relative) ---------

function globToRegExp(glob: string): RegExp {
	let pattern = "";
	let i = 0;
	const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	while (i < normalized.length) {
		const char = normalized[i]!;
		if (char === "*" && normalized[i + 1] === "*") {
			// `**/` matches zero or more directories; a trailing `**` matches the rest.
			const slash = normalized[i + 2] === "/";
			pattern += slash ? "(?:.*/)?" : ".*";
			i += slash ? 3 : 2;
		} else if (char === "*") { pattern += "[^/]*"; i += 1; }
		else if (char === "?") { pattern += "[^/]"; i += 1; }
		else if (char === "{") {
			const end = normalized.indexOf("}", i);
			if (end === -1) { pattern += "\\{"; i += 1; continue; }
			pattern += `(?:${normalized.slice(i + 1, end).split(",").map((alt) => alt.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
			i = end + 1;
		} else { pattern += char.replace(/[.+^$()|[\]\\]/g, "\\$&"); i += 1; }
	}
	// A pattern without a slash matches the basename anywhere (like .gitignore).
	return new RegExp(normalized.includes("/") ? `^${pattern}$` : `(^|/)${pattern}$`);
}

const cache = new Map<string, RegExp>();
export function matchesGlob(relativePath: string, glob: string): boolean {
	let regexp = cache.get(glob);
	if (!regexp) { regexp = globToRegExp(glob); cache.set(glob, regexp); }
	const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
	return regexp.test(path);
}

/** The strictest rule any of the paths hits: deny > confirm > none. */
export function evaluatePaths(policy: PathPolicy, relativePaths: readonly string[]): { rule: PathRule; path: string; glob: string } | undefined {
	let confirm: { rule: PathRule; path: string; glob: string } | undefined;
	for (const path of relativePaths) {
		for (const glob of policy.deny) if (matchesGlob(path, glob)) return { rule: "deny", path, glob };
		if (!confirm) for (const glob of policy.confirm) if (matchesGlob(path, glob)) { confirm = { rule: "confirm", path, glob }; break; }
	}
	return confirm;
}

// --- bash targets -----------------------------------------------------------------

const WRITING_PROGRAMS = /^(rm|rmdir|mv|cp|touch|mkdir|chmod|chown|truncate|ln|install|dd|shred|unlink|sed|perl|tee|git\s+(rm|mv|checkout|restore|clean|apply|am|stash)|patch)\b/;

/**
 * Paths a shell command may write: redirection targets and the operands of
 * common writing programs. Options are skipped; quotes are stripped; anything
 * with a variable or glob stays as written (the policy globs still see it).
 * Conservative on purpose: a missed target falls through to the mode's own
 * bash rule and the harness guardrails, never to a silent allow.
 */
export function bashWriteTargets(command: string): string[] {
	const targets = new Set<string>();
	const unquote = (word: string) => word.replace(/^['"]|['"]$/g, "");
	for (const match of command.matchAll(/(?:^|[^<>])>{1,2}\s*([^\s;&|]+)/g)) targets.add(unquote(match[1]!));
	for (const match of command.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|]+)/g)) targets.add(unquote(match[1]!));
	for (const segment of command.split(/\|\||&&|\||;|\n/)) {
		const trimmed = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^(rtk|time|env|nice|command|sudo|doas)\s+/, "");
		const program = WRITING_PROGRAMS.exec(trimmed);
		if (!program) continue;
		const rest = trimmed.slice(program[0].length).trim();
		const words = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
		for (const word of words) {
			if (word.startsWith("-")) continue;
			const bare = unquote(word);
			if (/^(s|y)[/|#,]/.test(bare) && /^(sed|perl)/.test(program[0])) continue; // the sed/perl expression
			targets.add(bare);
		}
	}
	return [...targets].filter((target) => target.length > 0 && target !== "/dev/null");
}
