import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nubIaConfigHome } from "./config-home.ts";
import { sendTeamBatches, teamBatches, teamSinkConfig, type Fetcher } from "./team-metrics-sink.ts";

// Local JSONL sink for in-process metrics: one JSON line per row at
// `<configHome>/metrics/<name>-<YYYY-MM>.jsonl`. The runtime collector writes
// `runtime-*`; the 4R review writes `review-*` (lib/nub-review-metrics.ts).
// Nothing leaves the machine. Rotation is by month only; a month file past the
// cap stops growing and gets a `.capped` marker (written once). Set
// NUB_IA_METRICS=off to disable every sink.

export const RUNTIME_METRICS_MAX_BYTES = 20 * 1024 * 1024;

export type MetricsFileName = "runtime" | "review" | "audit";
/** Where each named file lives under the config home. */
const DIRECTORY: Record<MetricsFileName, string> = { runtime: "metrics", review: "metrics", audit: "audit" };

export interface RuntimeMetricsSinkOptions {
	configHome?: string;
	now?: () => Date;
	maxBytes?: number;
	/** Test hook for the optional team sink (defaults to globalThis.fetch). */
	fetcher?: Fetcher;
	/** Receives the team-sink outcome; absent means fire-and-forget. */
	onTeamSink?: (result: { sent: number; failed: number }) => void;
}

export function runtimeMetricsSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.NUB_IA_METRICS?.trim().toLowerCase() !== "off";
}

export function metricsFilePath(name: MetricsFileName, env: NodeJS.ProcessEnv = process.env, options: RuntimeMetricsSinkOptions = {}): string {
	const date = (options.now ?? (() => new Date()))();
	const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
	return join(options.configHome ?? nubIaConfigHome(env), DIRECTORY[name], `${name}-${month}.jsonl`);
}

export function runtimeMetricsFilePath(env: NodeJS.ProcessEnv = process.env, options: RuntimeMetricsSinkOptions = {}): string {
	return metricsFilePath("runtime", env, options);
}

/** Append rows as JSON lines. Resolves to the number of rows written (0 when off, empty or capped). */
export async function appendRuntimeMetricRows(
	rows: readonly unknown[],
	env: NodeJS.ProcessEnv = process.env,
	options: RuntimeMetricsSinkOptions = {},
): Promise<number> {
	return appendMetricRows("runtime", rows, env, options);
}

export async function appendMetricRows(
	name: MetricsFileName,
	rows: readonly unknown[],
	env: NodeJS.ProcessEnv = process.env,
	options: RuntimeMetricsSinkOptions = {},
): Promise<number> {
	if (!rows.length || !runtimeMetricsSinkEnabled(env)) return 0;
	const path = metricsFilePath(name, env, options);
	const marker = `${path}.capped`;
	const size = await stat(path).then((info) => info.size, () => 0);
	await mkdir(join(path, ".."), { recursive: true });
	if (size > (options.maxBytes ?? RUNTIME_METRICS_MAX_BYTES)) {
		await writeFile(marker, `${new Date().toISOString()}\n`, { flag: "wx" }).catch(() => undefined);
		return 0;
	}
	await appendFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
	// Optional team mirror (lib/team-metrics-sink.ts): same rows, sanitized,
	// best effort, never awaited by the caller's decision path.
	const team = teamSinkConfig(env);
	if (team) {
		const fetcher: Fetcher | undefined = options.fetcher ?? (typeof globalThis.fetch === "function" ? (url, init) => globalThis.fetch(url, init) : undefined);
		if (fetcher) {
			const outcome = sendTeamBatches(teamBatches(name, rows, team, (options.now ?? (() => new Date()))()), team, fetcher).catch(() => ({ sent: 0, failed: 1 }));
			if (options.onTeamSink) options.onTeamSink(await outcome);
			else void outcome;
		}
	}
	return rows.length;
}

/** Row count and path of the current month's file, for a one-line status. */
export async function runtimeMetricsSummary(
	env: NodeJS.ProcessEnv = process.env,
	options: RuntimeMetricsSinkOptions = {},
): Promise<{ rows: number; path: string }> {
	const path = runtimeMetricsFilePath(env, options);
	try {
		const text = await readFile(path, "utf8");
		return { rows: text.split("\n").filter(Boolean).length, path };
	} catch {
		return { rows: 0, path };
	}
}
