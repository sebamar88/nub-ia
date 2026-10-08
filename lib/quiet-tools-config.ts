import { readEnv } from "./config-home.ts";

export const QUIET_TOOLS_ENV = "NUB_IA_QUIET_TOOLS";
export const PI_PRETTY_SUPPRESSED_TOOL_NAMES = ["read", "bash", "ls", "find", "grep"] as const;

export function quietToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return readEnv(env, QUIET_TOOLS_ENV) !== "0";
}

export function mergeDisabledTools(existing: string | undefined, tools: readonly string[]): string {
	const disabled = new Set(
		(existing ?? "")
			.split(",")
			.map((tool) => tool.trim().toLowerCase())
			.filter(Boolean),
	);
	for (const tool of tools) disabled.add(tool);
	return [...disabled].join(",");
}
