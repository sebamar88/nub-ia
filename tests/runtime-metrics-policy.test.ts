import assert from "node:assert/strict";
import test from "node:test";
import { runtimeMetricsEnvAllows } from "../lib/runtime-metrics-policy.ts";

test("environment veto accepts broad truthy spellings", () => {
	for (const key of ["DO_NOT_TRACK", "CI", "GITHUB_ACTIONS"]) {
		for (const value of ["1", "true", "TRUE", " yes ", "on", "t", "unknown"]) assert.equal(runtimeMetricsEnvAllows({ [key]: value }), false);
	}
	assert.equal(runtimeMetricsEnvAllows({ GENTLE_AI_TELEMETRY: "0" }), false);
	assert.equal(runtimeMetricsEnvAllows({ DO_NOT_TRACK: "false", CI: "0" }), true);
});
