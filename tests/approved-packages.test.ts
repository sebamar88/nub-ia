// Approved package sources (roadmap T8.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPackageSource, normalizePackageSource, parseApprovedPackages, unapprovedInSettings } from "../scripts/approved-packages.mjs";

test("parseApprovedPackages: list → warn, object → mode; empty → none", () => {
	assert.deepEqual(parseApprovedPackages({ approvedPackages: ["npm:a", " npm:b "] }), { sources: ["npm:a", "npm:b"], mode: "warn" });
	assert.deepEqual(parseApprovedPackages({ approvedPackages: { mode: "enforce", sources: ["npm:@o/*"] } }), { sources: ["npm:@o/*"], mode: "enforce" });
	assert.equal(parseApprovedPackages({ approvedPackages: [] }), undefined);
	assert.equal(parseApprovedPackages({}), undefined);
	assert.equal(parseApprovedPackages(undefined), undefined);
});

test("normalizePackageSource strips versions and refs but keeps scopes", () => {
	assert.equal(normalizePackageSource("npm:@dietrichgebert/ponytail@4.13.0"), "npm:@dietrichgebert/ponytail");
	assert.equal(normalizePackageSource("npm:gentle-engram@0.2.0"), "npm:gentle-engram");
	assert.equal(normalizePackageSource("npm:pi-btw"), "npm:pi-btw");
	assert.equal(normalizePackageSource("git:github.com/o/r.git#main"), "git:github.com/o/r");
});

test("checkPackageSource and unapprovedInSettings", () => {
	const approved = parseApprovedPackages({ approvedPackages: { mode: "enforce", sources: ["npm:@dietrichgebert/ponytail", "npm:gentle-*", "git:github.com/nubiral/*"] } });
	assert.deepEqual(checkPackageSource("npm:@dietrichgebert/ponytail@4.13.0", approved), { approved: true });
	assert.deepEqual(checkPackageSource("npm:gentle-engram@0.2.0", approved), { approved: true });
	assert.deepEqual(checkPackageSource("git:github.com/nubiral/skills#v1", approved), { approved: true });
	const denied = checkPackageSource("npm:pi-btw", approved);
	assert.equal(denied.approved, false);
	assert.equal(denied.mode, "enforce");
	assert.match(denied.message, /npm:pi-btw is not in the organisation's approved package sources/);
	assert.deepEqual(checkPackageSource("npm:anything", undefined), { approved: true });
	const settings = JSON.stringify({ packages: ["npm:gentle-engram", "npm:gentle-engram@0.2.0", "npm:pi-web-access", "npm:pi-btw", 3] });
	assert.deepEqual(unapprovedInSettings(settings, approved), ["npm:pi-web-access", "npm:pi-btw"]);
	assert.deepEqual(unapprovedInSettings("broken", approved), []);
});
