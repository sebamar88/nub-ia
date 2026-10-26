// `/nubia:workflow [none|sdd|svsd|status|default <workflow>]`: the Development
// Workflow of this session (see lib/workflow-config.ts). Independent from the
// permission mode: it only adds a short directive to the primary session's
// system prompt. A choice made here lasts for the session; `default` saves it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nubIaConfigHome, readEnv } from "../lib/config-home.ts";
import { DEFAULT_WORKFLOW, isWorkflow, resolveWorkflow, updateWorkflowPrompt, WORKFLOWS, writeWorkflow, type DevelopmentWorkflow, type WorkflowResolution } from "../lib/workflow-config.ts";
import { cmd, cmdSlash } from "../lib/brand.ts";

const SUMMARY: Record<DevelopmentWorkflow, string> = {
	none: "Direct/adaptive execution. Best for fixes and small isolated changes.",
	sdd: "Spec → Design → Tasks → Execute. Optimizes for planning and delegation.",
	svsd: "Spec → Backlog → Story → Pair. Optimizes for feedback and progressive discovery.",
};

export default function nubiaWorkflow(pi: ExtensionAPI): void {
	const env = process.env;
	const isChild = readEnv(env, "NUB_IA_AGENTS_CHILD") === "1";
	let current: WorkflowResolution = { workflow: DEFAULT_WORKFLOW, source: "default" };

	pi.on("session_start", (_event, ctx) => { current = resolveWorkflow({ env, cwd: ctx.cwd }); });
	pi.on("session_shutdown", () => { current = { workflow: DEFAULT_WORKFLOW, source: "default" }; });
	pi.on("before_agent_start", (event) => {
		if (!isChild) updateWorkflowPrompt(event.systemPromptOptions, current.workflow);
		return undefined;
	});

	pi.registerCommand(cmd("workflow"), {
		description: "Show or set the Development Workflow: none | sdd | svsd | status | default <workflow> (saves it). No argument opens a menu. Not a permission mode.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			let action = tokens[0] ?? "";
			if (action === "" && ctx.hasUI && typeof ctx.ui.select === "function") {
				const options = WORKFLOWS.map((workflow) => `${workflow}${workflow === current.workflow ? " (current)" : ""} - ${SUMMARY[workflow]}`);
				const selected = await ctx.ui.select(`Development Workflow (current: ${current.workflow})`, [...options, "status"]);
				if (!selected) return;
				action = selected.split(/[ ]/)[0]!;
			}
			if (action === "" || action === "status") {
				ctx.ui.notify([
					`Development Workflow: ${current.workflow} (${current.source})`,
					...WORKFLOWS.map((workflow) => `${workflow === current.workflow ? "●" : "○"} ${workflow}: ${SUMMARY[workflow]}`),
					`${cmdSlash("workflow")} <workflow> sets it for this session; ${cmdSlash("workflow")} default <workflow> saves it in ${nubIaConfigHome(env)}. A repo may pin one in .pi/nub-ia/workflow.json.`,
				].join("\n"), "info");
				return;
			}
			if (action === "default") {
				const wanted = tokens[1];
				if (!isWorkflow(wanted)) { ctx.ui.notify(`Use ${cmdSlash("workflow")} default none|sdd|svsd.`, "warning"); return; }
				try {
					const path = writeWorkflow(wanted);
					ctx.ui.notify(`Default workflow saved: ${wanted} (${path}). A repo file or NUB_IA_WORKFLOW still takes precedence; current session unchanged.`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not save the default workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (!isWorkflow(action)) { ctx.ui.notify(`Unknown workflow "${action}". Use none, sdd, svsd, status, or default <workflow>.`, "warning"); return; }
			current = { workflow: action, source: "session" };
			ctx.ui.notify(`Development Workflow: ${action} for this session. Applies from the next turn.`, "info");
		},
	});
}
