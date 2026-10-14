#!/usr/bin/env node
// System-prompt benchmark (docs/nub-ia-overview.md): measures what the model
// receives at the first turn for plain pi, Nub-IA minimal and Nub-IA full,
// with clean homes so personal skills, AGENTS.md and sessions do not skew it.
//
//   node scripts/bench-prompt.mjs            # bytes per section, no model call
//   node scripts/bench-prompt.mjs --tokens   # also one real "reply ok" turn per
//                                            # configuration (uses the auth of
//                                            # ~/.nub-ia/agent; costs a few cents)
//
// A throwaway extension dumps event.systemPrompt and exits before any request;
// in --tokens mode `--mode json` is used instead and usage is read from the
// assistant message (with Bedrock/Anthropic caching, cacheWrite + input is the
// prompt size on a cold turn).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DUMP = `import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.on("before_agent_start", (event) => {
		writeFileSync(process.env.DUMP_TO, JSON.stringify({ systemPrompt: event.systemPrompt ?? "", appended: event.systemPromptOptions?.appendSystemPrompt ?? "" }));
		process.exit(0);
	});
}
`;

function sections(text) {
	const out = {};
	for (const tag of ["tools", "rules", "docs", "addendum", "skills", "cwd"]) {
		const match = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(text);
		out[tag] = match ? Buffer.byteLength(match[0]) : 0;
	}
	out.intro = Buffer.byteLength(text.split("<tools>")[0] ?? "");
	out.total = Buffer.byteLength(text);
	return out;
}

function run(command, args, env, timeout = 180_000) {
	return spawnSync(command, args, { encoding: "utf8", env, timeout, windowsHide: true });
}

export function bench({ tokens = false } = {}) {
	const work = mkdtempSync(join(tmpdir(), "nub-ia-bench-"));
	try {
		const agent = join(work, "agent");
		mkdirSync(agent);
		const sourceAgent = process.env.NUB_IA_AGENT_HOME || join(homedir(), ".nub-ia", "agent");
		for (const file of ["auth.json", "models-store.json"]) if (existsSync(join(sourceAgent, file))) cpSync(join(sourceAgent, file), join(agent, file));
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: process.env.BENCH_PROVIDER ?? "amazon-bedrock", defaultModel: process.env.BENCH_MODEL ?? "us.anthropic.claude-sonnet-5-5" }));
		const dumpExt = join(work, "dump.mjs");
		writeFileSync(dumpExt, DUMP);
		const cwd = join(work, "repo");
		mkdirSync(cwd);
		run("git", ["init", "-q", cwd], process.env);
		const base = { ...process.env, HOME: join(work, "home"), USERPROFILE: join(work, "home"), NUB_IA_CONFIG_HOME: join(work, "cfg"), NUB_IA_NO_AUTO_SETUP: "1", NUB_IA_METRICS: "off" };
		const configs = [
			{ name: "pi (sin extensiones)", command: "pi", args: ["--no-extensions"], env: { ...base, PI_CODING_AGENT_DIR: agent } },
			{ name: "nub-ia minimal", command: "node", args: [join(ROOT, "bin", "nub-ia.mjs"), "--home", agent, "--"], env: { ...base, NUB_IA_PROMPT_PROFILE: "minimal" } },
			{ name: "nub-ia full", command: "node", args: [join(ROOT, "bin", "nub-ia.mjs"), "--home", agent, "--"], env: { ...base, NUB_IA_PROMPT_PROFILE: "full" } },
		];
		const results = [];
		for (const config of configs) {
			const dumpTo = join(work, `${results.length}.json`);
			const result = run(config.command, [...config.args, "-e", dumpExt, "--no-session", "-p", "x"], { ...config.env, DUMP_TO: dumpTo }, 120_000);
			if (!existsSync(dumpTo)) { results.push({ name: config.name, error: (result.stderr || result.stdout || "no dump").trim().split("\n").slice(-2).join(" | ") }); continue; }
			const dump = JSON.parse(readFileSync(dumpTo, "utf8"));
			const row = { name: config.name, ...sections(dump.systemPrompt) };
			if (tokens) {
				const turn = run(config.command, [...config.args, "--no-session", "--mode", "json", "-p", "Reply with the single word ok"], config.env, 240_000);
				let usage;
				const toolNames = new Set();
				for (const line of (turn.stdout ?? "").split("\n")) {
					let event;
					try { event = JSON.parse(line); } catch { continue; }
					const walk = (node) => {
						if (!node || typeof node !== "object") return;
						if (node.usage && typeof node.usage.input === "number") usage = node.usage;
						if (typeof node.name === "string" && node.parameters && typeof node.parameters === "object") toolNames.add(node.name);
						for (const value of Object.values(node)) walk(value);
					};
					walk(event);
				}
				if (usage) { row.promptTokens = (usage.input ?? 0) + (usage.cacheWrite ?? 0) + (usage.cacheRead ?? 0); row.costUsd = usage.cost?.total; }
				row.toolCount = toolNames.size;
			}
			results.push(row);
		}
		return results;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const tokens = process.argv.includes("--tokens");
	const rows = bench({ tokens });
	const header = ["configuración", "total B", "intro", "tools", "rules", "docs", "addendum", "skills", ...(tokens ? ["prompt tokens", "herramientas", "USD turno frío"] : [])];
	console.log(header.join(" | "));
	for (const row of rows) {
		if (row.error) { console.log(`${row.name} | ERROR ${row.error}`); continue; }
		console.log([row.name, row.total, row.intro, row.tools, row.rules, row.docs, row.addendum, row.skills, ...(tokens ? [row.promptTokens ?? "?", row.toolCount ?? "?", row.costUsd?.toFixed(4) ?? "?"] : [])].join(" | "));
	}
}
