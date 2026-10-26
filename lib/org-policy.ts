// Organisation policy (roadmap T8.1): one document the team distributes
// (through `nub-ia update`, from a Git repository named in NUB_IA_ORG_POLICY or
// <configHome>/org-policy.source) that sits above the repository and the user
// in every policy the shell already has. Precedence is org > repo > user and,
// as everywhere else, a layer can only tighten what the layers below it chose.
//
//   {
//     "schema": "nub-ia.org-policy/v1",
//     "name": "Nubiral",
//     "permissionMode": { "max": "auto", "default": "accept-edits" },
//     "paths": { "deny": [".github/**"], "confirm": ["package.json"] },
//     "agents": { "nubia-explore": { "tools": { "write": "deny" } } },
//     "limits": { "maxConcurrentSubagents": 4 },
//     "reviewGate": "confirm",
//     "modelTiers": { "allowedProviders": ["amazon-bedrock"], "deniedModels": [], "budget": { "dailyUsd": 30, "onExceed": "warn" } },
//     "approvedPackages": ["npm:@dietrichgebert/ponytail"],
//     "roles": { ... }                                  (T8.2)
//   }
//
// The sections reuse the existing per-policy parsers unchanged: `sectionText`
// re-serialises one section as the small JSON document each parser expects.

export const ORG_POLICY_SCHEMA = "nub-ia.org-policy/v1";
export const ORG_POLICY_FILE = "org-policy.json";
export const ORG_POLICY_SOURCE_FILE = "org-policy.source";
export const ORG_POLICY_ENV = "NUB_IA_ORG_POLICY";

export const ORG_POLICY_SECTIONS = ["permissionMode", "paths", "agents", "limits", "reviewGate", "modelTiers", "approvedPackages", "roles"] as const;
export type OrgPolicySection = (typeof ORG_POLICY_SECTIONS)[number];

export interface OrgPolicy {
	schema: typeof ORG_POLICY_SCHEMA;
	name?: string;
	/** Where it came from and when it was refreshed (written by the fetcher, informational). */
	fetched?: { source: string; commit?: string; at: string };
	sections: Partial<Record<OrgPolicySection, unknown>>;
}

/** Parses an org-policy.json text; a wrong schema or shape yields undefined (no policy, never a partial one). */
export function parseOrgPolicy(text: string | undefined): OrgPolicy | undefined {
	if (!text) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return undefined; }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.schema !== ORG_POLICY_SCHEMA) return undefined;
	const sections: Partial<Record<OrgPolicySection, unknown>> = {};
	for (const key of ORG_POLICY_SECTIONS) if (record[key] !== undefined) sections[key] = record[key];
	const fetched = typeof record.fetched === "object" && record.fetched !== null ? (record.fetched as OrgPolicy["fetched"]) : undefined;
	return { schema: ORG_POLICY_SCHEMA, ...(typeof record.name === "string" ? { name: record.name } : {}), ...(fetched && typeof fetched.source === "string" && typeof fetched.at === "string" ? { fetched } : {}), sections };
}

/**
 * One section rendered as the standalone JSON document its existing parser
 * reads (e.g. `{"paths": …}` for parsePathPolicy). Undefined when absent, so a
 * caller can pass it straight into the parser's `text | undefined` argument.
 */
export function sectionText(policy: OrgPolicy | undefined, section: OrgPolicySection): string | undefined {
	const value = policy?.sections[section];
	return value === undefined ? undefined : JSON.stringify({ [section]: value });
}

/** The `modelTiers` section as the shape parseTierCatalog accepts (routing is never set by the org; only the allowlist and budget). */
export function orgModelTiersText(policy: OrgPolicy | undefined): string | undefined {
	const value = policy?.sections.modelTiers;
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	return JSON.stringify({ providerPriority: [], tiers: { strong: [], "strong-alt": [], balanced: [], fast: [] }, ...(record.allowedProviders !== undefined ? { allowedProviders: record.allowedProviders } : {}), ...(record.deniedModels !== undefined ? { deniedModels: record.deniedModels } : {}), ...(record.budget !== undefined ? { budget: record.budget } : {}) });
}

