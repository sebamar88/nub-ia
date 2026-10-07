/** Legacy packaged agent names and their canonical replacements. */
export const LEGACY_AGENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
	"gentle-ai-explore": "nubia-explore",
	"gentle-ai-worker": "nubia-worker",
	"gentle-ai-verify": "nubia-verify",
});

export function isLegacyAgentName(name: string): boolean {
	return Object.hasOwn(LEGACY_AGENT_NAMES, name);
}

export function canonicalAgentName(name: string): string {
	return isLegacyAgentName(name) ? LEGACY_AGENT_NAMES[name]! : name;
}

/** Legacy alias of a canonical name, if any. */
export function legacyAgentNameFor(name: string): string | undefined {
	return Object.keys(LEGACY_AGENT_NAMES).find((legacy) => LEGACY_AGENT_NAMES[legacy] === name);
}

/**
 * Renames legacy agent keys to canonical ones. A canonical key already present
 * wins; the legacy one is dropped. Returns the input record untouched (same
 * reference) when nothing needed migrating.
 */
export function migrateAgentKeys<T>(record: Record<string, T>): { record: Record<string, T>; migrated: string[] } {
	const migrated = Object.keys(record).filter(isLegacyAgentName);
	if (migrated.length === 0) return { record, migrated };
	const next: Record<string, T> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!isLegacyAgentName(key)) next[key] = value;
	}
	for (const legacy of migrated) {
		const canonical = LEGACY_AGENT_NAMES[legacy]!;
		if (!Object.hasOwn(next, canonical)) next[canonical] = record[legacy]!;
	}
	return { record: next, migrated };
}

export function describeAgentKeyMigration(migrated: readonly string[]): string {
	return `Nub-IA renamed agent routing keys: ${migrated.map((key) => `${key} → ${canonicalAgentName(key)}`).join(", ")}`;
}
