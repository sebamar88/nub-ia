import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { imageFallback, visibleWidth } from "@earendil-works/pi-tui";
import { cardBody } from "./gentle-card-text.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import piPretty from "../extensions/pi-pretty.ts";
import productionQuietTools, {
	createQuietToolRenderer,
	countNonEmptyLines,
	extractTextContent,
	formatToolResultOutput,
	tailLines,
} from "../extensions/quiet-tools.ts";

const passthroughTheme = {
	bold(value: string) {
		return value;
	},
	fg(_color: string, value: string) {
		return value;
	},
};

initTheme("dark");

const statusTheme = {
	bold(value: string) {
		return value;
	},
	fg(color: string, value: string) {
		return `<${color}>${value}</${color}>`;
	},
};

function routineRenderContext(overrides: Record<string, unknown> = {}) {
	return {
		args: {},
		toolCallId: "tool-call",
		invalidate() {},
		lastComponent: undefined,
		cwd: "/repo",
		executionStarted: false,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

// Content assertions read the quiet tool card content: the top rule becomes its
// call text (glyph, fill, and hint dropped), sides are stripped, and the closing
// rule is dropped. Gentle AI cards keep their raw frame for the card-text
// helpers, and the quiet card tests assert the raw frame via frameLines.
// Legacy bash argument assertions drop its new identity prefix here; distinct
// tool identity is asserted separately against the actual unmodified frame.
// A pending call's `running…` row is frame chrome too, asserted separately.
const TAG = "(?:</?[a-zA-Z]+>)*";
const CARD_TOP = new RegExp(`^${TAG}╭─ ${TAG}[∞≡$⌕⌖☷✎+]${TAG} (.*?) ${TAG}─+${TAG}(?: .*? )?${TAG}╮${TAG}$`);
const CARD_SIDE = new RegExp(`^${TAG}│${TAG} (.*) ${TAG}│${TAG}$`);
const CARD_BOTTOM = new RegExp(`^${TAG}╰${TAG}─*${TAG}╯${TAG}$`);

function frameLines(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width).map((line) => line.trimEnd());
}

const QUIET_CARD_COMPONENTS = new Set(["ToolCardTop", "ToolCardBody"]);

function renderLines(component: { render(width: number): string[] }, width = 120): string[] {
	if (!QUIET_CARD_COMPONENTS.has(component.constructor.name)) return component.render(width).map((line) => line.trimEnd());
	const call = component.constructor.name === "ToolCardTop";
	return component.render(width).flatMap((line) => {
		if (CARD_BOTTOM.test(line)) return [];
		const top = CARD_TOP.exec(line);
		if (top) return [top[1]!.replace(/^(?:<[^>]+>)*bash(?:<[^>]+>)* /, "").trimEnd()];
		const side = CARD_SIDE.exec(line);
		const text = (side ? side[1]! : line).trimEnd();
		return call && side && text.replace(/<\/?[a-zA-Z]+>/g, "") === "running…" ? [] : [text];
	});
}

function renderToString(component: { render(width: number): string[] }, width = 120): string {
	return renderLines(component, width).join("\n");
}

function textResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function createPi(options: { throwOnToolConflict?: boolean } = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, any[]>();
	return {
		tools,
		hooks,
		pi: {
			registerTool(tool: any) {
				if (options.throwOnToolConflict && tools.has(tool.name)) {
					throw new Error(`Tool ${tool.name} already registered`);
				}
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			on(name: string, handler: any) {
				hooks.set(name, [...(hooks.get(name) ?? []), handler]);
			},
		},
	};
}

function createSdkTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {} },
		execute: async () => textResult(`${name} result`),
	};
}

const fakePiPrettyDeps = {
	sdk: {
		createReadTool: () => createSdkTool("read"),
		createBashTool: () => createSdkTool("bash"),
		createLsTool: () => createSdkTool("ls"),
		createFindTool: () => createSdkTool("find"),
		createGrepTool: () => createSdkTool("grep"),
	},
};

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
	const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(updates)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function withEnvAsync<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(updates)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// Standalone rendering-only fixture for historical Bash formatting contracts.
// No executor, shellPath, or claim of production native-Bash UI parity.
function quietTools(pi: any) {
	productionQuietTools(pi);
	if (process.env.GENTLE_PI_QUIET_TOOLS !== "0") {
		pi.registerTool({ name: "bash", ...createQuietToolRenderer("bash") });
	}
}

function registeredQuietTools() {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	return tools;
}

function renderToolResult(tool: any, result: any, options: any, context: Record<string, unknown> = {}): string {
	return renderToString(tool.renderResult(result, options, passthroughTheme, context));
}

test("quiet tools register six overrides and codemode, never Bash", () => {
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => {
		const { pi, tools } = createPi();

		productionQuietTools(pi as any);

		assert.equal(tools.has("bash"), false);
		for (const toolName of ["read", "grep", "find", "ls", "edit", "write", "codemode"]) {
			const tool = tools.get(toolName);
			assert.ok(tool, `missing quiet renderer for ${toolName}`);
			assert.equal(tool.renderShell, "self", `${toolName} must opt out of Pi's painted Box`);
			assert.equal(typeof tool.execute, "function", `${toolName} must delegate execution`);
			assert.ok(tool.parameters, `${toolName} must preserve built-in parameters`);
		}
	});
});

test("quiet tools never replace an existing native Bash tool", () => {
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => {
		const { pi, tools } = createPi({ throwOnToolConflict: true });
		const native = createSdkTool("bash");
		pi.registerTool(native);
		productionQuietTools(pi as any);
		assert.strictEqual(tools.get("bash"), native);
	});
});

// Actual configured Bash execution is covered in quiet-bash-runtime.test.ts.

test("standalone Bash rendering fixture does not interpret shellPath", () => {
	const tool = registeredQuietTools().get("bash");
	const render = (context: Record<string, unknown> = {}) => renderToString(tool.renderCall({ command: "printf output" }, passthroughTheme, routineRenderContext(context)));
	const configured = render({ shellPath: "/configured/bash" });
	assert.equal(configured, render());
	assert.doesNotMatch(configured, /shellPath|configured\/bash/);
});

