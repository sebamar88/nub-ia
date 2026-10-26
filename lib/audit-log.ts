// Local audit trail (roadmap T8.4): one JSON line per governance-relevant
// decision at <configHome>/audit/audit-<YYYY-MM>.jsonl. What is recorded is the
// decision and its subject, never prompt text: a shell command is redacted and
// clipped, a path is kept (it is the thing being governed), a review is its
// hash and verdict. Local only; the optional team sink (T3.3) may forward it.

import { redactSecrets } from "./secret-redaction.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { brand } from "./brand.ts";

export const AUDIT_SCHEMA = "nub-ia.audit/v1";

export type AuditKind =
	| "mode.change"
	| "tool.ask"
	| "tool.deny"
	| "guardrail.confirm"
	| "guardrail.block"
	| "path.deny"
	| "delegation.deny"
	| "push.gate"
	| "review.verdict"
	| "policy.refresh"
	| "package.install";

export interface AuditRow {
	schema: typeof AUDIT_SCHEMA;
	at: string;
	kind: AuditKind;
	/** Decision outcome where applicable. */
	outcome?: "approved" | "denied" | "blocked" | "allowed" | "warned";
	/** Who decided: the human in a dialog, a policy layer, or the mode. */
	by?: "human" | "mode" | "path-policy" | "agent-policy" | "limits" | "guardrail" | "review-gate" | "org-policy";
	tool?: string;
	/** Redacted, whitespace-collapsed, clipped subject: a command, a path, a mode name. */
	subject?: string;
	mode?: string;
	role?: string;
	diffHash?: string;
	verdict?: string;
	detail?: string;
	/** Repository root the decision happened in (a path, never contents). */
	repository?: string;
	/** True when a delegated child produced the row. */
	child?: boolean;
}

const SUBJECT_MAX = 200;

/** Collapses, redacts and clips a subject so a row never carries a secret or a wall of text. */
export function auditSubject(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const clean = sanitizeTerminalText(redactSecrets(value).text).replace(/\s+/g, " ").trim();
	if (clean.length === 0) return undefined;
	return clean.length <= SUBJECT_MAX ? clean : `${clean.slice(0, SUBJECT_MAX - 1)}…`;
}

export function auditRow(input: Omit<AuditRow, "schema" | "at" | "subject"> & { subject?: string; when?: Date }): AuditRow {
	const { when, subject, ...rest } = input;
	const cleaned = auditSubject(subject);
	const row: AuditRow = { schema: AUDIT_SCHEMA, at: (when ?? new Date()).toISOString(), ...rest, ...(cleaned ? { subject: cleaned } : {}) };
	for (const key of Object.keys(row) as (keyof AuditRow)[]) if (row[key] === undefined) delete row[key];
	return row;
}

export function auditFileName(date: Date): string {
	return `audit-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

// --- reading / summary ----------------------------------------------------------------

export function parseAuditRows(text: string): { rows: AuditRow[]; skipped: number } {
	const rows: AuditRow[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as Partial<AuditRow>;
			if (parsed.schema === AUDIT_SCHEMA && typeof parsed.kind === "string" && typeof parsed.at === "string") rows.push(parsed as AuditRow);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { rows, skipped };
}

export interface AuditSummary {
	rows: number;
	byKind: Record<string, number>;
	denied: number;
	approved: number;
	modeChanges: number;
	pushesGated: number;
	since?: string;
	until?: string;
}

export function summarizeAudit(rows: readonly AuditRow[]): AuditSummary {
	const byKind: Record<string, number> = {};
	let denied = 0, approved = 0, modeChanges = 0, pushesGated = 0;
	for (const row of rows) {
		byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
		if (row.outcome === "denied" || row.outcome === "blocked") denied += 1;
		if (row.outcome === "approved") approved += 1;
		if (row.kind === "mode.change") modeChanges += 1;
		if (row.kind === "push.gate") pushesGated += 1;
	}
	const times = rows.map((row) => row.at).sort();
	return { rows: rows.length, byKind, denied, approved, modeChanges, pushesGated, ...(times.length ? { since: times[0], until: times.at(-1) } : {}) };
}

export function renderAuditSummary(summary: AuditSummary, source: string): string {
	if (summary.rows === 0) return `No audit rows yet in ${source}.`;
	const kinds = Object.entries(summary.byKind).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join(" · ");
	return [
		`${brand.name} audit · ${summary.rows} row${summary.rows === 1 ? "" : "s"} in ${source}${summary.since ? ` · ${summary.since.slice(0, 10)} → ${summary.until?.slice(0, 10)}` : ""}`,
		`Approved ${summary.approved} · denied/blocked ${summary.denied} · mode changes ${summary.modeChanges} · gated pushes ${summary.pushesGated}`,
		kinds,
	].join("\n");
}

/** Today's denials/blocks for the Status card line ("3 blocked today"). */
export function auditToday(rows: readonly AuditRow[], now: Date): { denied: number; approved: number } {
	const day = now.toISOString().slice(0, 10);
	let denied = 0, approved = 0;
	for (const row of rows) {
		if (!row.at.startsWith(day)) continue;
		if (row.outcome === "denied" || row.outcome === "blocked") denied += 1;
		if (row.outcome === "approved") approved += 1;
	}
	return { denied, approved };
}
