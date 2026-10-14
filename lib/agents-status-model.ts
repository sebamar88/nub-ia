// Subagents in the Status card (roadmap T6.1–T6.3). The agents extension owns
// the TaskStore; the shell owns the Status card. They share a small, sanitized
// payload over `pi.events` instead of a module-level singleton, mirroring the
// usage-source channel: the publisher emits on every store change, the shell
// keeps the last payload and derives elapsed times at render time, so the
// clock the Agents widget already ticks refreshes this block for free.

import { isFinished, TASK_STATUS, type TaskRecord, type TaskStatus } from "./agents-protocol.ts";
import { formatElapsed, widgetTasks } from "./agents-widget.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export const AGENTS_STATUS_EVENT = "nubia:agents-status/v1";

/** Rows the Status block lists before folding the rest into "+N more". */
export const AGENTS_STATUS_MAX_ROWS = 3;
const HEADLINE_MAX = 40;

export interface AgentsStatusItem {
	agent: string;
	headline: string;
	status: TaskStatus;
	startedAt: number | null;
	endedAt: number | null;
}

export interface AgentsStatusPayload {
	schema: typeof AGENTS_STATUS_EVENT;
	running: number;
	queued: number;
	waiting: number;
	finished: number;
	/** Active tasks plus the few that just finished, in start order (widgetTasks). */
	items: AgentsStatusItem[];
}

const STATUSES = new Set<string>(Object.values(TASK_STATUS));

/**
 * One line naming what a task does: the label the orchestrator supplied,
 * else the first line of the prompt. Control characters are stripped and the
 * result clipped so a hostile or verbose prompt cannot reshape the card.
 */
export function taskHeadline(task: Pick<TaskRecord, "label" | "prompt">, max = HEADLINE_MAX): string {
	const source = task.label.trim() || task.prompt.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
	const clean = sanitizeTerminalText(source).replace(/\s+/g, " ").trim();
	if (clean.length === 0) return "(untitled task)";
	return [...clean].length <= max ? clean : `${[...clean].slice(0, Math.max(1, max - 1)).join("")}…`;
}

export function agentsStatusPayload(tasks: readonly TaskRecord[], now: number): AgentsStatusPayload {
	let running = 0, queued = 0, waiting = 0, finished = 0;
	for (const task of tasks) {
		if (task.status === TASK_STATUS.RUNNING) running += 1;
		else if (task.status === TASK_STATUS.QUEUED) queued += 1;
		else if (task.status === TASK_STATUS.WAITING) waiting += 1;
		else finished += 1;
	}
	return {
		schema: AGENTS_STATUS_EVENT,
		running,
		queued,
		waiting,
		finished,
		items: widgetTasks(tasks, now).map((task) => ({
			agent: sanitizeTerminalText(task.agent).slice(0, 40),
			headline: taskHeadline(task),
			status: task.status,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
		})),
	};
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const stamp = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value));

/** Validates an event payload from any publisher; anything off-shape is ignored. */
export function parseAgentsStatus(value: unknown): AgentsStatusPayload | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.schema !== AGENTS_STATUS_EVENT) return undefined;
	if (!count(record.running) || !count(record.queued) || !count(record.waiting) || !count(record.finished)) return undefined;
	if (!Array.isArray(record.items) || record.items.length > 64) return undefined;
	const items: AgentsStatusItem[] = [];
	for (const entry of record.items) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const item = entry as Record<string, unknown>;
		if (typeof item.agent !== "string" || typeof item.headline !== "string" || typeof item.status !== "string" || !STATUSES.has(item.status)) return undefined;
		if (!stamp(item.startedAt) || !stamp(item.endedAt)) return undefined;
		items.push({ agent: sanitizeTerminalText(item.agent).slice(0, 40), headline: sanitizeTerminalText(item.headline).slice(0, HEADLINE_MAX + 1), status: item.status as TaskStatus, startedAt: item.startedAt, endedAt: item.endedAt });
	}
	return { schema: AGENTS_STATUS_EVENT, running: record.running, queued: record.queued, waiting: record.waiting, finished: record.finished, items };
}

export interface AgentsStatusLines {
	/** "2 running · 1 queued" or "No subagents". */
	headline: string;
	tone: "active" | "waiting" | "done" | "none";
	/** `◐ nubia-worker · "map footer data sources" · 2m04s`, at most AGENTS_STATUS_MAX_ROWS plus an overflow line. */
	items: string[];
}

const GLYPH: Record<TaskStatus, string> = {
	[TASK_STATUS.QUEUED]: "○",
	[TASK_STATUS.RUNNING]: "◐",
	[TASK_STATUS.WAITING]: "?",
	[TASK_STATUS.COMPLETED]: "✓",
	[TASK_STATUS.FAILED]: "✗",
	[TASK_STATUS.CANCELLED]: "–",
	[TASK_STATUS.TIMED_OUT]: "✗",
};

function elapsed(item: AgentsStatusItem, now: number): string | undefined {
	if (item.startedAt === null) return undefined;
	return formatElapsed((isFinished(item.status) && item.endedAt !== null ? item.endedAt : now) - item.startedAt);
}

/** The Status card "Subagents" block; `undefined` payload means the agents extension never reported. */
export function agentsStatusLines(payload: AgentsStatusPayload | undefined, now: number, maxRows = AGENTS_STATUS_MAX_ROWS): AgentsStatusLines {
	if (!payload || payload.items.length === 0) return { headline: "No subagents", tone: "none", items: [] };
	const parts = [
		...(payload.running ? [`${payload.running} running`] : []),
		...(payload.waiting ? [`${payload.waiting} waiting`] : []),
		...(payload.queued ? [`${payload.queued} queued`] : []),
	];
	const activeCount = payload.running + payload.waiting + payload.queued;
	const headline = parts.length ? parts.join(" · ") : `${payload.items.length} just finished`;
	const tone = payload.waiting ? "waiting" : activeCount ? "active" : "done";
	const shown = payload.items.slice(0, Math.max(0, maxRows));
	const items = shown.map((item) => {
		const time = elapsed(item, now);
		return `${GLYPH[item.status]} ${item.agent} · "${item.headline}"${time ? ` · ${time}` : ""}`;
	});
	const hidden = payload.items.length - shown.length;
	if (hidden > 0) items.push(`+${hidden} more · /nubia:agents`);
	return { headline, tone, items };
}
