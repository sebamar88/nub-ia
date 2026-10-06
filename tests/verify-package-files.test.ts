import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileGeneratedRuntimeSources } from "../scripts/verify-package-files.mjs";

function makeFixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "gentle-pi-verify-package-files-"));
}

test("sources <-> runtime/*.mjs walk fails when a generated runtime file is absent from the generator's sources array", () => {
	const fixtureRoot = makeFixtureRoot();
	try {
		mkdirSync(join(fixtureRoot, "runtime"), { recursive: true });
		writeFileSync(join(fixtureRoot, "runtime/known.mjs"), "// generated\n");
		writeFileSync(join(fixtureRoot, "runtime/orphan.mjs"), "// generated\n");

		const { drifted } = reconcileGeneratedRuntimeSources(
			fixtureRoot,
			["known"],
			["runtime/known.mjs", "runtime/orphan.mjs"],
		);

		assert.deepEqual(drifted, [
			{ name: "orphan", inSources: false, inRuntimeDir: true, inRequiredPaths: true },
		]);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test("sources <-> runtime/*.mjs walk fails when a sources entry is absent from requiredPaths", () => {
	const fixtureRoot = makeFixtureRoot();
	try {
		mkdirSync(join(fixtureRoot, "runtime"), { recursive: true });
		writeFileSync(join(fixtureRoot, "runtime/known.mjs"), "// generated\n");
		writeFileSync(join(fixtureRoot, "runtime/unrequired.mjs"), "// generated\n");

		const { drifted } = reconcileGeneratedRuntimeSources(
			fixtureRoot,
			["known", "unrequired"],
			["runtime/known.mjs"],
		);

		assert.deepEqual(drifted, [
			{ name: "unrequired", inSources: true, inRuntimeDir: true, inRequiredPaths: false },
		]);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test("the sources <-> runtime/*.mjs walk reports no drift when sources, runtime/*.mjs and requiredPaths agree", () => {
	const fixtureRoot = makeFixtureRoot();
	try {
		mkdirSync(join(fixtureRoot, "runtime"), { recursive: true });
		writeFileSync(join(fixtureRoot, "runtime/known.mjs"), "// generated\n");

		const sourcesResult = reconcileGeneratedRuntimeSources(fixtureRoot, ["known"], ["runtime/known.mjs"]);

		assert.deepEqual(sourcesResult, { drifted: [] });
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});
