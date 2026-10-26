// `/nubia:grill [tema]` (alias `/nubia:quiz`): starts the nubia-grill-me skill
// as a user turn. The command only composes the request and hands it to the
// model; the skill itself (skills/nubia-grill-me/SKILL.md) owns the method and
// its "no action until confirmed" rule. Headless sessions get nothing: a grill
// needs someone to answer.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cmd, cmdSlash } from "../lib/brand.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const GRILL_SKILL_PATH = join(PACKAGE_ROOT, "skills", "nubia-grill-me", "SKILL.md");

/** The user message that launches a grilling round about `topic` (or the current plan). */
export function grillRequest(topic: string, skillPath: string = GRILL_SKILL_PATH): string {
	const subject = topic.trim().length > 0 ? `this: ${topic.trim()}` : "the plan or decision we are currently discussing (my last messages); if nothing is on the table yet, ask me first what to grill";
	return [
		`Grill me about ${subject}.`,
		`Load the nubia-grill-me skill first (read ${skillPath}) and follow it exactly: map the design tree, ask the whole frontier per round with a numbered recommendation each (a "yes" accepts it), look facts up yourself, and do not implement, delegate or create tasks until I confirm we share the understanding.`,
	].join("\n");
}

export default function registerNubiaGrill(pi: ExtensionAPI): void {
	for (const [name, note] of [[cmd("grill"), ""], [cmd("quiz"), ` (alias of ${cmdSlash("grill")})`]] as const) {
		pi.registerCommand(name, {
			description: `Grill me: a relentless round-based interview about a plan, design or decision before anything is built${note}. Optional argument: the topic.`,
			handler: async (args, ctx) => {
				if (!ctx.hasUI) return;
				if (!existsSync(GRILL_SKILL_PATH)) { ctx.ui.notify(`The nubia-grill-me skill is missing at ${GRILL_SKILL_PATH}.`, "warning"); return; }
				pi.sendUserMessage(grillRequest(args));
			},
		});
	}
}
