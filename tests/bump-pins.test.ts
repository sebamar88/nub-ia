// Pin bumps (roadmap T4.4): pure rewriters and the orchestration with injected fetchers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bumpPins, currentPonytailVersion, currentRtkVersion, parseChecksums, PONYTAIL_REGISTRY, rewritePonytailPin, rewriteRtkInstaller, RTK_RELEASES_API } from "../scripts/bump-pins.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = readFileSync(join(ROOT, "scripts", "rtk-installer.mjs"), "utf8");
const launcher = readFileSync(join(ROOT, "lib", "nubia-launcher.ts"), "utf8");

test("parseChecksums reads sha256 lines with or without the binary marker", () => {
	assert.deepEqual(parseChecksums(`${"a".repeat(64)}  rtk-x.tar.gz\n${"b".repeat(64)} *rtk-y.zip\nnoise\n`), { "rtk-x.tar.gz": "a".repeat(64), "rtk-y.zip": "b".repeat(64) });
});

test("rewriteRtkInstaller bumps the version, swaps every matched archive digest and resets binary digests", () => {
	const files = [...installer.matchAll(/\{ file: "([^"]+)", sha256: "[0-9a-f]{64}" \}/g)].map((match) => match[1]);
	assert.ok(files.length >= 5);
	const checksums = Object.fromEntries(files.map((file, index) => [file, String(index).repeat(64).slice(0, 64)]));
	const { source, missing } = rewriteRtkInstaller(installer, "9.9.9", checksums);
	assert.deepEqual(missing, []);
	assert.equal(currentRtkVersion(source), "9.9.9");
	assert.match(source, /checksums\.txt \(v9\.9\.9\)/);
	for (const [file, digest] of Object.entries(checksums)) assert.ok(source.includes(`{ file: "${file}", sha256: "${digest}" }`), file);
	assert.doesNotMatch(source, /"linux-x64": "[0-9a-f]{64}"/, "binary digests are reset to undefined");
	assert.match(source, /"linux-x64": undefined/);
	const partial = rewriteRtkInstaller(installer, "9.9.9", { [files[0]]: "c".repeat(64) });
	assert.deepEqual(partial.missing, files.slice(1));
});

test("rewritePonytailPin and currentPonytailVersion", () => {
	assert.equal(currentPonytailVersion(launcher), "4.13.0");
	assert.match(rewritePonytailPin("x npm:@dietrichgebert/ponytail@4.13.0 y npm:@dietrichgebert/ponytail@4.13.0", "5.0.1"), /^x npm:@dietrichgebert\/ponytail@5\.0\.1 y npm:@dietrichgebert\/ponytail@5\.0\.1$/);
});

test("bumpPins --check reports changes without writing, and nothing when pins are current", async () => {
	const current = { rtk: currentRtkVersion(installer)!, ponytail: currentPonytailVersion(launcher)! };
	const fetchJsonImpl = async (url: string) => (url === RTK_RELEASES_API ? { tag_name: `v${current.rtk}` } : url === PONYTAIL_REGISTRY ? { "dist-tags": { latest: current.ponytail } } : (() => { throw new Error(url); })());
	assert.deepEqual(await bumpPins({ check: true, fetchJsonImpl }), []);
	const files = [...installer.matchAll(/\{ file: "([^"]+)", sha256: "[0-9a-f]{64}" \}/g)].map((match) => match[1]);
	const newer = async (url: string) => (url === RTK_RELEASES_API ? { tag_name: "v99.0.0", assets: [{ name: "checksums.txt", browser_download_url: "https://x/checksums.txt" }] } : { "dist-tags": { latest: "99.0.0" } });
	const changes = await bumpPins({ check: true, fetchJsonImpl: newer, fetchTextImpl: async () => files.map((file) => `${"d".repeat(64)}  ${file}`).join("\n") });
	assert.equal(changes.length, 2);
	assert.match(changes[0]!, /rtk .* → 99\.0\.0/);
	assert.match(changes[1]!, /ponytail .* → 99\.0\.0/);
	assert.equal(currentRtkVersion(readFileSync(join(ROOT, "scripts", "rtk-installer.mjs"), "utf8")), current.rtk, "--check never writes");
	await assert.rejects(bumpPins({ check: true, fetchJsonImpl: newer, fetchTextImpl: async () => "" }), /checksums\.txt lacks/);
});
