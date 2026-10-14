// Subagents block of the Status card (roadmap T6.1–T6.3): payload, headline, lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_STATUS, type TaskRecord } from "../lib/agents-protocol.ts";
import { AGENTS_STATUS_EVENT, agentsStatusLines, agentsStatusPayload, parseAgentsStatus, taskHeadline } from "../lib/agents-status-model.ts";

const NOW = 1_000_000;

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, "id" | "status">): TaskRecord {
	return {
		id: overrides.id,
		agent: "nubia-worker",
		mode: "task",
		prompt: "Implement the footer\n\nDetails...",
		label: "",
		cwd: "/repo",
		parentSessionId: "s1",
		status: overrides.status,
		createdAt: NOW - 120_000,
		startedAt: NOW - 124_000,
		endedAt: null,
		model: "nub-ia/balanced",
		thinking: undefined,
		sessionPath: null,
		error: null,
		result: null,
		lastStep: "",
		tokens: 0,
		cost: 0,
		...overrides,
	} as TaskRecord;
}

test("taskHeadline: prefers the label, falls back to the first non-empty prompt line, clips and sanitizes", () => {
	assert.equal(taskHeadline({ label: "map footer data sources", prompt: "ignored" }), "map footer data sources");
	assert.equal(taskHeadline({ label: "  ", prompt: "\n\n  Implement the footer  \nmore" }), "Implement the footer");
	assert.equal(taskHeadline({ label: "", prompt: "" }), "(untitled task)");
	assert.equal(taskHeadline({ label: "a\u001b[31mred\u001b[0m\tb\u0007", prompt: "" }), "ared b");
	const long = taskHeadline({ label: "x".repeat(100), prompt: "" });
	assert.equal([...long].length, 40);
	assert.ok(long.endsWith("…"));
	assert.equal(taskHeadline({ label: "é".repeat(40), prompt: "" }), "é".repeat(40));
});

test("agentsStatusPayload: counts by status, active items first in start order, finished ones only when recent", () => {
	const tasks = [
		task({ id: "old", status: TASK_STATUS.COMPLETED, startedAt: NOW - 900_000, endedAt: NOW - 600_000 }),
		task({ id: "b", status: TASK_STATUS.RUNNING, label: "second", startedAt: NOW - 10_000 }),
		task({ id: "a", status: TASK_STATUS.RUNNING, label: "first", startedAt: NOW - 20_000 }),
		task({ id: "q", status: TASK_STATUS.QUEUED, startedAt: null, createdAt: NOW - 1_000 }),
		task({ id: "done", status: TASK_STATUS.FAILED, agent: "nubia-verify", label: "run tests", startedAt: NOW - 50_000, endedAt: NOW - 5_000 }),
	];
	const payload = agentsStatusPayload(tasks, NOW);
	assert.equal(payload.schema, AGENTS_STATUS_EVENT);
	assert.deepEqual([payload.running, payload.queued, payload.waiting, payload.finished], [2, 1, 0, 2]);
	assert.deepEqual(payload.items.map((item) => [item.agent, item.headline, item.status]), [
		["nubia-verify", "run tests", "failed"],
		["nubia-worker", "first", "running"],
		["nubia-worker", "second", "running"],
		["nubia-worker", "Implement the footer", "queued"],
	]);
	assert.deepEqual(agentsStatusPayload([], NOW), { schema: AGENTS_STATUS_EVENT, running: 0, queued: 0, waiting: 0, finished: 0, items: [] });
});

test("parseAgentsStatus: accepts its own payloads and rejects anything off-shape", () => {
	const payload = agentsStatusPayload([task({ id: "a", status: TASK_STATUS.RUNNING, label: "x" })], NOW);
	assert.deepEqual(parseAgentsStatus(JSON.parse(JSON.stringify(payload))), payload);
	assert.equal(parseAgentsStatus(undefined), undefined);
	assert.equal(parseAgentsStatus({ ...payload, schema: "other" }), undefined);
	assert.equal(parseAgentsStatus({ ...payload, running: -1 }), undefined);
	assert.equal(parseAgentsStatus({ ...payload, items: [{ ...payload.items[0], status: "exploded" }] }), undefined);
	assert.equal(parseAgentsStatus({ ...payload, items: [{ ...payload.items[0], startedAt: "now" }] }), undefined);
	assert.equal(parseAgentsStatus({ ...payload, items: "none" }), undefined);
	const sanitized = parseAgentsStatus({ ...payload, items: [{ ...payload.items[0], headline: "a\u001b[2Jb" }] });
	assert.equal(sanitized?.items[0]?.headline, "ab");
});

test("agentsStatusLines: headline, tone and rows; elapsed from startedAt for active, frozen at endedAt for finished", () => {
	assert.deepEqual(agentsStatusLines(undefined, NOW), { headline: "No subagents", tone: "none", items: [] });
	const payload = agentsStatusPayload([
		task({ id: "a", status: TASK_STATUS.RUNNING, label: "map footer data sources", startedAt: NOW - 124_000 }),
		task({ id: "w", status: TASK_STATUS.WAITING, agent: "nubia-explore", label: "needs an answer", startedAt: NOW - 30_000 }),
		task({ id: "q", status: TASK_STATUS.QUEUED, label: "queued one", startedAt: null, createdAt: NOW - 1_000 }),
		task({ id: "d", status: TASK_STATUS.COMPLETED, agent: "nubia-verify", label: "run tests", startedAt: NOW - 50_000, endedAt: NOW - 5_000 }),
	], NOW);
	const lines = agentsStatusLines(payload, NOW);
	assert.equal(lines.headline, "1 running · 1 waiting · 1 queued");
	assert.equal(lines.tone, "waiting");
	assert.deepEqual(lines.items, [
		'◐ nubia-worker · "map footer data sources" · 2m04s',
		'✓ nubia-verify · "run tests" · 45s',
		'? nubia-explore · "needs an answer" · 30s',
		"+1 more · /nubia:agents",
	]);
	const later = agentsStatusLines(payload, NOW + 60_000, 4);
	assert.equal(later.items[0], '◐ nubia-worker · "map footer data sources" · 3m04s');
	assert.equal(later.items[1], '✓ nubia-verify · "run tests" · 45s');
	assert.equal(later.items[3], '○ nubia-worker · "queued one"');
});

test("agentsStatusLines: only finished items read as done; a running batch is active", () => {
	const done = agentsStatusPayload([task({ id: "d", status: TASK_STATUS.COMPLETED, startedAt: NOW - 9_000, endedAt: NOW - 1_000 })], NOW);
	assert.equal(agentsStatusLines(done, NOW).headline, "1 just finished");
	assert.equal(agentsStatusLines(done, NOW).tone, "done");
	const active = agentsStatusPayload([task({ id: "a", status: TASK_STATUS.RUNNING }), task({ id: "b", status: TASK_STATUS.RUNNING })], NOW);
	assert.equal(agentsStatusLines(active, NOW).headline, "2 running");
	assert.equal(agentsStatusLines(active, NOW).tone, "active");
});
