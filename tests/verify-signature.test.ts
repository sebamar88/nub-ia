// Maintainer signature verification (roadmap T4.3 / T8.5).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedSignerEntries, describeVerification, signersConfig, verifyCommit } from "../scripts/verify-signature.mjs";
import { fetchOrgPolicy } from "../scripts/org-policy-fetch.mjs";

const haveSshKeygen = spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error === undefined;

test("allowedSignerEntries and signersConfig: comments and blanks do not configure anything", () => {
	assert.deepEqual(allowedSignerEntries("# c\n\nme@x ssh-ed25519 AAAA key\nbad line\n"), ["me@x ssh-ed25519 AAAA key"]);
	const dir = mkdtempSync(join(tmpdir(), "nubia-sig-"));
	try {
		writeFileSync(join(dir, "s"), "# only comments\n");
		assert.equal(signersConfig(join(dir, "s")).configured, false);
		assert.equal(signersConfig(join(dir, "missing")).configured, false);
		assert.equal(verifyCommit(dir, "HEAD", join(dir, "s")).status, "unconfigured");
		assert.equal(verifyCommit(dir, "HEAD", undefined).status, "unconfigured");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("verifyCommit: maintainer-signed passes; unsigned and stranger-signed fail; skip env is loud", { skip: !haveSshKeygen && "ssh-keygen unavailable" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "nubia-sig-"));
	try {
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k1")]);
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k2")]);
		const signers = join(dir, "signers");
		writeFileSync(signers, `dev@nubiral.com ${execFileSync("cat", [join(dir, "k1.pub")], { encoding: "utf8" })}`);
		const repo = join(dir, "repo");
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		execFileSync("git", ["init", "-q", repo]);
		git("config", "user.email", "dev@nubiral.com"); git("config", "user.name", "dev"); git("config", "gpg.format", "ssh");
		git("config", "user.signingkey", join(dir, "k1.pub"));
		writeFileSync(join(repo, "a"), "a"); git("add", "a"); git("commit", "-q", "-S", "-m", "signed");
		writeFileSync(join(repo, "b"), "b"); git("add", "b"); git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "unsigned");
		git("config", "user.signingkey", join(dir, "k2.pub"));
		writeFileSync(join(repo, "c"), "c"); git("add", "c"); git("commit", "-q", "-S", "-m", "stranger");
		assert.equal(verifyCommit(repo, "HEAD~2", signers).status, "verified");
		assert.equal(verifyCommit(repo, "HEAD~1", signers).status, "unsigned");
		assert.equal(verifyCommit(repo, "HEAD", signers).status, "untrusted");
		assert.match(describeVerification(verifyCommit(repo, "HEAD", signers)), /FAILED \(untrusted/);
		assert.equal(verifyCommit(repo, "HEAD", signers, { NUB_IA_SKIP_VERIFY: "1" }).status, "skipped");
		// The org policy fetch refuses a stranger-signed policy and keeps none.
		writeFileSync(join(repo, "org-policy.json"), JSON.stringify({ schema: "nub-ia.org-policy/v1", name: "X" }));
		git("add", "org-policy.json"); git("commit", "-q", "-S", "-m", "policy");
		const env = { NUB_IA_CONFIG_HOME: join(dir, "cfg") } as NodeJS.ProcessEnv;
		const refused = fetchOrgPolicy({ repository: `file://${repo}`, path: "org-policy.json" }, env, { signersPath: signers });
		assert.equal(refused.ok, false);
		assert.match(refused.message, /rejected: signature check FAILED \(untrusted/);
		git("config", "user.signingkey", join(dir, "k1.pub")); git("commit", "-q", "-S", "--allow-empty", "-m", "by maintainer");
		assert.equal(fetchOrgPolicy({ repository: `file://${repo}`, path: "org-policy.json" }, env, { signersPath: signers }).ok, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
