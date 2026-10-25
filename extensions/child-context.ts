import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { filterChildSessionContextFiles, type ContextFileOptions } from "../lib/child-context-files.ts";

// nubia-shell#1587: delegated children drop the orchestrator-only nub-ia
// managed blocks from their context files. Nub-IA Agents passes this file to
// every child with --extension because children do not load the nub-ia
// package in the isolated Nub-IA home. It registers one hook and has no
// other side effects; outside a child session it is a no-op.
export function createChildContextExtension(env: NodeJS.ProcessEnv = process.env): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			if (env.NUB_IA_AGENTS_CHILD !== "1") return undefined;
			// The filtered copies replace contextFiles on the same options object
			// (pi-claude-bridge rebuilds its prompt from it). This never throws,
			// keeps the original files on any error or malformed markers, and is
			// idempotent: already-filtered content has nothing left to remove.
			const options = (event as { systemPromptOptions?: ContextFileOptions | null } | undefined)?.systemPromptOptions;
			filterChildSessionContextFiles(options);
			return undefined;
		});
	};
}

export default function childContextExtension(pi: ExtensionAPI): void {
	createChildContextExtension()(pi);
}
