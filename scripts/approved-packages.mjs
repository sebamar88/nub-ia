// Approved package sources (roadmap T8.3): which Pi packages the organisation
// lets a home install, from the org policy's `approvedPackages` section.
// Plain .mjs so the launcher (bin/nub-ia.mjs) can import it without the
// TypeScript runtime; lib/approved-packages.ts re-exports it for extensions.
//
//   "approvedPackages": ["npm:@dietrichgebert/ponytail", "git:github.com/nubiral/*"]          → warn
//   "approvedPackages": { "mode": "enforce", "sources": ["npm:@nubiral/*", "npm:gentle-engram"] }
//
// A source pattern matches the package source with its version/ref stripped
// (`npm:x@1.2.3` → `npm:x`, `git:host/o/r#main` → `git:host/o/r`); `*` matches
// any run of characters. No policy, or an empty list, approves everything.

export function parseApprovedPackages(policy) {
	const raw = policy && typeof policy === "object" ? policy.approvedPackages : undefined;
	if (raw === undefined) return undefined;
	const list = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : [];
	const sources = list.filter((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 300).map((entry) => entry.trim());
	if (sources.length === 0) return undefined;
	return { sources, mode: !Array.isArray(raw) && raw.mode === "enforce" ? "enforce" : "warn" };
}

export function normalizePackageSource(source) {
	const trimmed = String(source).trim();
	if (/^npm:/.test(trimmed)) {
		// Keep a scope's leading `@`; drop the version suffix after the name.
		return trimmed.replace(/^(npm:@?[^@]+)@.*$/, "$1");
	}
	if (/^git:/.test(trimmed)) return trimmed.replace(/[#@].*$/, "").replace(/\.git$/, "");
	return trimmed;
}

function matches(pattern, value) {
	const normalizedPattern = normalizePackageSource(pattern);
	if (!normalizedPattern.includes("*")) return normalizedPattern === value;
	return new RegExp(`^${normalizedPattern.split("*").map((part) => part.replace(/[.+^$()|[\]\\?{}]/g, "\\$&")).join(".*")}$`).test(value);
}

/** { approved: true } or { approved: false, mode, message }. */
export function checkPackageSource(source, approved) {
	if (!approved) return { approved: true };
	const normalized = normalizePackageSource(source);
	if (approved.sources.some((pattern) => matches(pattern, normalized))) return { approved: true };
	return { approved: false, mode: approved.mode, message: `${source} is not in the organisation's approved package sources (${approved.sources.join(", ")})` };
}

/** Sources declared in a home's settings.json that the policy does not approve. */
export function unapprovedInSettings(settingsText, approved) {
	if (!approved || !settingsText) return [];
	let settings;
	try { settings = JSON.parse(settingsText); } catch { return []; }
	const packages = Array.isArray(settings?.packages) ? settings.packages : [];
	return packages.filter((entry) => typeof entry === "string" && !checkPackageSource(entry, approved).approved);
}
