import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("installers pin the npx pnpm fallback to package.json's packageManager and skip dev deps on npm", () => {
	const pinned = /"packageManager": "pnpm@([^"]+)"/.exec(read("package.json"))?.[1];
	assert.ok(pinned);
	for (const file of ["install.sh", "install.ps1"]) {
		const source = read(file);
		assert.ok(source.includes(`pnpm@${pinned}`), `${file} pins pnpm@${pinned}`);
		assert.doesNotMatch(source, /pnpm@11["')\s]/, `${file} has no floating pnpm major`);
		assert.match(source, /npm install --omit=dev/, `${file} npm fallback omits open-ended devDependencies`);
	}
});
