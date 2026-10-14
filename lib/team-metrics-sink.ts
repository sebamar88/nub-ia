// Team metrics sink (roadmap T3.3): optional forwarding of the local JSONL rows
// (runtime, review, audit) to an endpoint the team operates. Off unless
// NUB_IA_METRICS_ENDPOINT is set; NUB_IA_METRICS=off disables it along with the
// local files. Rows are sent as they are written locally, in small batches,
// after a privacy pass: audit subjects are already redacted and clipped, and the
// fields below are dropped outright so a team dashboard never sees a path, a
// repository name or a session id it did not need.

import { redactSecrets } from "./secret-redaction.ts";

export const METRICS_ENDPOINT_ENV = "NUB_IA_METRICS_ENDPOINT";
export const METRICS_TOKEN_ENV = "NUB_IA_METRICS_TOKEN";
export const TEAM_SINK_SCHEMA = "nub-ia.team-metrics/v1";
export const TEAM_SINK_MAX_ROWS = 64;
export const TEAM_SINK_MAX_BYTES = 256 * 1024;

export type SinkName = "runtime" | "review" | "audit";

/** Row fields never forwarded (local-only context). */
const DROPPED_FIELDS = new Set(["repository", "reportPath", "sessionId", "cwd", "path"]);

export interface TeamSinkConfig {
	endpoint: string;
	token?: string;
	/** Stable, non-identifying installation label (hostname hash or a team-chosen id). */
	installation?: string;
}

export function teamSinkConfig(env: NodeJS.ProcessEnv): TeamSinkConfig | undefined {
	if (env.NUB_IA_METRICS?.trim().toLowerCase() === "off") return undefined;
	const endpoint = env[METRICS_ENDPOINT_ENV]?.trim();
	if (!endpoint || !/^https:\/\/[^\s]+$/i.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(endpoint)) return undefined;
	const token = env[METRICS_TOKEN_ENV]?.trim();
	const installation = env.NUB_IA_METRICS_INSTALLATION?.trim();
	return { endpoint, ...(token ? { token } : {}), ...(installation ? { installation: installation.slice(0, 64) } : {}) };
}

/** A row as the team sink receives it: dropped fields removed, every string redacted. */
export function sanitizeForTeam(row: unknown): Record<string, unknown> | undefined {
	if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
		if (DROPPED_FIELDS.has(key)) continue;
		out[key] = typeof value === "string" ? redactSecrets(value).text.slice(0, 400) : typeof value === "object" && value !== null && !Array.isArray(value) ? sanitizeForTeam(value) : value;
	}
	return out;
}

export interface TeamBatch {
	schema: typeof TEAM_SINK_SCHEMA;
	sink: SinkName;
	installation?: string;
	sentAt: string;
	rows: Record<string, unknown>[];
}

/** Splits rows into batches under both the row and byte caps. */
export function teamBatches(sink: SinkName, rows: readonly unknown[], config: TeamSinkConfig, now: Date): TeamBatch[] {
	const sanitized = rows.map(sanitizeForTeam).filter((row): row is Record<string, unknown> => row !== undefined);
	const batches: TeamBatch[] = [];
	let current: Record<string, unknown>[] = [];
	let bytes = 0;
	const flush = () => { if (current.length) batches.push({ schema: TEAM_SINK_SCHEMA, sink, ...(config.installation ? { installation: config.installation } : {}), sentAt: now.toISOString(), rows: current }); current = []; bytes = 0; };
	for (const row of sanitized) {
		const size = Buffer.byteLength(JSON.stringify(row), "utf8");
		if (current.length && (current.length >= TEAM_SINK_MAX_ROWS || bytes + size > TEAM_SINK_MAX_BYTES)) flush();
		current.push(row);
		bytes += size;
	}
	flush();
	return batches;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/**
 * One best-effort POST per batch; failures are counted, never retried or
 * queued (the local file is the record; the team sink is a mirror).
 */
export async function sendTeamBatches(batches: readonly TeamBatch[], config: TeamSinkConfig, fetcher: Fetcher, timeoutMs = 5_000): Promise<{ sent: number; failed: number }> {
	let sent = 0, failed = 0;
	for (const batch of batches) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetcher(config.endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": "nub-ia-metrics/1", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
				body: JSON.stringify(batch),
				signal: controller.signal,
			});
			if (response.ok) sent += 1; else failed += 1;
		} catch {
			failed += 1;
		} finally {
			clearTimeout(timer);
		}
	}
	return { sent, failed };
}
