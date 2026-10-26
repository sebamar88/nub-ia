// Child of tests/brand-e2e.test.ts: loads the command-registering extensions from <root> with a stub
// ExtensionAPI and prints { commands, banner } as JSON. Brand comes from NUB_IA_BRAND_FILE.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const commands = [];
const handlers = new Map();
const noop = () => undefined;
const pi = new Proxy({
	events: { emit: noop, on: () => noop },
	on: (name, fn) => handlers.set(name, fn),
	registerCommand: (name) => commands.push(name),
	registerProvider: noop, registerFlag: noop, registerTool: noop, registerShortcut: noop, registerMessageRenderer: noop,
	getFlag: () => false, getCommands: () => [], getAllTools: () => [], getActiveTools: () => [], setActiveTools: noop,
}, { get: (target, key) => target[key] ?? noop });
const files = readdirSync(join(root, "extensions")).filter((f) => f.endsWith(".ts")).map((f) => `extensions/${f}`);
for (const rel of [...files, "extensions/history/index.ts"]) {
	const mod = await import(pathToFileURL(join(root, rel)).href);
	if (typeof mod.default === "function" && rel !== "extensions/startup-banner.ts") {
		try { await mod.default(pi); } catch (error) { console.error(`load ${rel}: ${error.message}`); }
	}
}

// Deterministic static frame, as in tests/startup-banner.test.ts (no timers, no animations).
process.argv = ["node"];
for (const [key, value] of [["rows", 40], ["columns", 200]]) Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
const realSetTimeout = globalThis.setTimeout;
let boot;
globalThis.setTimeout = (cb, ms) => { if (ms === 50) { boot = cb; return {}; } return realSetTimeout(cb, ms); };
const banner = (await import(pathToFileURL(join(root, "extensions/startup-banner.ts")).href)).default;
const bannerHandlers = new Map();
banner({ on: (name, fn) => bannerHandlers.set(name, fn), registerCommand: (name) => commands.push(name), getCommands: () => [], getAllTools: () => [] });
let header;
await bannerHandlers.get("session_start")({}, { hasUI: true, cwd: "/fixture", ui: { setHeader(factory) { header = factory({ requestRender() {} }, { fg: (_role, text) => text }); } } });
boot();
const out = header.render(120).join("\n");
header.dispose();
console.log(JSON.stringify({ commands: commands.sort(), banner: out }));
process.exit(0);