test("quiet tool rendering can be disabled by env", () => {
	withEnv({ GENTLE_PI_QUIET_TOOLS: "0" }, () => {
		const { pi, tools } = createPi();

		productionQuietTools(pi as any);

		assert.equal(tools.size, 0);
	});
});

test("pi-pretty suppresses overlapping tools before quiet tools register", async () => {
	await withEnvAsync(
		{ GENTLE_PI_QUIET_TOOLS: undefined, PRETTY_DISABLE_TOOLS: "multi_grep" },
		async () => {
			const { pi, tools } = createPi({ throwOnToolConflict: true });

			await piPretty(pi as any, fakePiPrettyDeps as any);
			productionQuietTools(pi as any);

			assert.equal(tools.has("bash"), false);
			for (const toolName of ["read", "grep", "find", "ls", "edit", "write"]) {
				assert.ok(tools.has(toolName), `missing quiet tool ${toolName}`);
			}
			assert.equal(process.env.PRETTY_DISABLE_TOOLS, "multi_grep,read,bash,ls,find,grep");
		},
	);
});

test("pi-pretty preserves byte-exact model-visible read results when quiet tools suppress its renderer", async () => {
	await withEnvAsync(
		{ GENTLE_PI_QUIET_TOOLS: undefined, PRETTY_DISABLE_TOOLS: undefined },
		async () => {
			const { pi, hooks } = createPi();
			await piPretty(pi as any, fakePiPrettyDeps as any);

			const original = "[alpha]\ntarget=old\n\n[beta]\ntarget=old\n";
			let event: any = {
				toolName: "read",
				content: [{ type: "text", text: original }],
			};
			for (const handler of hooks.get("tool_result") ?? []) {
				const replacement = await handler(event, {});
				if (replacement) event = { ...event, ...replacement };
			}

			assert.equal(event.content[0]?.text, original);
		},
	);
});

test("pi-pretty suppression is skipped when quiet tools are disabled", async () => {
	await withEnvAsync(
		{
			GENTLE_PI_QUIET_TOOLS: "0",
			PRETTY_DISABLE_TOOLS: undefined,
			PRETTY_ENABLE_TOOLS: "ls",
		},
		async () => {
			const { pi, tools } = createPi();

			await piPretty(pi as any, fakePiPrettyDeps as any);
			quietTools(pi as any);

			for (const toolName of ["read", "bash", "grep", "find", "ls"]) {
				assert.ok(tools.has(toolName), `pi-pretty should keep ${toolName} when quiet tools are disabled`);
			}
			assert.equal(process.env.PRETTY_DISABLE_TOOLS, undefined);
		},
	);
});

test("quiet tool rendering uses bounded previews while preserving search summaries", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));

	const read = renderToString(
		tools.get("read").renderResult(textResult("first line\nsecond line"), { expanded: false, isPartial: false }, passthroughTheme, {}),
	);
	const bash = renderToString(
		tools.get("bash").renderResult(textResult("stdout line\nstderr line"), { expanded: false, isPartial: false }, passthroughTheme, { args: { command: "printf output" } }),
	);
	assert.match(read, /first line\nsecond line/);
	assert.match(bash, /stdout line\nstderr line/);
	// The expand key rides the call card's top rule, never the result body.
	const configuredHint = keyHint("app.tools.expand", "to expand");
	assert.ok(!read.includes(configuredHint));
	assert.ok(!bash.includes(configuredHint));

	for (const [tool, text, label] of [
		["grep", "src/a.ts:1:match\nsrc/b.ts:2:match", "2 matches"],
		["find", "src/a.ts\nsrc/b.ts", "2 files"],
		["ls", "file-a.ts\nfile-b.ts", "2 entries"],
	] as const) {
		const collapsed = renderToString(
			tools.get(tool).renderResult(textResult(text), { expanded: false, isPartial: false }, passthroughTheme, {}),
		);
		const expanded = renderToString(
			tools.get(tool).renderResult(textResult(text), { expanded: true, isPartial: false }, passthroughTheme, {}),
		);
		assert.match(collapsed, new RegExp(label));
		assert.match(collapsed, /src\/a\.ts|file-a\.ts/);
		assert.match(expanded, new RegExp(text.split("\n")[1]!));
	}
});

test("quiet tool rendering keeps compact collapsed summaries for search and listing tools", () => {
	assert.equal(countNonEmptyLines("a\n\n b \n"), 2);
	assert.equal(extractTextContent(textResult("alpha\nbeta") as any), "alpha\nbeta");
	assert.equal(formatToolResultOutput("grep", textResult("a\nb\n") as any, { expanded: false }), " → 2 matches");
	assert.equal(formatToolResultOutput("find", textResult("a\nb\n") as any, { expanded: false }), " → 2 files");
	assert.equal(formatToolResultOutput("ls", textResult("a\nb\n") as any, { expanded: false }), " → 2 entries");
	assert.equal(formatToolResultOutput("grep", textResult("No matches found") as any, { expanded: false }), "");
	assert.equal(formatToolResultOutput("find", textResult("No files found matching pattern") as any, { expanded: false }), "");
	assert.equal(formatToolResultOutput("ls", textResult("Directory is empty") as any, { expanded: false }), "");
	assert.equal(formatToolResultOutput("read", textResult("a\nb\n") as any, { expanded: false }), "\na\nb");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false }), "\na\nb");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false, args: { command: "git diff" } }), "\na\nb\n");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false, args: { command: "git -C repo status" } }), "\na\nb\n");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false, args: { command: "echo git diff" } }), "\na\nb");
	assert.equal(formatToolResultOutput("edit", textResult("updated") as any, { expanded: false }), "\n✓ applied");
	assert.equal(formatToolResultOutput("write", textResult("wrote") as any, { expanded: false }), "\n✓ written");
	assert.equal(formatToolResultOutput("grep", textResult("a\nb\n") as any, { expanded: true }), "\na\nb\n");
	assert.equal(formatToolResultOutput("read", textResult("ENOENT: missing file") as any, { expanded: false, isError: true }), "\nENOENT: missing file");
});

