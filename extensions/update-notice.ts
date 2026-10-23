import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readEnv } from "../lib/config-home.ts";
import { UPDATE_NOTICE_ENV } from "../scripts/update-check.mjs";

// Shows the launcher's "Update Available" box inside the TUI, shaped like
// pi's own new-version notice (warning border, bold title, update command,
// changelog link). bin/nub-ia.mjs computes the lines (scripts/update-check.mjs)
// and passes them as JSON in NUB_IA_UPDATE_NOTICE; inert without it, so plain
// `pi` and headless runs show nothing. The box sits above the editor until
// the first prompt is sent, then disappears.

export type UpdateNoticeLines = { title: string; instruction: string; command: string; changelog?: string };

const WIDGET_KEY = "nub-ia-update-notice";

// Process-wide, not per extension instance: /reload re-runs this factory after
// the env var was already claimed and must still know the notice.
const STATE_KEY = Symbol.for("nub-ia.update-notice");
type StateHolder = { [STATE_KEY]?: UpdateNoticeLines };

/** Parses the launcher's payload; anything malformed is ignored. */
export function parseUpdateNotice(raw: string | undefined): UpdateNoticeLines | undefined {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as Partial<UpdateNoticeLines>;
		if (typeof value?.title !== "string" || typeof value.instruction !== "string" || typeof value.command !== "string") return undefined;
		return { title: value.title, instruction: value.instruction, command: value.command, changelog: typeof value.changelog === "string" ? value.changelog : undefined };
	} catch {
		return undefined;
	}
}

function claimNotice(env: NodeJS.ProcessEnv): UpdateNoticeLines | undefined {
	const holder = globalThis as StateHolder;
	const notice = parseUpdateNotice(env[UPDATE_NOTICE_ENV]);
	// Claim for this process only: subagents and tool shells inherit process.env
	// and must not repeat the notice.
	delete env[UPDATE_NOTICE_ENV];
	if (holder[STATE_KEY] === undefined && notice) holder[STATE_KEY] = notice;
	return holder[STATE_KEY];
}

/** Test-only: forget the claimed notice. */
export function resetUpdateNoticeState(): void {
	delete (globalThis as StateHolder)[STATE_KEY];
}

type Theme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

/** The rendered box, one entry per terminal line. */
export function renderUpdateNoticeBox(lines: UpdateNoticeLines, theme: Theme, width: number): string[] {
	const rule = theme.fg("warning", "\u2500".repeat(Math.max(1, width)));
	const out = [
		rule,
		` ${theme.bold(theme.fg("warning", lines.title))}`,
		` ${theme.fg("muted", lines.instruction)}${theme.fg("accent", lines.command)}`,
	];
	if (lines.changelog) out.push(` ${theme.fg("muted", "Changelog: ")}${theme.fg("accent", lines.changelog)}`);
	out.push(rule, "");
	return out;
}

export default function updateNotice(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const notice = claimNotice(env);
	if (!notice) return;
	let dismissed = false;

	pi.on("session_start", (_event, ctx) => {
		if (dismissed || !ctx.hasUI) return;
		// Delegated rpc children report hasUI=true but have no terminal (nubia-shell#1690).
		if (readEnv(env, "NUB_IA_AGENTS_CHILD") === "1") return;
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			render: (width: number) => renderUpdateNoticeBox(notice, theme as Theme, width),
			invalidate() {},
		}));
	});

	// The box has done its job once the user starts working.
	pi.on("before_agent_start", (_event, ctx) => {
		if (dismissed) return;
		dismissed = true;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
