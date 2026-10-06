import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.toSorted()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

export function canonicalHash(value: unknown): string {
	return createHash("sha256").update(canonicalize(value)).digest("hex");
}