test("quiet search and placeholder summaries preserve exact-result behavior", async (t) => {
	const grepRows = [["one", 12, "first"], ["two", 20, "second"], ["three", 28, "third"], ["four", 36, "fourth"], ["five", 44, "fifth"]] as const;
	const contextText = grepRows.flatMap(([file, line, ordinal]) => [
		`src/${file}.ts:${line}: ${ordinal} match`,
		`src/${file}.ts-${line - 1}- context before`,
		`src/${file}.ts-${line + 1}- context after`,
	]).join("\n");
	assert.deepEqual([grepRows.length, contextText.split("\n").length, contextText.split("\n").filter((line) => /:\d+:/.test(line)).length, contextText.split("\n").filter((line) => /-\d+-/.test(line)).length], [5, 15, 5, 10]);

	const lsCollisionText = "(empty directory)\nreal-entry.txt";
	const bashCollisionText = "(no output)\nreal output";
	const tools = registeredQuietTools();
	const hint = keyHint("app.tools.expand", "to expand");
	const cases = [
		["grep", "context rows count only match rows", "grep", contextText, { context: 1 }, " → 5 matches", undefined, /5 matches[\s\S]*first match/, /15 matches/, 1],
		["grep", "no-context output counts every non-empty row", "grep", "src/a.ts:1:match\nsrc/b.ts:2:match", {}, " → 2 matches", undefined, /2 matches/, undefined, 1],
		["exact", "current empty-directory marker", "ls", "(empty directory)", {}, "", undefined, /^$/, /entries|to expand/, 0],
		["exact", "legacy empty-directory marker", "ls", "Directory is empty", {}, "", undefined, /^$/, /entries|to expand/, 0],
		["exact", "no-output marker", "bash", "(no output)", { command: "true" }, "\n(no output)", undefined, /^\(no output\)$/, /to expand/, 0],
		["collision", "empty-directory marker with a real entry", "ls", lsCollisionText, {}, " → 2 entries", `\n${lsCollisionText}`, /2 entries[\s\S]*real-entry\.txt/, undefined, 1],
		["collision", "no-output marker with real output", "bash", bashCollisionText, { command: "printf output" }, `\n${bashCollisionText}`, `\n${bashCollisionText}`, /\(no output\)\nreal output/, undefined, 1],
	] as const;
	assert.equal(cases.length, 7);

	const assertSummaryCase = (current: (typeof cases)[number]) => {
		const [, name, toolName, text, args, collapsed, expanded, rendered, forbidden] = current;
		const result = textResult(text) as any;
		const tool = tools.get(toolName);
		assert.ok(tool, `${name}: missing ${toolName} renderer`);
		assert.equal(formatToolResultOutput(toolName, result, { expanded: false, args }), collapsed, name);
		if (expanded !== undefined) assert.equal(formatToolResultOutput(toolName, result, { expanded: true, args }), expanded, `${name} expanded output`);
		const output = renderToolResult(tool, result, { expanded: false, isPartial: false }, { args });
		assert.match(output, rendered, name);
		if (forbidden) assert.doesNotMatch(output, forbidden, name);
		assert.equal(output.split(hint).length - 1, 0, `${name}: the expand key rides the call card, not the result`);
	};

	for (const [section, count] of [["grep", 2], ["exact", 3], ["collision", 2]] as const) await t.test(section, () => {
		const selected = cases.filter(([currentSection]) => currentSection === section);
		assert.equal(selected.length, count, `${section}: case count`);
		for (const current of selected) assertSummaryCase(current);
	});
});