/** The review-gate mode the org requires, when it sets one. */
export function orgReviewGate(policy: OrgPolicy | undefined): "confirm" | "strict" | undefined {
	const value = policy?.sections.reviewGate;
	return value === "confirm" || value === "strict" ? value : undefined;
}

/** Human summary for /nubia:status and /nubia:doctor. */
export function describeOrgPolicy(policy: OrgPolicy | undefined, path: string): string[] {
	if (!policy) return [`Org policy: none (${path} absent; set ${ORG_POLICY_ENV} or ${ORG_POLICY_SOURCE_FILE} and run ${brand.bin} update)`];
	const present = ORG_POLICY_SECTIONS.filter((section) => policy.sections[section] !== undefined);
	return [
		`Org policy: ${policy.name ?? "unnamed"}${policy.fetched ? ` · from ${policy.fetched.source}${policy.fetched.commit ? `@${policy.fetched.commit.slice(0, 7)}` : ""} at ${policy.fetched.at}` : ""}`,
		`  sections: ${present.length ? present.join(", ") : "none"} (org > repo > user; each layer only tightens)`,
	];
}

// --- source descriptor -------------------------------------------------------------------

export interface OrgPolicySource {
	/** Git URL (https or ssh) or a local directory. */
	repository: string;
	/** Path of the policy file inside the repository. */
	path: string;
	ref?: string;
}

