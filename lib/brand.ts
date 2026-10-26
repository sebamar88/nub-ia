// Central brand configuration (brand.json). Dependency-free so the launcher
// can load it from runtime/ before Pi is running.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BannerPalette } from "./brand-colors.ts";

export interface Brand {
	name: string;
	prefix: string;
	homeDir: string;
	bin: string;
	colors: {
		primary: string;
		accent: string;
		overrides?: { banner?: Partial<BannerPalette>; theme?: Record<string, string> };
	};
	logos: { wordmark: string; isologo: string };
	artwork: string;
}

export class BrandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrandError";
	}
}

function fail(path: string, rule: string): never {
	throw new BrandError(`brand.json: ${path} ${rule}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
	return value as Record<string, unknown>;
}

function str(parent: Record<string, unknown>, key: string, path: string): string {
	const value = parent[key];
	if (typeof value !== "string" || value.trim() === "") fail(`${path}${key}`, "must be a non-empty string");
	return value;
}

function matching(parent: Record<string, unknown>, key: string, path: string, re: RegExp, rule: string): string {
	const value = str(parent, key, path);
	if (!re.test(value)) fail(`${path}${key}`, rule);
	return value;
}

// Widest wordmark (columns) the banner logo column holds before it clips.
export const MAX_WORDMARK_WIDTH = 60;

export function parseBrand(raw: unknown): Brand {
	const root = obj(raw, "brand");
	const colors = obj(root.colors, "colors");
	const logos = obj(root.logos, "logos");
	const hex = /^#[0-9A-Fa-f]{6}$/;
	const brandValue: Brand = {
		name: matching(root, "name", "", /^[^\p{Cc}/\\:]{1,40}$/u, "must be one printable line of 1-40 characters without '/', '\\' or ':'"),
		prefix: matching(root, "prefix", "", /^[a-z][a-z0-9-]*$/, "must be lowercase letters, digits or '-' (no spaces or ':')"),
		homeDir: matching(root, "homeDir", "", /^\.[A-Za-z0-9_-][A-Za-z0-9._-]*$/, "must be a single path segment starting with '.' (letters, digits, '.', '_', '-'; not '.' or '..')"),
		bin: matching(root, "bin", "", /^[a-z][a-z0-9-]*$/, "must be lowercase letters, digits or '-'"),
		colors: {
			primary: matching(colors, "primary", "colors.", hex, "must be #RRGGBB"),
			accent: matching(colors, "accent", "colors.", hex, "must be #RRGGBB"),
		},
		logos: { wordmark: str(logos, "wordmark", "logos."), isologo: str(logos, "isologo", "logos.") },
		artwork: str(root, "artwork", ""),
	};
	if (colors.overrides !== undefined) brandValue.colors.overrides = obj(colors.overrides, "colors.overrides") as Brand["colors"]["overrides"];
	return brandValue;
}

export function loadBrand(file?: string): Brand {
	// lib/ and runtime/ are both one level below the package root.
	const path = file ?? process.env.NUB_IA_BRAND_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "..", "brand.json");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new BrandError(`brand.json: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseBrand(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) throw new BrandError(`brand.json: invalid JSON in ${path}: ${error.message}`);
		throw error;
	}
}

export const brand: Brand = loadBrand();

export function cmd(name: string): string {
	return `${brand.prefix}:${name}`;
}

export function cmdSlash(name: string): string {
	return `/${cmd(name)}`;
}