test("quiet Bash errors preserve meaningful rows for both public output orderings", () => {
	const tool = registeredQuietTools().get("bash");
	const hint = keyHint("app.tools.expand", "to expand");
	const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const cases = [
		["Pi session event", [
			["    B3 stdout before failure", []],
			["    B3 stderr detail that should require expansion", ["    ", "    "]],
			["    Command exited with code 7", []],
		]],
		["registered execution probe", [
			["probe stdout before failure", ["", ""]],
			["probe stderr detail \x1b[31mwith terminal color\x1b[0m", ["", ""]],
			["probe exit status: 7", []],
		]],
	] as const;
	assert.equal(cases.length, 2);
	const args = { command: "false" };
	const renderResult = (result: any, expanded: boolean) => tool.renderResult(result, { expanded, isPartial: false, isError: true }, passthroughTheme, { args, isError: true });

	for (const [name, rows] of cases) {
		assert.equal(rows.length, 3, `${name}: three meaningful source rows`);
		const text = rows.flatMap(([row, gaps]) => [row, ...gaps]).join("\n");
		const previewRows = rows.map(([row]) => stripAnsi(row));
		assert.ok(previewRows.every((row) => row.trim().length > 0), `${name}: preview rows are meaningful`);
		const expandedText = stripAnsi(text);
		const renderedExpandedText = expandedText.split("\n").map((line) => line.trimEnd()).join("\n");
		const result = textResult(text) as any;
		assert.equal(formatToolResultOutput("bash", result, { expanded: false, isError: true, args }), `\n${previewRows.join("\n")}`, name);
		assert.equal(formatToolResultOutput("bash", result, { expanded: true, isError: true, args }), `\n${expandedText}`, `${name} expanded output`);

		const collapsedLines = renderLines(renderResult(result, false), 120);
		assert.ok(collapsedLines.length <= 4, `${name}: expected at most 4 visual rows, got ${collapsedLines.length}`);
		assert.deepEqual(collapsedLines.slice(0, 3), previewRows, `${name}: preview rows`);
		assert.equal(collapsedLines.filter((line) => line.trim().length === 0).length, 0, `${name}: no blank preview rows`);
		assert.equal(collapsedLines.filter((line) => line.includes(hint)).length, 0, `${name}: the expand key rides the call card`);
		const expanded = renderToString(renderResult(result, true), 1000);
		assert.equal(expanded, renderedExpandedText, `${name}: complete expanded sanitized text`);
		assert.doesNotMatch(expanded, /\x1b\[/, `${name}: expanded output is ANSI-free`);
	}
});

test("quiet Bash normalizes compact JSON for bounded previews while keeping expanded text complete", () => {
	const compactJson = JSON.stringify({
		schema: "review",
		contract: "compact",
		nested: { longTail: "this must stay out of the collapsed preview", deeper: { value: true } },
	});
	const result = textResult(compactJson) as any;
	const commandArgs = { command: "printf json" };
	const previewRows = [
		'  "schema": "review",',
		'  "contract": "compact",',
		'  "nested": {',
	];
	const expectedPreview = `\n${previewRows.join("\n")}`;
	const tool = registeredQuietTools().get("bash");

	assert.equal(formatToolResultOutput("bash", result, { expanded: false, args: commandArgs }), expectedPreview);
	assert.equal(formatToolResultOutput("bash", result, { expanded: true, args: commandArgs }), `\n${compactJson}`);

	const collapsedLines = renderLines(tool.renderResult(result, { expanded: false, isPartial: false }, passthroughTheme, { args: commandArgs }), 120);
	const collapsed = collapsedLines.join("\n");
	assert.equal(previewRows.length, 3);
	assert.ok(collapsedLines.length <= 4, `expected at most 4 visual rows, got ${collapsedLines.length}`);
	assert.deepEqual(collapsedLines.slice(0, 3), previewRows);
	assert.equal(collapsedLines.filter((line) => line.includes(keyHint("app.tools.expand", "to expand"))).length, 0);
	assert.doesNotMatch(collapsed, /longTail|this must stay out of the collapsed preview|deeper/);

	const expanded = renderToString(tool.renderResult(result, { expanded: true, isPartial: false }, passthroughTheme, { args: commandArgs }), 1000);
	assert.equal(expanded, compactJson);
});

test("quiet Bash previews semantic lines for generic JSON output", () => {
	const tools = registeredQuietTools();
	const tool = tools.get("bash");
	const command = "gentle-ai review capabilities --contract gentle-ai.review-integration/v2 | python3 -m json.tool";
	const json = (value: unknown) => JSON.stringify(value, null, 2);
	const object = json({ schema: "gentle-ai.review-integration/v2", contract: "review", protocol: { version: 2 }, payload: { items: [{ value: true }] } });
	const error = json({ error: "failed", payload: { items: [{ code: 1 }] } });
	const cases = [
		[object, '  "schema": "gentle-ai.review-integration/v2",\n  "contract": "review",\n  "protocol": {'],
		[json(["alpha", "beta", { entry: true }]), '  "alpha",\n  "beta",\n    "entry": true'],
		['{\n  "schema": "broken",\n  "contract": "partial",\n  "payload": [\n    "value"\n  ]', '  "payload": [\n    "value"\n  ]'],
	] as const;
	for (const [text, expected] of cases) {
		assert.equal(formatToolResultOutput("bash", textResult(text) as any, { expanded: false, args: { command } }), `\n${expected}`);
	}
	assert.equal(formatToolResultOutput("bash", textResult(error) as any, { expanded: false, isError: true, args: { command } }), `\n${tailLines(error, 3)}`);
	const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
	const collapsed = renderToolResult(tool, textResult(object), { expanded: false, isPartial: false }, { args: { command } });
	const expanded = renderToolResult(tool, textResult(object), { expanded: true, isPartial: false }, { args: { command } });
	assert.equal(call.trimEnd(), `$ ${command}`);
	assert.doesNotMatch(call, /🌹/);
	assert.doesNotMatch(collapsed, /^\n\s*[}\]]/);
	const expandHint = keyHint("app.tools.expand", "to expand");
	assert.equal(collapsed.split(expandHint).length - 1, 0);
	assert.equal(expanded, object);
	assert.doesNotMatch(expanded, /to expand/);
});

test("quiet tool rendering keeps collapsed git bash result tails", () => {
	const text = Array.from({ length: 12 }, (_, index) => `git line ${index + 1}`).join("\n");

	assert.equal(formatToolResultOutput("bash", textResult(text) as any, { expanded: false, args: { command: "git diff" } }), `\n${tailLines(text, 10)}`);
	assert.equal(formatToolResultOutput("bash", textResult(text) as any, { expanded: false, args: { command: "git status --short" } }), `\n${tailLines(text, 10)}`);
});

test("quiet tool rendering keeps concise collapsed edit and write summaries", () => {
	const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

	assert.equal(tailLines(text, 10), Array.from({ length: 10 }, (_, index) => `line ${index + 3}`).join("\n"));
	assert.equal(formatToolResultOutput("edit", textResult(text, { diff: "@@\n-old\n+new" }) as any, { expanded: false }), "\n✓ +1 / -1");
	assert.equal(formatToolResultOutput("write", textResult("Successfully wrote 12 bytes\n" + text) as any, { expanded: false }), "\n✓ wrote 12 bytes");
});

test("quiet tool rendering sanitizes collapsed output and call rows", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));

	const collapsed = renderToString(
		tools.get("bash").renderResult(textResult("safe\x1b[31mred\x1b[0m"), { expanded: false, isPartial: false }, passthroughTheme, { args: { command: "printf output" } }),
	);
	const call = renderToString(tools.get("bash").renderCall({ command: "echo \x1b[31mred\x1b[0m" }, passthroughTheme, {}));

	const carriageReturn = renderToolResult(tools.get("bash"), textResult("prefix\rSECRET\r\nnext"), { expanded: false, isPartial: false }, { args: { command: "printf output" } });
	assert.match(collapsed, /safered/);
	assert.doesNotMatch(cardBody(collapsed), /\x1b\[31m|\x1b\[0m/);
	assert.equal(call.trimEnd(), "$ echo red");
	assert.match(carriageReturn, /prefixSECRET\nnext/);
	assert.doesNotMatch(carriageReturn, /\r/);
});

