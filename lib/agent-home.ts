import { homedir } from "node:os";
import { nubIaConfigHome } from "./config-home.ts";
import { join } from "node:path";

// Pi Subagents resolves its global directory as `PI_CODING_AGENT_DIR || ~/.pi/agent`,
// so an empty value must fall through here too or the two homes diverge again.
export function resolveGentlePiAgentHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.NUB_IA_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

// The extension config directory outside `~/.pi/agent`: everything the extension
// commands own lives here. Canonical home is `~/.pi/nub-ia` (NUB_IA_CONFIG_HOME); this is the WRITE location. Readers go through
// `configReadPath` (lib/config-home.ts) to fall back to the legacy `~/.pi/gentle-ai`.
export function gentlePiConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	return nubIaConfigHome(env);
}
