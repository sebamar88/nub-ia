// `nub-ia usage [--month YYYY-MM] [--json]`: reads the month's local files and
// hands them to lib/usage-report.ts (through the generated runtime copy would be
// ideal, but the report is small enough to import via --experimental-strip-types
// from the launcher only when the command runs). Kept out of bin/nub-ia.mjs so
// the launcher's startup path stays lean.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configHome(env = process.env) {
	return env.NUB_IA_CONFIG_HOME || join(homedir(), ".pi", "nub-ia");
}

/** Everything the report needs for one month, as text; absent files are empty strings/undefined. */
export function collectUsageInputs(month, env = process.env) {
	const home = configHome(env);
	const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
	const metrics = join(home, "metrics");
	const spend = existsSync(metrics)
		? readdirSync(metrics).filter((name) => /^spend-\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => ({ date: name.slice(6, 16), text: read(join(metrics, name)) ?? "" }))
		: [];
	return {
		month,
		runtimeText: read(join(metrics, `runtime-${month}.jsonl`)) ?? "",
		spend,
		reviewText: read(join(metrics, `review-${month}.jsonl`)),
		auditText: read(join(home, "audit", `audit-${month}.jsonl`)),
		source: join(metrics, `runtime-${month}.jsonl`),
	};
}

export function parseUsageArgs(argv) {
	let month;
	let json = false;
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--json") json = true;
		else if (token === "--month") month = argv[++i];
		else if (token.startsWith("--month=")) month = token.slice("--month=".length);
		else return { error: `Unrecognized argument for 'nub-ia usage': ${token}\nUse --month YYYY-MM and/or --json.` };
	}
	if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) return { error: "nub-ia usage: --month must be YYYY-MM" };
	return { month: month ?? new Date().toISOString().slice(0, 7), json };
}