test("quiet tool rendering sanitizes only rendered fields", () => {
	let argsReads = 0, detailReads = 0;
	const counted = (record: Record<string, unknown>, increment: () => void) => Object.defineProperties(record, Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`unused${index}`, { enumerable: true, get() { increment(); return "ignored"; } }])));
	const args = counted({ command: "printf output" }, () => argsReads++);
	const details = counted({}, () => detailReads++);
	renderToolResult(registeredQuietTools().get("bash"), textResult("first\nsecond", details), { expanded: false, isPartial: false }, { args });
	assert.equal(argsReads, 0);
	assert.equal(detailReads, 0);
});

test("quiet tool rendering call rows show tool calls without result output", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));

	const readCall = renderToString(tools.get("read").renderCall({ path: "/tmp/example.ts", offset: 2, limit: 3 }, passthroughTheme, {}));
	const bashCall = renderToString(tools.get("bash").renderCall({ command: "printf noisy", timeout: 5 }, passthroughTheme, {}));
	const grepCall = renderToString(tools.get("grep").renderCall({ pattern: "needle", path: "src", glob: "*.ts" }, passthroughTheme, {}));

	assert.match(readCall, /read .*example\.ts:2-4/);
	assert.match(bashCall, /\$ printf noisy \(timeout 5s\)/);
	assert.match(grepCall, /grep \/needle\/ in src \(\*\.ts\)/);
    });

