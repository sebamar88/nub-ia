import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nubIaConfigHome } from "./config-home.ts";

// Local JSONL sink for the in-process runtime metrics collector: one JSON line
// per aggregated row at `<configHome>/metrics/runtime-<YYYY-MM>.jsonl`. Nothing
// leaves the machine. Rotation is by month only; a month file past the cap stops
// growing and gets a `.capped` marker (written once). Set NUB_IA_METRICS=off to disable.

export const RUNTIME_METRICS_MAX_BYTES = 20 * 1024 * 1024;

export interface RuntimeMetricsSinkOptions {
	configHome?: string;
	now?: () => Date;
	maxBytes?: number;
}

export function runtimeMetricsSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.NUB_IA_METRICS?.trim().toLowerCase() !== "off";
}

export function runtimeMetricsFilePath(env: NodeJS.ProcessEnv = process.env, options: RuntimeMetricsSinkOptions = {}): string {
	const date = (options.now ?? (() => new Date()))();
	const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
	return join(options.configHome ?? nubIaConfigHome(env), "metrics", `runtime-${month}.jsonl`);
}

/** Append rows as JSON lines. Resolves to the number of rows written (0 when off, empty or capped). */
export async function appendRuntimeMetricRows(
	rows: readonly unknown[],
	env: NodeJS.ProcessEnv = process.env,
	options: RuntimeMetricsSinkOptions = {},
): Promise<number> {
	if (!rows.length || !runtimeMetricsSinkEnabled(env)) return 0;
	const path = runtimeMetricsFilePath(env, options);
	const marker = `${path}.capped`;
	const size = await stat(path).then((info) => info.size, () => 0);
	await mkdir(join(path, ".."), { recursive: true });
	if (size > (options.maxBytes ?? RUNTIME_METRICS_MAX_BYTES)) {
		await writeFile(marker, `${new Date().toISOString()}\n`, { flag: "wx" }).catch(() => undefined);
		return 0;
	}
	await appendFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
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
