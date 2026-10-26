import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseBrand } from "../lib/brand.ts";
import { contrastRatio, deriveBannerPalette, deriveTheme } from "../lib/brand-colors.ts";

const repoBrand = parseBrand(JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8")));
const themeJson = JSON.parse(readFileSync(new URL("../themes/Nub-IA.json", import.meta.url), "utf8"));

test("default brand reproduces the lime banner palette exactly", () => {
	assert.deepEqual(deriveBannerPalette(repoBrand.colors), {
		rose: [214, 255, 0],
		label: [170, 200, 40],
		value: [230, 255, 120],
		logoFresh: [240, 240, 240],
		logoDim: [90, 100, 40],
	});
});

test("default brand reproduces themes/Nub-IA.json exactly", () => {
	assert.deepEqual(deriveTheme(themeJson, repoBrand), themeJson);
});

test("dark primary without overrides still meets 4.5 contrast on the banner background", () => {
	const brand = parseBrand({ ...JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8")), colors: { primary: "#0A0A40", accent: "#3030A0" } });
	const palette = deriveBannerPalette(brand.colors);
	assert.ok(contrastRatio(palette.label, [10, 11, 8]) >= 4.5);
	assert.ok(contrastRatio(palette.value, [10, 11, 8]) >= 4.5);
});

test("a new brand changes the theme name and tint vars but keeps other vars", () => {
	const brand = parseBrand({ ...JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8")), name: "Acme", colors: { primary: "#0A0A40", accent: "#3030A0" } });
	const theme = deriveTheme(themeJson, brand) as any;
	assert.equal(theme.name, "Acme");
	assert.equal(theme.vars.accent, "#0A0A40");
	assert.equal(theme.vars.activePink, "#3030A0");
	assert.equal(theme.vars.text, themeJson.vars.text);
	assert.deepEqual(theme.colors, themeJson.colors);
});

test("contrastRatio follows WCAG", () => {
	assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
});

const baseRaw = JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8"));
const newBrand = (overrides?: unknown) =>
	parseBrand({ ...baseRaw, name: "Acme", colors: { primary: "#2255FF", accent: "#FF8800", ...(overrides ? { overrides } : {}) } });

test("new brand derives valid tint vars that differ from the Nub-IA template", () => {
	const theme = deriveTheme(themeJson, newBrand()) as any;
	assert.equal(theme.name, "Acme");
	for (const key of ["border", "borderSubtle", "bgPanel", "bgElement", "bgSubtle", "userMessageBg", "deepPink"]) {
		assert.match(theme.vars[key], /^#[0-9A-F]{6}$/, key);
		assert.notEqual(theme.vars[key], themeJson.vars[key], key);
	}
});

test("explicit overrides win on a new brand while other fields stay derived", () => {
	const plain = newBrand();
	const brand = newBrand({ banner: { label: [1, 2, 3] }, theme: { border: "#123456" } });
	const palette = deriveBannerPalette(brand.colors);
	const theme = deriveTheme(themeJson, brand) as any;
	assert.deepEqual(palette.label, [1, 2, 3]);
	assert.deepEqual(palette.value, deriveBannerPalette(plain.colors).value);
	assert.equal(theme.vars.border, "#123456");
	assert.equal(theme.vars.borderSubtle, (deriveTheme(themeJson, plain) as any).vars.borderSubtle);
});
