// Signature verification (roadmap T4.3 / T8.5): `nub-ia update` and the org
// policy fetch accept a new HEAD only when it is signed by a listed maintainer.
//
// Keys live in the package as Git's SSH allowed-signers file
// (assets/maintainers.allowed_signers: `email ssh-ed25519 AAAA… [comment]`, one
// per line, `#` comments allowed; GitHub users already have such keys and
// `git config gpg.format ssh` + `user.signingkey` to sign). Until that file
// lists at least one key, verification is "unconfigured" and nothing changes:
// turning it on is a deliberate act of adding keys, never a silent default.
// NUB_IA_SKIP_VERIFY=1 skips an enforced check (printed loudly).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const SKIP_VERIFY_ENV = "NUB_IA_SKIP_VERIFY";
export const ALLOWED_SIGNERS_FILE = "maintainers.allowed_signers";

/** Non-comment, non-empty lines of an allowed-signers file that look like `principal key-type key`. */
export function allowedSignerEntries(text) {
	return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#") && /^\S+\s+(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+\S+/.test(line));
}

/** { configured: false } when the signers file is absent or lists no keys. */
export function signersConfig(signersPath) {
	if (!signersPath || !existsSync(signersPath)) return { configured: false, reason: "no allowed-signers file" };
	const entries = allowedSignerEntries(readFileSync(signersPath, "utf8"));
	if (entries.length === 0) return { configured: false, reason: `${signersPath} lists no keys` };
	return { configured: true, path: signersPath, entries };
}

/**
 * Verifies that `rev` in `repoDir` is signed by one of the allowed signers.
 * Returns { ok, status, detail }: status is "unconfigured" | "skipped" |
 * "verified" | "unsigned" | "untrusted" | "error".
 */
export function verifyCommit(repoDir, rev, signersPath, env = process.env, run = (args) => spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 })) {
	const config = signersConfig(signersPath);
	if (!config.configured) return { ok: true, status: "unconfigured", detail: config.reason };
	if (env[SKIP_VERIFY_ENV] === "1") return { ok: true, status: "skipped", detail: `${SKIP_VERIFY_ENV}=1` };
	const result = run(["-C", repoDir, "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${config.path}`, "verify-commit", "--raw", rev]);
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (result.status === 0 && /GOODSIG|Good "git" signature/.test(output)) return { ok: true, status: "verified", detail: (output.match(/GOODSIG\s+\S+\s+(\S+)/) ?? [])[1] ?? "signed by an allowed maintainer" };
	if (/no signature found|not signed/i.test(output) || result.status === 1 && !/BADSIG|ERRSIG|NO_PUBKEY|not in allowed/i.test(output) && output.trim().length === 0) return { ok: false, status: "unsigned", detail: `${rev} carries no signature` };
	if (/No principal matched|not in allowed signers|NO_PUBKEY|TRUST_UNDEFINED/i.test(output)) return { ok: false, status: "untrusted", detail: "signed, but not by a listed maintainer" };
	if (result.error) return { ok: false, status: "error", detail: result.error.message };
	return { ok: false, status: "untrusted", detail: output.trim().split("\n").slice(-1)[0] || `git verify-commit exit ${result.status}` };
}

/** Human line for the launcher. */
export function describeVerification(result) {
	switch (result.status) {
		case "unconfigured": return `signature check off (${result.detail}; add maintainer keys to assets/${ALLOWED_SIGNERS_FILE} to enable)`;
		case "skipped": return `signature check SKIPPED (${result.detail})`;
		case "verified": return `signature verified: ${result.detail}`;
		default: return `signature check FAILED (${result.status}: ${result.detail})`;
	}
}
