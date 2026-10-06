export function runtimeMetricsEnvAllows(env: NodeJS.ProcessEnv): boolean {
	// Unknown nonempty spellings veto too: never weaken an environment veto.
	const truthy = (value: string | undefined) => !["", "0", "false", "no", "off"].includes(value?.trim().toLowerCase() ?? "");
	return !truthy(env.DO_NOT_TRACK) && !truthy(env.CI) && !truthy(env.GITHUB_ACTIONS)
		&& env.GENTLE_AI_TELEMETRY?.trim() !== "0";
}
