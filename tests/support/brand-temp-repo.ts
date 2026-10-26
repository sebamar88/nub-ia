import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const repo = new URL("../..", import.meta.url).pathname;
export const fixtures = join(repo, "tests", "fixtures");
export const acme = join(fixtures, "brand-acme.json");
export const SKILLS = ["skills/nubia-spec-design-tasks/SKILL.md", "skills/nubia-svsd-spec/SKILL.md"];
export const png = (name: string) => join(fixtures, "brand", name);

// Temp git copy of the files rebrand touches (plus `extra`); the script resolves its root from its own location.
export function tempRepo(extra: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "rebrand-"));
	for (const p of ["scripts", "lib", "brand.json", "package.json", "assets/brand", "themes", ...SKILLS, ...extra]) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		cpSync(join(repo, p), join(dir, p), { recursive: true });
	}
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
	return dir;
}

export function git(dir: string, ...args: string[]) {
	return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout;
}

export function rebrand(dir: string, brandFile?: string, ...args: string[]) {
	const env = { ...process.env };
	delete env.NUB_IA_BRAND_FILE;
	if (brandFile) env.NUB_IA_BRAND_FILE = brandFile;
	return spawnSync(process.execPath, ["--experimental-strip-types", join(dir, "scripts", "rebrand.mjs"), ...args], { cwd: dir, encoding: "utf8", env });
}
