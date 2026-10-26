import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BrandError, brand, cmd, cmdSlash, parseBrand } from "../lib/brand.ts";

const repoBrand = JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8"));

function withChange(change: Record<string, unknown>, drop?: string) {
	const raw = { ...structuredClone(repoBrand), ...change };
	if (drop) delete raw[drop];
	return raw;
}

test("parseBrand accepts the repo brand.json with the default values", () => {
	const b = parseBrand(repoBrand);
	assert.equal(b.name, "Nub-IA");
	assert.equal(b.prefix, "nubia");
	assert.equal(b.homeDir, ".nub-ia");
	assert.equal(b.bin, "nub-ia");
	assert.equal(b.colors.primary, "#D6FF00");
});

test("loaded brand and command helpers use the defaults", () => {
	assert.equal(brand.prefix, "nubia");
	assert.equal(cmd("review"), "nubia:review");
	assert.equal(cmdSlash("review"), "/nubia:review");
});

const invalid: Array<[string, unknown, string]> = [
	["missing name", withChange({}, "name"), "name"],
	["bad primary color", withChange({ colors: { ...repoBrand.colors, primary: "red" } }), "colors.primary"],
	["uppercase prefix", withChange({ prefix: "Nubia" }), "prefix"],
	["prefix with space", withChange({ prefix: "a b" }), "prefix"],
	["prefix with colon", withChange({ prefix: "a:b" }), "prefix"],
	["homeDir without dot", withChange({ homeDir: "nub-ia" }), "homeDir"],
	["homeDir with slash", withChange({ homeDir: ".a/b" }), "homeDir"],
	["non-object", "nope", "brand.json"],
];
for (const [label, raw, field] of invalid) {
	test(`parseBrand rejects ${label}`, () => {
		assert.throws(
			() => parseBrand(raw),
			(error: unknown) => error instanceof BrandError && error.message.includes(field),
		);
	});
}