test("quiet tool rendering limits collapsed visual rows at the actual width", () => {
	const tools = registeredQuietTools();
	const bash = tools.get("bash");
	const hint = keyHint("app.tools.expand", "to expand");
	// Twelve content columns inside the four-column card sides.
	const narrowWidth = 16;
	const cases = [
		// Preview rows plus the closing rule; a partial result adds its label row.
		[textResult("x".repeat(80)), { expanded: false, isPartial: true }, { args: { command: "printf output" } }, 5],
		[textResult("界".repeat(40)), { expanded: false, isPartial: false }, { args: { command: "printf output" } }, 4],
		[textResult("e\u0301".repeat(40)), { expanded: false, isPartial: false, isError: true }, { args: { command: "false" }, isError: true }, 4],
	] as const;
	for (const [result, options, context, maxRows] of cases) {
		const lines = frameLines(bash.renderResult(result, options, passthroughTheme, context), narrowWidth);
		assert.ok(lines.length <= maxRows, `expected at most ${maxRows} rows, got ${lines.length}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= narrowWidth));
	}
	const completed = frameLines(bash.renderResult(textResult("😀".repeat(40)), { expanded: false, isPartial: false }, passthroughTheme, { args: { command: "printf output" } }), narrowWidth);
	assert.equal(completed.filter((line) => line.includes(hint)).length, 0);
	assert.ok(completed.every((line) => visibleWidth(line) <= narrowWidth));
});

test("quiet tool rendering bounds and sanitizes partial text without a completion hint", () => {
	const tool = registeredQuietTools().get("bash");
	const result = textResult("first\nsecond\nthird\nfourth");
	const collapsed = renderToolResult(tool, result, { expanded: false, isPartial: true }, { args: { command: "printf output" } });
	const expanded = renderToolResult(tool, result, { expanded: true, isPartial: true }, { args: { command: "printf output" } });

	assert.match(collapsed, /… bash · 4 lines/);
	assert.doesNotMatch(collapsed, /first/);
	assert.match(collapsed, /second\nthird\nfourth/);
	assert.doesNotMatch(collapsed, /to expand|Ctrl\+O/);
	assert.match(expanded, /first\nsecond\nthird\nfourth/);
	assert.doesNotMatch(expanded, /to expand|Ctrl\+O/);
	assert.match(renderToolResult(tool, textResult("first\n\nsecond\n\n"), { expanded: false, isPartial: true }, { args: { command: "printf output" } }), /… bash · 2 lines/);

	const sanitized = renderToolResult(tool, textResult("safe\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[2Jdone"), { expanded: true, isPartial: true }, { args: { command: "echo safe" } });
	assert.match(sanitized, /safedone/);
	assert.doesNotMatch(sanitized, /\x1b/);

	for (const [value, options] of [
		[textResult(""), { expanded: false, isPartial: true }],
		[{ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }, { expanded: true, isPartial: true }],
	] as const) {
		assert.equal(renderToolResult(tool, value, options, { args: { command: "true" } }).trimEnd(), "… bash");
	}
});

test("quiet tool rendering bounds completed previews, errors, and edit/write summaries", () => {
	const tools = registeredQuietTools();
	for (const [toolName, text, hidden, visible, context] of [
		["read", "read one\nread two\nread three\nread four", "read four", "read one\nread two\nread three", {}],
		["bash", "bash one\nbash two\nbash three\nbash four", "bash one", "bash two\nbash three\nbash four", { args: { command: "printf output" } }],
	] as const) {
		const rendered = renderToolResult(tools.get(toolName), textResult(text), { expanded: false, isPartial: false }, context);
		assert.doesNotMatch(rendered, new RegExp(hidden));
		assert.match(rendered, new RegExp(visible));
		assert.doesNotMatch(rendered, /to expand/);
	}

	for (const toolName of ["read", "bash", "grep", "find", "ls", "edit", "write"] as const) {
		const rendered = renderToolResult(tools.get(toolName), textResult("error one\nerror two\nerror three\nerror four"), { expanded: false, isPartial: false, isError: true }, { args: toolName === "bash" ? { command: "false" } : {} });
		assert.doesNotMatch(rendered, /error one/);
		assert.match(rendered, /error two\nerror three\nerror four/);
		assert.doesNotMatch(rendered, /to expand/);
	}

	const edit = renderToolResult(tools.get("edit"), textResult("Applied", { diff: "@@\n-old\n+new" }), { expanded: false, isPartial: false }, { args: { path: "file.ts", edits: [] } });
	const write = renderToolResult(tools.get("write"), textResult("Successfully wrote 4 bytes\nbody"), { expanded: false, isPartial: false }, { args: { path: "file.ts", content: "body" } });
	assert.match(edit, /\+1 \/ -1/);
	assert.match(edit, /-old[\s\S]*\+new/);
	assert.match(write, /wrote 4 bytes/);
	assert.doesNotMatch(write, /body/);
});

test("quiet tool rendering preserves complete expanded text and delegates sanitized image reads", () => {
	const tools = registeredQuietTools();
	const expanded = renderToolResult(tools.get("bash"), textResult("first\nsecond\nthird\nfourth\nsafe\x1b]52;c;Y2xpcGJvYXJk\x07done"), { expanded: true, isPartial: false }, { args: { command: "printf safe" } });
	assert.match(expanded, /first\nsecond\nthird\nfourth\nsafedone/);
	assert.doesNotMatch(expanded, /\x1b/);

	const edit = renderToolResult(tools.get("edit"), textResult("Applied", { diff: "@@\n-old\x1b]52;c;Y2xpcGJvYXJk\x07\n+new" }), { expanded: true, isPartial: false }, { args: { path: "file\x1b[2J.ts", edits: [{ oldText: "old\x1b[31m", newText: "new" }] } });
	assert.match(edit, /-old\n\+new/);
	assert.doesNotMatch(edit, /\x1b/);

	const image = renderToolResult(
		tools.get("read"),
		{ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], details: { path: "image\x1b[2J.png", note: "safe\x1b]2;title\x07" } },
		{ expanded: true, isPartial: false },
		{ args: { path: "image\x1b[2J.png", offset: 1, limit: 2 }, cwd: "/repo\x1b[2J", showImages: false, isError: false },
	);
	assert.ok(image.includes(imageFallback("image/png")));
	assert.doesNotMatch(image, /\x1b/);
});

test("quiet tool rendering preserves directional visual preview rows at narrow widths", () => {
	const tools = registeredQuietTools();
	const bash = tools.get("bash");
	const readTool = tools.get("read");
	// Twelve content columns inside the four-column card sides.
	const narrowWidth = 16;
	const renderCollapsed = (
		text: string,
		options: { expanded: false; isPartial: boolean; isError?: boolean },
		context: Record<string, unknown>,
	) => renderLines(bash.renderResult(textResult(text), options, passthroughTheme, context), narrowWidth);
	const renderRead = (text: string) => renderLines(
		readTool.renderResult(textResult(text), { expanded: false, isPartial: false }, passthroughTheme, {}),
		narrowWidth,
	);
	const oldText = "older wrapped text ".repeat(16);

	const partial = renderCollapsed(`${oldText}\nPARTIAL-NEW`, { expanded: false, isPartial: true }, { args: { command: "printf output" } });
	const growingPartial = renderCollapsed(`${oldText}GROW-SUFFIX`, { expanded: false, isPartial: true }, { args: { command: "printf output" } });
	const completedBash = renderCollapsed(`${oldText}\nBASH-NEW`, { expanded: false, isPartial: false }, { args: { command: "printf output" } });
	const error = renderCollapsed(`${oldText}\nERROR-NEW`, { expanded: false, isPartial: false, isError: true }, { args: { command: "false" }, isError: true });
	const git = renderCollapsed(`${oldText}\nGIT-NEW`, { expanded: false, isPartial: false }, { args: { command: "git diff" } });

	for (const [lines, marker] of [
		[partial, "PARTIAL-NEW"],
		[growingPartial, "GROW-SUFFIX"],
		[completedBash, "BASH-NEW"],
		[error, "ERROR-NEW"],
		[git, "GIT-NEW"],
	] as const) {
		assert.ok(lines.length <= 4, `expected fixed preview budget, got ${lines.length}`);
		assert.match(lines.join("\n"), new RegExp(marker));
	}
	assert.match(partial[0] ?? "", /… bash/);
	assert.doesNotMatch(completedBash.join("\n"), /to expand/);

	const read = renderRead(`READ-FIRST\n${oldText}\nREAD-NEW`);
	const semanticJson = renderCollapsed(
		JSON.stringify({ first: "x".repeat(80), newest: "JSON-NEW" }, null, 2),
		{ expanded: false, isPartial: false },
		{ args: { command: "printf output" } },
	);
	assert.match(read.join("\n"), /READ-FIRST/);
	assert.doesNotMatch(read.join("\n"), /READ-NEW/);
	assert.match(semanticJson.join("\n"), /first/);
	assert.doesNotMatch(semanticJson.join("\n"), /JSON-NEW/);
	assert.match(
		renderToolResult(bash, textResult(`${oldText}\nBASH-NEW`), { expanded: true, isPartial: false }, { args: { command: "printf output" } }),
		/BASH-NEW/,
	);
});

test("long finished quiet headings retain the applicable expansion hint and complete command", () => {
	const tool = registeredQuietTools().get("bash");
	const command = "printf alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
	const args = { command };
	for (const expanded of [false, true]) {
		const hint = keyHint("app.tools.expand", expanded ? "to collapse" : "to expand").replace(/\x1b\[[\d;]*m/g, "");
		const ctx = routineRenderContext({ args, executionStarted: true, isPartial: false, expanded });
		for (const width of [80, 120]) {
			const rows = frameLines(tool.renderCall(args, passthroughTheme, ctx), width);
			assert.ok(rows[0].endsWith(` ${hint} ╮`), `width ${width}: applicable hint must survive heading wrapping`);
			assert.ok(rows.length > 1);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			const first = rows[0].slice("╭─ $ ".length).split(" ─")[0];
			const rest = rows.slice(1).map((row) => row.replace(/^│ /, "").replace(/ +│$/, ""));
			assert.equal([first, ...rest].join(" ").replace(/\s+/g, " ").trim(), `bash $ ${command}`);
		}
	}
});

test("quiet components repaint after theme invalidation and retain transparent error frames", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.NEON);
	const bash = registeredQuietTools().get("bash");
	let paint = "\x1b[31m";
	const theme = { bold: (text: string) => text, fg: (_role: string, text: string) => `${paint}${text}\x1b[0m`, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	const args = { command: "printf failure" };
	const context = routineRenderContext({ args, isError: true, isPartial: false });
	const components = [bash.renderCall(args, theme, context), bash.renderResult(textResult("denied\nreason"), { expanded: false, isPartial: false }, theme, context)];
	const first = components.flatMap((component) => component.render(80)).join("\n");
	paint = "\x1b[35m";
	for (const component of components) component.invalidate();
	const changed = components.flatMap((component) => component.render(80)).join("\n");
	assert.match(first, /\x1b\[31m/);
	assert.doesNotMatch(changed, /\x1b\[31m|\x1b\[44m/);
	assert.match(changed, /\x1b\[35m/);
	assert.equal(first.replace(/\x1b\[[\d;]*m/g, ""), changed.replace(/\x1b\[[\d;]*m/g, ""));
});

test("six quiet cards and standalone Bash fixture retain distinct identity and bounded results", () => {
	const tools = registeredQuietTools();
	for (const [name, glyph] of [["read", "≡"], ["bash", "$"], ["grep", "⌕"], ["find", "⌖"], ["ls", "☷"], ["edit", "✎"], ["write", "+"]] as const) {
		const tool = tools.get(name);
		const args = { command: "printf hello", path: "src/example.ts", pattern: "needle" };
		const ctx = routineRenderContext({ args, isPartial: false, executionStarted: true });
		const header = frameLines(tool.renderCall(args, passthroughTheme, ctx), 120).join("\n");
		assert.ok(header.startsWith(`╭─ ${glyph} ${name} `), `${name} retains its distinct icon and actual identity`);
		assert.match(header, /to expand/);
		const value = textResult("useful row\nsecond row", name === "edit" ? { diff: "-before\n+after" } : undefined);
		const body = frameLines(tool.renderResult(value, { expanded: false, isPartial: false }, passthroughTheme, ctx), 120).join("\n");
		if (name !== "write") assert.match(body, name === "edit" ? /before|after/ : /useful row/);
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24]) {
			const rows = frameLines(tool.renderResult(textResult("界e\u0301🌹".repeat(80)), { expanded: false, isPartial: false }, passthroughTheme, ctx), width);
			assert.ok(rows.length <= 4);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.equal(rows.filter((row) => row.startsWith("╰")).length, width ? 1 : 0);
		}
	}
});

test("quiet tool calls draw a rounded petal card in the lifecycle tone", () => {
	const tools = registeredQuietTools();
	const bash = tools.get("bash");
	const args = { command: "printf output" };
	const width = 30;

	const header = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, isPartial: false })).render(width);
	assert.deepEqual(header, [`╭─ $ bash $ printf output ${"─".repeat(3)}╮`]);
	const running = bash.renderCall(args, statusTheme, routineRenderContext({ args, executionStarted: true, isPartial: true })).render(width);
	assert.match(running[0] ?? "", /^<warning>╭<\/warning><warning>─ <\/warning><warning>\$ (?:<toolTitle>)?bash/);
	assert.match(bash.renderCall(args, statusTheme, routineRenderContext({ args, isPartial: false, isError: true })).render(width)[0] ?? "", /^<error>╭<\/error>/);

	const expanded = bash.renderResult(textResult("alpha\nbeta"), { expanded: true, isPartial: false }, passthroughTheme, { args }).render(width);
	assert.deepEqual(expanded, [
		`│ alpha${" ".repeat(21)} │`,
		`│ beta${" ".repeat(22)} │`,
		`╰${"─".repeat(28)}╯`,
	]);
	const failed = bash.renderResult(textResult("boom"), { expanded: true, isPartial: false, isError: true }, statusTheme, { args, isError: true }).render(width);
	assert.match(failed.at(-1) ?? "", /^<error>╰<\/error><error>─+╯<\/error>$/);
	assert.ok(failed.slice(0, -1).every((line) => line.startsWith("<error>│</error> ")), failed.join("\n"));

	const empty = tools.get("grep").renderResult(textResult("No matches found"), { expanded: false, isPartial: false }, passthroughTheme, {}).render(width);
	assert.deepEqual(empty, [`╰${"─".repeat(28)}╯`], "an empty result still closes the card");

	// The expand key rides the top rule once the call finished, like the Gentle AI card.
	const wide = 80;
	const expandKey = keyHint("app.tools.expand", "to expand").replace(/\x1b\[[0-9;]*m/g, "");
	const finishedTop = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, executionStarted: true, isPartial: false })).render(wide)[0] ?? "";
	assert.ok(finishedTop.endsWith(` ${expandKey} ╮`), finishedTop);
	const expandedTop = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, executionStarted: true, isPartial: false, expanded: true })).render(wide)[0] ?? "";
	assert.match(expandedTop, /to collapse ╮$/);
	const runningTop = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, executionStarted: true, isPartial: true })).render(wide)[0] ?? "";
	assert.ok(!runningTop.includes("to expand"), runningTop);
	const collapsedBody = bash.renderResult(textResult("alpha\nbeta"), { expanded: false, isPartial: false }, passthroughTheme, { args }).render(wide);
	assert.ok(!collapsedBody.some((line) => line.includes("to expand")), "the body no longer carries the expand key");

	for (const narrow of [1, 2, 3, 4, 5, 8]) {
		const lines = [
			...bash.renderCall({ command: "printf " + "x".repeat(80) }, passthroughTheme, routineRenderContext({ args, isPartial: false })).render(narrow),
			...bash.renderResult(textResult("😀".repeat(40)), { expanded: true, isPartial: false }, passthroughTheme, { args }).render(narrow),
		];
		for (const line of lines) assert.ok(visibleWidth(line) <= narrow, `width ${narrow}: ${JSON.stringify(line)}`);
	}
});

// Pi builds the call component, then the result component once a result
// exists, and only then renders them; both share one row state.
function piToolRow(tool: any, args: Record<string, unknown>, value: unknown, context: Record<string, unknown>, width: number, theme: object = passthroughTheme): string[] {
	const call = tool.renderCall(args, theme, context);
	const body = value ? tool.renderResult(value, { expanded: context.expanded === true, isPartial: context.isPartial === true }, theme, context) : undefined;
	return [...call.render(width), ...(body?.render(width) ?? [])];
}

test("a running quiet card closes its own frame with one running row until a result exists", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const args = { path: "a.md" };
	const pending = () => routineRenderContext({ args, executionStarted: true, isPartial: true, state: {} });
	const running = piToolRow(read, args, undefined, pending(), 40);
	assert.deepEqual(running, [
		`╭─ ≡ read a.md ${"─".repeat(24)}╮`,
		`│ running…${" ".repeat(28)} │`,
		`╰${"─".repeat(38)}╯`,
	]);
	const painted = piToolRow(read, args, undefined, pending(), 40, statusTheme).join("\n");
	assert.match(painted, /<muted>running…<\/muted>/);
	assert.match(painted, /<warning>╰<\/warning>/);
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const rows = piToolRow(read, args, undefined, pending(), width);
		assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}`);
		// Narrow headings may continue on rows below the top rule; the frame still closes once.
		assert.equal(rows.filter((row) => row.startsWith("╰")).length, width === 0 ? 0 : 1);
		if (width > 0) assert.ok(rows.at(-1)!.startsWith("╰"), `width ${width}: ${rows.join("\n")}`);
	}

	// A partial result below the call closes the frame instead: one bottom rule, no running row.
	const bash = tools.get("bash");
	const bashArgs = { command: "printf output" };
	const partial = piToolRow(bash, bashArgs, textResult("out"), routineRenderContext({ args: bashArgs, executionStarted: true, isPartial: true, state: {} }), 40);
	assert.equal(partial.filter((row) => row.startsWith("╭")).length, 1);
	assert.equal(partial.filter((row) => row.startsWith("╰")).length, 1);
	assert.match(partial.at(-1)!, /^╰─+╯$/);
	assert.doesNotMatch(partial.join("\n"), /running…/);

	// A finished call keeps its open top rule; the result closes the card.
	const finished = piToolRow(read, args, textResult("one"), routineRenderContext({ args, executionStarted: true, isPartial: false, state: {} }), 40);
	assert.equal(finished.length, 3);
	assert.match(finished[0]!, /^╭─ ≡ read a\.md .*╮$/);
	assert.match(finished[1]!, /^│ one +│$/);
	assert.match(finished[2]!, /^╰─+╯$/);
});



// Float style: the call and result components of one quiet card read as one
// borderless panel. The heading owns the blank row above it; the result owns
// the separator below the heading and the blank closing row.
const floatToolTheme = {
	bold(value: string) {
		return value;
	},
	fg(_color: string, value: string) {
		return `\x1b[38;5;114m${value}\x1b[39m`;
	},
	bg(color: string, value: string) {
		return `\x1b[48;5;${color === "toolErrorBg" ? 52 : color === "toolPendingBg" ? 58 : 22}m${value}\x1b[49m`;
	},
};

function withFloatCards<T>(run: () => T): T {
	setCardStyle(CARD_STYLE.FLOAT);
	try {
		return run();
	} finally {
		setCardStyle(CARD_STYLE.NEON);
	}
}

test("float quiet cards render the call and result as one panel with a single separator", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const context = routineRenderContext({ args: { path: "package.json" }, isPartial: false, executionStarted: true });
	const width = 60;
	const rows = withFloatCards(() => [
		...read.renderCall({ path: "package.json" }, floatToolTheme, context).render(width),
		...read.renderResult(textResult("{\n  \"name\": \"gentle-pi\""), { expanded: false, isPartial: false }, floatToolTheme, context).render(width),
	]);
	const plain = rows.map(stripAnsi);
	for (const line of rows) {
		assert.equal(visibleWidth(line), width);
		assert.ok(line.startsWith(" \x1b[48;5;22m"), JSON.stringify(line));
		assert.ok(line.endsWith("\x1b[49m "), JSON.stringify(line));
	}
	assert.doesNotMatch(plain.join("\n"), /[╭╮╰╯│─]/);
	assert.match(plain[0]!, /^ ▎ +$/);
	assert.match(plain[1]!, /^ ▎ ≡ read package\.json +.*to expand {4}$/);
	assert.match(plain[2]!, /^ ▎ +$/);
	assert.match(plain[3]!, /^ ▎ \{ +$/);
	assert.match(plain[4]!, /^ ▎ {3}"name": "gentle-pi" +$/);
	assert.match(plain.at(-1)!, /^ ▎ +$/);
	assert.equal(plain.length, 6);
	assert.equal(plain[1]!.indexOf("≡"), plain[3]!.indexOf("{"), "the glyph starts in the body text column");
});

test("float quiet cards close a running call as one panel and add no separator without result rows", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const running = withFloatCards(() => read.renderCall({ path: "a.md" }, floatToolTheme, routineRenderContext({ args: { path: "a.md" }, state: {} })).render(40)).map(stripAnsi);
	assert.equal(running.length, 5, "blank row, heading, separator, running row, closing row");
	assert.match(running[0]!, /^ ▎ +$/);
	assert.match(running[1]!, /^ ▎ ≡ read a\.md +$/);
	assert.match(running[2]!, /^ ▎ +$/);
	assert.match(running[3]!, /^ ▎ running… +$/);
	assert.match(running[4]!, /^ ▎ +$/);
	assert.doesNotMatch(running.join("\n"), /[╭╮╰╯│─]/);
	const empty = withFloatCards(() => read.renderResult(textResult(""), { expanded: false, isPartial: false }, floatToolTheme, routineRenderContext({ isPartial: false })).render(40)).map(stripAnsi);
	assert.deepEqual(empty, [` ▎${" ".repeat(37)} `], "an empty result only closes the panel");
});

test("quiet cards stay outlined in the neon style with a background-capable theme", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const context = routineRenderContext({ args: { path: "a.md" }, isPartial: false, executionStarted: true });
	const rows = [
		...read.renderCall({ path: "a.md" }, floatToolTheme, context).render(40),
		...read.renderResult(textResult("one"), { expanded: false, isPartial: false }, floatToolTheme, context).render(40),
	].map(stripAnsi);
	assert.match(rows[0]!, /^╭─ ≡ read a\.md/);
	assert.match(rows.at(-1)!, /^╰─+╯$/);
	assert.doesNotMatch(rows.join("\n"), /▎/);
});
