// Fetches the organisation policy (lib/org-policy.ts) for `nub-ia update` and
// `nub-ia policy pull`: shallow-clones the source repository, reads the policy
// file, checks its schema, and writes <configHome>/org-policy.json with
// provenance. Never throws into the launcher: every failure is a message, and a
// failed fetch leaves the previous policy in place (fail closed on the stricter
// side: an org policy never silently disappears because the network blinked).

import { brand } from "../runtime/brand.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeVerification, verifyCommit } from "./verify-signature.mjs";

export const ORG_POLICY_SCHEMA = "nub-ia.org-policy/v1";
export const ORG_POLICY_FILE = "org-policy.json";
export const ORG_POLICY_SOURCE_FILE = "org-policy.source";
export const ORG_POLICY_ENV = "NUB_IA_ORG_POLICY";

export function configHome(env = process.env) {
	return env.NUB_IA_CONFIG_HOME || join(homedir(), ".pi", "nub-ia");
}

/** Same grammar as lib/org-policy.ts parseOrgPolicySource (kept in sync by tests). */
export function parseSource(text) {
	const raw = text?.trim();
	if (!raw) return undefined;
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			return typeof parsed.repository === "string" && parsed.repository ? { repository: parsed.repository, path: typeof parsed.path === "string" && parsed.path ? parsed.path : ORG_POLICY_FILE, ...(typeof parsed.ref === "string" && parsed.ref ? { ref: parsed.ref } : {}) } : undefined;
		} catch { return undefined; }
	}
	const git = /^git:([^#:]+)(?:#([^:]+))?(?::(.+))?$/.exec(raw);
	if (git) return { repository: `https://${git[1]}.git`.replace(/\.git\.git$/, ".git"), path: git[3] ?? ORG_POLICY_FILE, ...(git[2] ? { ref: git[2] } : {}) };
	if (/^(https?:\/\/|git@|ssh:\/\/|\/|[A-Za-z]:\\|\.\.?\/)/.test(raw)) return { repository: raw, path: ORG_POLICY_FILE };
	return undefined;
}

/** The configured source: the environment wins over the saved descriptor. */
export function resolveSource(env = process.env) {
	const fromEnv = parseSource(env[ORG_POLICY_ENV]);
	if (fromEnv) return { source: fromEnv, origin: ORG_POLICY_ENV };
	const file = join(configHome(env), ORG_POLICY_SOURCE_FILE);
	if (!existsSync(file)) return undefined;
	const saved = parseSource(readFileSync(file, "utf8"));
	return saved ? { source: saved, origin: file } : undefined;
}

export function saveSource(descriptor, env = process.env) {
	const dir = configHome(env);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ORG_POLICY_SOURCE_FILE), `${descriptor.trim()}\n`, { mode: 0o600 });
	return join(dir, ORG_POLICY_SOURCE_FILE);
}

/**
 * Clones `source.repository` (depth 1, optional ref), reads `source.path`,
 * validates the schema and writes org-policy.json. Returns { ok, message }.
 */
export function fetchOrgPolicy(source, env = process.env, deps = {}) {
	const run = deps.spawn ?? ((command, args, options) => spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 120_000, ...options }));
	const now = deps.now ?? (() => new Date());
	const target = join(configHome(env), ORG_POLICY_FILE);
	let checkout = source.repository;
	let temp;
	let commit;
	if (!/^(\/|[A-Za-z]:\\|\.\.?\/)/.test(source.repository)) {
		temp = mkdtempSync(join(tmpdir(), "nub-ia-org-policy-"));
		checkout = join(temp, "repo");
		const args = ["clone", "--quiet", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), "--", source.repository, checkout];
		const clone = run("git", args);
		if (clone.status !== 0) {
			rmSync(temp, { recursive: true, force: true });
			return { ok: false, message: `could not clone ${source.repository}${source.ref ? `#${source.ref}` : ""}: ${(clone.stderr ?? "").trim() || `exit ${clone.status}`}; keeping ${existsSync(target) ? "the previous policy" : "no policy"}` };
		}
		commit = (run("git", ["-C", checkout, "rev-parse", "HEAD"]).stdout ?? "").trim() || undefined;
		// T8.5: a policy that can tighten every session must come from a maintainer.
		if (deps.signersPath) {
			const verification = verifyCommit(checkout, "HEAD", deps.signersPath, env);
			if (!verification.ok) {
				rmSync(temp, { recursive: true, force: true });
				return { ok: false, message: `org policy at ${source.repository}${commit ? `@${commit.slice(0, 7)}` : ""} rejected: ${describeVerification(verification)}; keeping ${existsSync(target) ? "the previous policy" : "no policy"}` };
			}
			if (verification.status !== "unconfigured") process.stderr.write(`nub-ia: org policy ${describeVerification(verification)}\n`);
		}
	}
	try {
		const file = join(checkout, source.path);
		if (!existsSync(file)) return { ok: false, message: `${source.path} not found in ${source.repository}; keeping ${existsSync(target) ? "the previous policy" : "no policy"}` };
		let parsed;
		try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (error) { return { ok: false, message: `${source.path} is not valid JSON (${error.message}); keeping the previous policy` }; }
		if (!parsed || typeof parsed !== "object" || parsed.schema !== ORG_POLICY_SCHEMA) return { ok: false, message: `${source.path} does not declare schema ${ORG_POLICY_SCHEMA}; keeping the previous policy` };
		const written = { ...parsed, fetched: { source: source.repository + (source.ref ? `#${source.ref}` : "") + (source.path !== ORG_POLICY_FILE ? `:${source.path}` : ""), ...(commit ? { commit } : {}), at: now().toISOString() } };
		mkdirSync(configHome(env), { recursive: true });
		writeFileSync(target, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
		return { ok: true, message: `org policy ${parsed.name ? `"${parsed.name}" ` : ""}updated from ${source.repository}${commit ? `@${commit.slice(0, 7)}` : ""} → ${target}`, path: target };
	} finally {
		if (temp) rmSync(temp, { recursive: true, force: true });
	}
}

export function clearOrgPolicy(env = process.env) {
	const removed = [];
	for (const name of [ORG_POLICY_FILE, ORG_POLICY_SOURCE_FILE]) {
		const path = join(configHome(env), name);
		if (existsSync(path)) { rmSync(path, { force: true }); removed.push(path); }
	}
	return removed;
}

export function describeStatus(env = process.env) {
	const target = join(configHome(env), ORG_POLICY_FILE);
	const source = resolveSource(env);
	const lines = [];
	lines.push(source ? `source: ${source.source.repository}${source.source.ref ? `#${source.source.ref}` : ""}${source.source.path !== ORG_POLICY_FILE ? `:${source.source.path}` : ""} (from ${source.origin})` : `source: none (set ${ORG_POLICY_ENV} or run: ${brand.bin} policy set git:github.com/<org>/<repo>)`);
	if (existsSync(target)) {
		try {
			const policy = JSON.parse(readFileSync(target, "utf8"));
			const sections = ["permissionMode", "paths", "agents", "limits", "reviewGate", "modelTiers", "approvedPackages", "roles"].filter((key) => policy[key] !== undefined);
			lines.push(`policy: ${policy.name ?? "unnamed"}${policy.fetched ? ` · fetched ${policy.fetched.at}${policy.fetched.commit ? ` @${policy.fetched.commit.slice(0, 7)}` : ""}` : ""} · sections: ${sections.join(", ") || "none"}`);
		} catch { lines.push(`policy: ${target} is unreadable`); }
	} else lines.push(`policy: none at ${target}`);
	return lines;
}