/** `git:github.com/org/policy[#ref][:path]`, a plain URL/directory, or JSON `{repository, path, ref}`. */
export function parseOrgPolicySource(text: string | undefined): OrgPolicySource | undefined {
	const raw = text?.trim();
	if (!raw) return undefined;
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw) as Partial<OrgPolicySource>;
			return typeof parsed.repository === "string" && parsed.repository.length > 0 ? { repository: parsed.repository, path: typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : ORG_POLICY_FILE, ...(typeof parsed.ref === "string" && parsed.ref.length > 0 ? { ref: parsed.ref } : {}) } : undefined;
		} catch { return undefined; }
	}
	const git = /^git:([^#:]+)(?:#([^:]+))?(?::(.+))?$/.exec(raw);
	if (git) return { repository: `https://${git[1]}.git`.replace(/\.git\.git$/, ".git"), path: git[3] ?? ORG_POLICY_FILE, ...(git[2] ? { ref: git[2] } : {}) };
	if (/^(https?:\/\/|git@|ssh:\/\/|\/|[A-Za-z]:\\|\.\.?\/)/.test(raw)) return { repository: raw, path: ORG_POLICY_FILE };
	return undefined;
}

// --- roles (roadmap T8.2) ---------------------------------------------------------------
//
//   "roles": {
//     "default": "developer",
//     "members": { "lead@nubiral.com": "lead", "*@contractor.example": "contractor" },
//     "definitions": {
//       "lead":       { "permissionMode": { "max": "yolo" }, "reviewGate": "confirm" },
//       "developer":  { "permissionMode": { "max": "auto" } },
//       "contractor": { "permissionMode": { "max": "accept-edits" }, "reviewGate": "strict", "limits": { "maxConcurrentSubagents": 1 } }
//     }
//   }
//
// The role is the organisation deciding per person: a role's sections replace the
// org-level sections of the same name (so a lead can be allowed more than the
// org default), and the result still sits above repository and user, which keep
// their own tighten-only say. NUB_IA_ROLE names a role explicitly; otherwise the
// Git identity's email is matched against `members` (exact, then `*@domain`),
// else `default`. Identity is a hint, not authentication: it decides which org
// defaults apply, never anything the user could not grant themselves locally.

export interface RolesSection {
	default?: string;
	members: Record<string, string>;
	definitions: Record<string, Partial<Record<Exclude<OrgPolicySection, "roles" | "approvedPackages">, unknown>>>;
}

const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function parseRoles(policy: OrgPolicy | undefined): RolesSection | undefined {
	const raw = policy?.sections.roles;
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const definitions: RolesSection["definitions"] = {};
	if (typeof record.definitions === "object" && record.definitions !== null) {
		for (const [name, spec] of Object.entries(record.definitions as Record<string, unknown>)) {
			if (!ROLE_NAME.test(name) || typeof spec !== "object" || spec === null) continue;
			const sections: Record<string, unknown> = {};
			for (const key of ORG_POLICY_SECTIONS) if (key !== "roles" && key !== "approvedPackages" && (spec as Record<string, unknown>)[key] !== undefined) sections[key] = (spec as Record<string, unknown>)[key];
			definitions[name] = sections;
		}
	}
	const members: Record<string, string> = {};
	if (typeof record.members === "object" && record.members !== null) {
		for (const [who, role] of Object.entries(record.members as Record<string, unknown>)) if (typeof role === "string" && definitions[role] && who.length <= 254) members[who.toLowerCase()] = role;
	}
	const fallback = typeof record.default === "string" && definitions[record.default] ? record.default : undefined;
	if (Object.keys(definitions).length === 0) return undefined;
	return { ...(fallback ? { default: fallback } : {}), members, definitions };
}

export interface ResolvedRole {
	role: string;
	source: "env" | "member" | "domain" | "default";
}

/** Which role applies: NUB_IA_ROLE (if defined by the org), the email's entry, its domain wildcard, or the default. */
export function resolveRole(roles: RolesSection | undefined, input: { envRole?: string; email?: string }): ResolvedRole | undefined {
	if (!roles) return undefined;
	if (input.envRole && roles.definitions[input.envRole]) return { role: input.envRole, source: "env" };
	const email = input.email?.trim().toLowerCase();
	if (email) {
		if (roles.members[email]) return { role: roles.members[email]!, source: "member" };
		const domain = email.slice(email.indexOf("@"));
		if (domain && roles.members[`*${domain}`]) return { role: roles.members[`*${domain}`]!, source: "domain" };
	}
	return roles.default ? { role: roles.default, source: "default" } : undefined;
}

/** The org policy with the role's sections substituted for the org-level ones of the same name. */
export function applyRole(policy: OrgPolicy | undefined, resolved: ResolvedRole | undefined): OrgPolicy | undefined {
	if (!policy || !resolved) return policy;
	const roles = parseRoles(policy);
	const definition = roles?.definitions[resolved.role];
	if (!definition) return policy;
	return { ...policy, sections: { ...policy.sections, ...definition } };
}

// --- effective policy loader (shared by every consumer) ---------------------------------

import { brand } from "./brand.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nubIaConfigHome } from "./config-home.ts";

export const ROLE_ENV = "NUB_IA_ROLE";

function gitEmail(cwd: string | undefined): string | undefined {
	try {
		return execFileSync("git", [...(cwd ? ["-C", cwd] : []), "config", "--get", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 2_000 }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export interface EffectiveOrgPolicy {
	policy: OrgPolicy | undefined;
	role?: ResolvedRole;
	path: string;
}

/**
 * org-policy.json with the member's role applied. Read fresh on every call
 * (policies are small; a `nub-ia update` in another terminal applies at once).
 */
export function loadEffectiveOrgPolicy(env: NodeJS.ProcessEnv = process.env, cwd?: string): EffectiveOrgPolicy {
	const path = join(nubIaConfigHome(env), ORG_POLICY_FILE);
	let text: string | undefined;
	try { text = readFileSync(path, "utf8"); } catch { text = undefined; }
	const policy = parseOrgPolicy(text);
	if (!policy) return { policy: undefined, path };
	const roles = parseRoles(policy);
	const role = roles ? resolveRole(roles, { envRole: env[ROLE_ENV], email: roles.members && Object.keys(roles.members).length ? gitEmail(cwd) : undefined }) : undefined;
	return { policy: applyRole(policy, role), ...(role ? { role } : {}), path };
}
