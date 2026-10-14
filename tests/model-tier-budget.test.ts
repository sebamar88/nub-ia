// Tier budget (roadmap T2.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetState, degradeTier, describeBudget, effectiveTier, parseBudget, readSpendLedger, spendLedgerName, tightestBudget, writeSpendLedger } from "../lib/model-tier-budget.ts";

test("parseBudget: positive limits only, onExceed defaults to warn, nothing without a limit", () => {
	assert.deepEqual(parseBudget({ dailyUsd: 20, sessionUsd: 5, onExceed: "degrade" }), { dailyUsd: 20, sessionUsd: 5, onExceed: "degrade" });
	assert.deepEqual(parseBudget({ dailyUsd: 20 }), { dailyUsd: 20, onExceed: "warn" });
	assert.deepEqual(parseBudget({ dailyUsd: 20, onExceed: "explode" }), { dailyUsd: 20, onExceed: "warn" });
	assert.equal(parseBudget({ dailyUsd: 0 }), undefined);
	assert.equal(parseBudget({ dailyUsd: -1, sessionUsd: "5" }), undefined);
	assert.equal(parseBudget(undefined), undefined);
	assert.equal(parseBudget([]), undefined);
});

test("tightestBudget: a repository can only lower limits or escalate warn → degrade", () => {
	const base = { dailyUsd: 20, sessionUsd: 5, onExceed: "warn" as const };
	assert.deepEqual(tightestBudget(base, { dailyUsd: 50, sessionUsd: 2, onExceed: "warn" }), { dailyUsd: 20, sessionUsd: 2, onExceed: "warn" });
	assert.deepEqual(tightestBudget(base, { dailyUsd: 10, onExceed: "degrade" }), { dailyUsd: 10, sessionUsd: 5, onExceed: "degrade" });
	assert.deepEqual(tightestBudget({ dailyUsd: 10, onExceed: "degrade" }, { dailyUsd: 100, onExceed: "warn" }), { dailyUsd: 10, onExceed: "degrade" });
	assert.deepEqual(tightestBudget(undefined, base), base);
	assert.deepEqual(tightestBudget(base, undefined), base);
	assert.equal(tightestBudget(undefined, undefined), undefined);
});

test("budgetState and effectiveTier: the most-used limit decides; degrade steps strong/strong-alt → balanced → fast", () => {
	const policy = { dailyUsd: 20, sessionUsd: 5, onExceed: "degrade" as const };
	assert.deepEqual(budgetState(undefined, { todayUsd: 100, sessionUsd: 100 }), { degrade: false });
	assert.deepEqual(budgetState(policy, { todayUsd: 10, sessionUsd: 1 }), { ratio: 0.5, degrade: false });
	assert.deepEqual(budgetState(policy, { todayUsd: 10, sessionUsd: 5 }), { exceeded: "session", ratio: 1, degrade: true });
	assert.deepEqual(budgetState(policy, { todayUsd: 30, sessionUsd: 1 }), { exceeded: "daily", ratio: 1.5, degrade: true });
	assert.deepEqual(budgetState({ ...policy, onExceed: "warn" }, { todayUsd: 30, sessionUsd: 1 }), { exceeded: "daily", ratio: 1.5, degrade: false });
	assert.equal(degradeTier("strong"), "balanced");
	assert.equal(degradeTier("strong-alt"), "balanced");
	assert.equal(degradeTier("balanced"), "fast");
	assert.equal(degradeTier("fast"), "fast");
	assert.deepEqual(effectiveTier("strong", { degrade: true, exceeded: "daily", ratio: 2 }), { tier: "balanced", degraded: true });
	assert.deepEqual(effectiveTier("fast", { degrade: true, exceeded: "daily", ratio: 2 }), { tier: "fast", degraded: false });
	assert.deepEqual(effectiveTier("strong", { degrade: false }), { tier: "strong", degraded: false });
});

test("spend ledger: UTC day file name, lenient read, rounded write", () => {
	assert.equal(spendLedgerName(new Date("2026-03-04T23:59:59Z")), "spend-2026-03-04.json");
	assert.equal(readSpendLedger(undefined), 0);
	assert.equal(readSpendLedger("garbage"), 0);
	assert.equal(readSpendLedger('{"usd":-3}'), 0);
	assert.equal(readSpendLedger('{"usd":1.25}'), 1.25);
	assert.equal(writeSpendLedger(1.23456789), '{"usd":1.234568}\n');
	assert.equal(writeSpendLedger(-1), '{"usd":0}\n');
});

test("describeBudget: compact status line with the crossed limit", () => {
	const policy = { dailyUsd: 20, sessionUsd: 5, onExceed: "degrade" as const };
	assert.equal(describeBudget(policy, { todayUsd: 3.21, sessionUsd: 0.8 }, { ratio: 0.16, degrade: false }), "budget $3.21 / $20 today · $0.80 / $5.00 session");
	assert.equal(describeBudget(policy, { todayUsd: 25, sessionUsd: 0.8 }, { exceeded: "daily", ratio: 1.25, degrade: true }), "budget $25 / $20 today · $0.80 / $5.00 session · over daily budget, routing degraded");
	assert.equal(describeBudget({ dailyUsd: 20, onExceed: "warn" }, { todayUsd: 25, sessionUsd: 0 }, { exceeded: "daily", ratio: 1.25, degrade: false }), "budget $25 / $20 today · over daily budget");
});
