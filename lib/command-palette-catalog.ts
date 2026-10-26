import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";
import { cmd, cmdSlash } from "./brand.ts";

// The curated command set for the command palette: an OpenCode-style
// grouped menu, not a raw listing of every registered extension command.
// Only command + label live here; the live description and any shortcut
// hint are attached at build time by buildCommandPaletteGroups, from the
// actual registration and the shell's configured shortcuts.

export interface CommandPaletteCatalogItem {
	command: string;
	label: string;
}

export interface CommandPaletteCatalogGroup {
	title: string;
	items: readonly CommandPaletteCatalogItem[];
}

export const COMMAND_PALETTE_CATALOG: readonly CommandPaletteCatalogGroup[] = [
	{
		title: "Configuration",
		items: [
			{ command: cmd("models"), label: "Assign models and effort" },
			{ command: cmd("profiles"), label: "Agent-model profiles" },
			{ command: cmd("persona"), label: "Switch persona" },
			{ command: cmd("workflow"), label: "Development workflow (none | sdd | svsd)" },
			{ command: cmd("review-mode"), label: "Push review gate (confirm | strict | off)" },
			{ command: cmd("background-subagents"), label: "Background subagents" },
			{ command: cmd("double-esc-cancel"), label: "Require double Esc to cancel" },
			{ command: cmd("customize"), label: "Visual customization" },
			{ command: cmd("animations"), label: "Animation mode" },
			{ command: cmd("vim"), label: "Vim opt-in · Pi slash commands" },
			{ command: cmd("banner"), label: "Startup banner" },
			{ command: cmd("banner-color"), label: "Banner color" },
			{ command: cmd("toggle-rose"), label: "Toggle banner isologo" },
			{ command: cmd("toggle-text-logo"), label: "Toggle banner text logo" },
		],
	},
	{
		title: "Session",
		items: [
			{ command: cmd("yolo"), label: "🚀 YOLO 🔥 session permission" },
			{ command: cmd("changes"), label: "Browse captured changes" },
			{ command: cmd("review"), label: "4R code review of the current diff" },
			{ command: cmd("grill"), label: `Grill me about a plan (alias ${cmdSlash("quiz")})` },
			{ command: cmd("agents"), label: "Subagents" },
			{ command: cmd("usage"), label: "Subscription usage" },
		],
	},
	{
		title: "Diagnostics",
		items: [
			{ command: cmd("status"), label: "Nub-IA status" },
			{ command: cmd("doctor"), label: "Doctor" },
		],
	},
	{
		title: "Skills",
		items: [{ command: "skill-registry:refresh", label: "Refresh skill registry" }],
	},
];

/**
 * Build the palette's groups for one session: keep only catalog entries
 * whose command is actually registered (so a missing extension never shows
 * a dead row), attach that registration's live description and an optional
 * shortcut hint, and drop any group left with no items. Catalog order is
 * preserved throughout.
 */
export function buildCommandPaletteGroups(registered: readonly { name: string; description?: string }[], shortcuts: Readonly<Record<string, string | undefined>>): CommandPaletteGroup[] {
	const byName = new Map(registered.map((command) => [command.name, command]));
	const groups: CommandPaletteGroup[] = [];
	for (const group of COMMAND_PALETTE_CATALOG) {
		const items: CommandPaletteItem[] = [];
		for (const entry of group.items) {
			const found = byName.get(entry.command);
			if (!found) continue;
			items.push({ command: entry.command, label: entry.label, description: found.description, shortcut: shortcuts[entry.command] });
		}
		if (items.length > 0) groups.push({ title: group.title, items });
	}
	return groups;
}
