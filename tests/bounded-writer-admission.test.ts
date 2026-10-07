import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/nubia-harness.ts";
import { allowedEditSurfaces, inheritAllowedEditSurfaces, isBoundedWriter, bindSessionRepositoryPreparation, boundSessionRepositoryAuthorityCurrent, captureBoundSessionRepositoryAuthority, isDevelopmentSurface, prepareBoundSessionRepository, sessionRepositoryAuthority } from "../lib/bounded-writer-admission.ts";

test("development admission excludes sensitive, config and bookkeeping surfaces structurally", () => {
	for (const path of ["README.md", "odd/tasks/feature.md", ".pi/settings.json", "docs/app.ts", ".ssh/app.ts", ".aws/app.ts", ".gnupg/app.ts", "credentials/app.ts", "tokens/app.ts", "secrets/app.ts", "vite.config.ts", ".env", "private.key"]) assert.equal(isDevelopmentSurface(path), false, path);
	for (const path of ["src/app.ts", "lib/core.go", "tests/feature.test.ts", "src/**/*"]) assert.equal(isDevelopmentSurface(path), true, path);
});

test("authority capture is synchronous and retains root/common-dir across misses", () => {
	let identity: { root: string; commonDir: string } | undefined = { root: "/fixture", commonDir: "/fixture/git" };
	const current = sessionRepositoryAuthority("/fixture", () => identity);
	identity = undefined;
	assert.equal(current(), false);
	identity = { root: "/fixture", commonDir: "/other/git" };
	assert.equal(current(), false);
	identity = { root: "/other", commonDir: "/fixture/git" };
	assert.equal(current(), false);
});

test("captured authority cannot fall back to missing or a replacement incarnation", () => {
	const cwd = realpathSync(tmpdir());
	const manager = { getSessionId: () => "same-id", getCwd: () => cwd };
	const neverBound = captureBoundSessionRepositoryAuthority(manager, cwd);
	assert.equal(neverBound(), true, "never-bound compatibility callers remain permitted");
	const unbind = bindSessionRepositoryPreparation(manager, cwd, async () => true, () => true);
	assert.equal(neverBound(), false, "capture cannot silently adopt a subsequently minted binding");
	const captured = captureBoundSessionRepositoryAuthority(manager, cwd);
	assert.equal(captured(), true);
	unbind();
	assert.equal(captured(), false, "revoked binding never becomes permissive absence");
	assert.equal(boundSessionRepositoryAuthorityCurrent(manager, cwd), false, "new calls from revoked owners are also rejected");
	const replacement = bindSessionRepositoryPreparation(manager, cwd, async () => true, () => true);
	assert.equal(captured(), false, "same manager and ID cannot substitute another incarnation");
	const fresh = captureBoundSessionRepositoryAuthority(manager, cwd);
	assert.equal(fresh(), true);
	manager.getSessionId = () => "changed-id";
	assert.equal(fresh(), false);
	replacement();
});

for (const race of ["loss", "replacement", "cancellation"] as const) {
	test(`pending preparation revalidates established authority and owner before STATUS: ${race}`, async t => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bootstrap-authority-race-")));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		const manager = { getSessionId: () => "fixture", getCwd: () => cwd };
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let calls = 0;
		const abort = new AbortController();
		const unbind = bindSessionRepositoryPreparation(manager, cwd, async (_root, current) => {
			execFileSync("git", ["init", "--quiet", cwd]);
			assert.equal(current(), true, "first authorized bootstrap establishes retained identity");
			await gate;
			if (!current()) return false;
			calls++;
			return true;
		}, () => true);
		const pending = prepareBoundSessionRepository(manager, cwd, abort.signal);
		let successor: (() => void) | undefined;
		if (race === "loss") renameSync(join(cwd, ".git"), join(cwd, "saved-git"));
		if (race === "replacement") successor = bindSessionRepositoryPreparation(manager, cwd, async () => true, () => true);
		if (race === "cancellation") abort.abort();
		release();
		assert.equal(await pending, false);
		assert.equal(calls, 0, "no STATUS after authority/owner/cancellation drift during await");
		unbind(); successor?.();
	});
}

// gentle-shell#1713: a writer continuation without its own section was
// rejected, and every retry shortened the follow-up. A continuation resumes
// the same delegated task, so it inherits the surfaces that launch admitted.
test("writer continuations inherit the original surfaces only when they carry none", () => {
	const original = "Implement it.\n\n## Allowed edit surfaces\n- src/model.ts\n- `docs/with space.md`\n\n## Return\nReport";
	const inherited = inheritAllowedEditSurfaces("nubia-worker", "Continue with the remaining specs.", undefined, original);
	assert.deepEqual(allowedEditSurfaces(inherited), ["docs/with space.md", "src/model.ts"]);
	assert.ok(inherited.startsWith("Continue with the remaining specs."));
	const own = "Continue.\n## Allowed edit surfaces\nsrc/other.ts";
	assert.equal(inheritAllowedEditSurfaces("nubia-worker", own, undefined, original), own, "a follow-up section is validated as written, never merged");
	const viaContext = "## Allowed edit surfaces\nsrc/other.ts";
	assert.equal(inheritAllowedEditSurfaces("worker", "Continue.", viaContext, original), "Continue.");
	assert.equal(inheritAllowedEditSurfaces("nubia-explore", "Continue.", undefined, original), "Continue.", "non-writers are untouched");
	assert.equal(inheritAllowedEditSurfaces("jd-fix-agent", "Continue.", undefined, original), "Continue.", "Judgment Day fix batches keep their exact protocol");
	assert.equal(inheritAllowedEditSurfaces("nubia-worker", "Continue.", undefined, "No surfaces here."), "Continue.", "nothing to inherit stays rejectable");
	// Review R3-002: an entry admitted only when quoted must round-trip quoted.
	const quotedOnly = "## Allowed edit surfaces\n- `-`\n- src/model.ts";
	assert.deepEqual(allowedEditSurfaces(quotedOnly), ["-", "src/model.ts"]);
	assert.deepEqual(allowedEditSurfaces(inheritAllowedEditSurfaces("worker", "Continue.", undefined, quotedOnly)), ["-", "src/model.ts"]);
});

// gentle-shell#1731: only agents behind the surfaces guard claim surfaces at runtime.
test("bounded writers are exactly the agents behind the Allowed edit surfaces guard", () => {
	for (const name of ["nubia-worker", "worker", "jd-fix-agent"]) assert.equal(isBoundedWriter(name), true, name);
	for (const name of ["explore", "nubia-explore", "nubia-verify", "reviewer", ""]) assert.equal(isBoundedWriter(name), false, name);
});
