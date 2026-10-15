import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import updateNoticeExtension, { parseUpdateNotice, renderUpdateNoticeBox, resetUpdateNoticeState } from "../extensions/update-notice.ts";
import {
	UPDATE_CHECK_OPT_OUT_ENV,
	UPDATE_NOTICE_ENV,
	checkForUpdates,
	commitsBehindUpstream,
	fetchIsDue,
	formatUpdateNotice,
	githubWebUrl,
	renderUpdateNoticeText,
} from "../scripts/update-check.mjs";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A bare `origin` with one commit and a clone of it on main. */
function makeRepos(): { root: string; origin: string; dispose: () => void } {
	const base = mkdtempSync(join(tmpdir(), "nub-ia-update-check-"));
	const origin = join(base, "origin.git");
	const seed = join(base, "seed");
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
	execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
	git(seed, "config", "user.email", "t@example.com");
	git(seed, "config", "user.name", "t");
	writeFileSync(join(seed, "a.txt"), "1\n");
	writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
	git(seed, "add", "a.txt", "package.json");
	git(seed, "commit", "--quiet", "-m", "one");
	git(seed, "push", "--quiet", origin, "main");
	const root = join(base, "clone");
	execFileSync("git", ["clone", "--quiet", origin, root]);
	git(root, "config", "user.email", "t@example.com");
	git(root, "config", "user.name", "t");
	return { root, origin, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

function pushAnotherCommit(origin: string, n: number, version?: string) {
	const work = mkdtempSync(join(tmpdir(), "nub-ia-update-check-push-"));
	execFileSync("git", ["clone", "--quiet", origin, join(work, "w")]);
	const w = join(work, "w");
	git(w, "config", "user.email", "t@example.com");
	git(w, "config", "user.name", "t");
	for (let i = 0; i < n; i += 1) {
		writeFileSync(join(w, `f${i}.txt`), `${i}\n`);
		if (version && i === n - 1) writeFileSync(join(w, "package.json"), JSON.stringify({ name: "x", version }));
		git(w, "add", ".");
		git(w, "commit", "--quiet", "-m", `more ${i}`);
	}
	git(w, "push", "--quiet", "origin", "main");
	rmSync(work, { recursive: true, force: true });
}

test("formatUpdateNotice: silent at zero; released version → semver + release page; unreleased → count + compare", () => {
	assert.equal(formatUpdateNotice(undefined), undefined);
	assert.equal(formatUpdateNotice({ behind: 0, upstream: "origin/main", remoteSha: "abc1234" }), undefined);
	const base = { behind: 1, upstream: "origin/main", remoteSha: "abc1234", localVersion: "1.0.0", webUrl: "https://github.com/sebamar88/nub-ia", compareUrl: "https://github.com/sebamar88/nub-ia/compare/1111111...abc1234" };
	assert.deepEqual(formatUpdateNotice({ ...base, remoteVersion: "1.1.0" }), {
		title: "Update Available",
		instruction: "New version 1.1.0 is available (you have 1.0.0). Run ",
		command: "nub-ia update",
		changelog: "https://github.com/sebamar88/nub-ia/releases/tag/v1.1.0",
	});
	const unreleased = formatUpdateNotice({ ...base, remoteVersion: "1.0.0" });
	assert.deepEqual(unreleased, {
		title: "Update Available",
		instruction: "1 new commit on origin/main (abc1234) since v1.0.0. Run ",
		command: "nub-ia update",
		changelog: "https://github.com/sebamar88/nub-ia/compare/1111111...abc1234",
	});
	assert.equal(formatUpdateNotice({ behind: 3, upstream: "origin/main", remoteSha: "abc1234" }).changelog, undefined, "no GitHub remote → no changelog line");
	assert.equal(formatUpdateNotice({ behind: 3, upstream: "origin/main", remoteSha: "abc1234" }).instruction, "3 new commits on origin/main (abc1234) since your checkout. Run ");
	assert.equal(renderUpdateNoticeText(unreleased, 10), [
		"\u2500".repeat(10),
		"Update Available",
		"1 new commit on origin/main (abc1234) since v1.0.0. Run nub-ia update",
		"Changelog: https://github.com/sebamar88/nub-ia/compare/1111111...abc1234",
		"\u2500".repeat(10),
	].join("\n"));
});

test("githubWebUrl: https, ssh, scp-like with host alias; other hosts → undefined", () => {
	for (const remote of ["https://github.com/sebamar88/nub-ia.git", "https://github.com/sebamar88/nub-ia", "git@github.com:sebamar88/nub-ia.git", "git@sebamar88:sebamar88/nub-ia.git", "ssh://git@github.com/sebamar88/nub-ia.git"]) {
		assert.equal(githubWebUrl(remote), "https://github.com/sebamar88/nub-ia", remote);
	}
	assert.equal(githubWebUrl("https://gitlab.com/x/y.git"), undefined);
	assert.equal(githubWebUrl(undefined), undefined);
});

test("commitsBehindUpstream: not a repo / no upstream → undefined", () => {
	const dir = mkdtempSync(join(tmpdir(), "nub-ia-update-check-plain-"));
	try {
		assert.equal(commitsBehindUpstream(dir), undefined);
		execFileSync("git", ["init", "--quiet", "-b", "main", dir]);
		assert.equal(commitsBehindUpstream(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("commitsBehindUpstream counts only what was already fetched", () => {
	const { root, origin, dispose } = makeRepos();
	try {
		const state = commitsBehindUpstream(root);
		assert.equal(state?.behind, 0);
		assert.equal(state?.branch, "main");
		assert.equal(state?.upstream, "origin/main");
		assert.equal(state?.localSha, state?.remoteSha);
		assert.equal(state?.localVersion, "1.0.0");
		assert.equal(state?.remoteVersion, "1.0.0");
		assert.equal(state?.compareUrl, undefined, "a local bare origin has no GitHub page");
		pushAnotherCommit(origin, 2);
		// No fetch yet: the local remote-tracking ref is unchanged.
		assert.equal(commitsBehindUpstream(root)?.behind, 0);
		git(root, "fetch", "--quiet", "origin");
		assert.equal(commitsBehindUpstream(root)?.behind, 2);
		pushAnotherCommit(origin, 1, "1.1.0");
		git(root, "fetch", "--quiet", "origin");
		const released = commitsBehindUpstream(root);
		assert.equal(released?.behind, 3);
		assert.equal(released?.remoteVersion, "1.1.0", "remote package.json version is read from the fetched ref");
		assert.equal(released?.localVersion, "1.0.0");
	} finally {
		dispose();
	}
});

test("fetchIsDue: missing FETCH_HEAD → due; fresh → not due; stale → due", () => {
	const { root, dispose } = makeRepos();
	try {
		// `git clone` writes no FETCH_HEAD.
		assert.equal(fetchIsDue(root), true);
		git(root, "fetch", "--quiet", "origin");
		assert.equal(fetchIsDue(root, { intervalMs: 60_000 }), false);
		assert.equal(fetchIsDue(root, { intervalMs: 60_000, now: Date.now() + 120_000 }), true);
		assert.equal(fetchIsDue(join(tmpdir())), false, "outside a repo nothing is due");
	} finally {
		dispose();
	}
});

test("checkForUpdates: notice from fetched refs, background fetch only when due, opt-out env", () => {
	const { root, origin, dispose } = makeRepos();
	try {
		const spawned: string[][] = [];
		const spawnImpl = (_cmd: string, args: string[]) => { spawned.push(args); return { unref() {}, on() {} }; };
		assert.equal(checkForUpdates(root, {}, { spawnImpl }), undefined);
		assert.equal(spawned.length, 1, "no FETCH_HEAD yet → a background fetch is scheduled");
		assert.deepEqual(spawned[0].slice(2), ["fetch", "--quiet", "origin"]);

		pushAnotherCommit(origin, 1);
		git(root, "fetch", "--quiet", "origin");
		const notice = checkForUpdates(root, {}, { spawnImpl });
		assert.equal(notice?.title, "Update Available");
		assert.equal(notice?.command, "nub-ia update");
		assert.match(notice?.instruction ?? "", /^1 new commit on origin\/main \([0-9a-f]{7,}\) since v1\.0\.0\. Run $/);
		assert.equal(spawned.length, 1, "a fresh FETCH_HEAD schedules nothing");

		assert.equal(checkForUpdates(root, { [UPDATE_CHECK_OPT_OUT_ENV]: "1" }, { spawnImpl }), undefined);
		assert.equal(checkForUpdates(tmpdir(), {}, { spawnImpl }), undefined, "non-checkout stays silent");
		assert.equal(spawned.length, 1);
	} finally {
		dispose();
	}
});

type Ctx = { hasUI: boolean; ui: { setWidget: (key: string, factory: unknown) => void } };
type Handler = (event: unknown, ctx: Ctx) => void;
type Widget = { render: (width: number) => string[] };
type Factory = (tui: unknown, theme: unknown) => Widget;

const THEME = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `*${text}*` };
const NOTICE = { title: "Update Available", instruction: "New version abc1234 is available (2 new commits on origin/main). Run ", command: "nub-ia update", changelog: "https://github.com/sebamar88/nub-ia/compare/1111111...abc1234" };

function loadExtension(env: NodeJS.ProcessEnv, reset = true) {
	if (reset) resetUpdateNoticeState();
	const handlers: Record<string, Handler[]> = {};
	const pi = { on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); } };
	updateNoticeExtension(pi as never, env);
	return handlers;
}

function fakeCtx(hasUI = true) {
	const widgets: Record<string, unknown> = {};
	return { ctx: { hasUI, ui: { setWidget: (key: string, factory: unknown) => { widgets[key] = factory; } } }, widgets };
}

test("parseUpdateNotice rejects malformed payloads", () => {
	assert.equal(parseUpdateNotice(undefined), undefined);
	assert.equal(parseUpdateNotice("not json"), undefined);
	assert.equal(parseUpdateNotice(JSON.stringify({ title: "x" })), undefined);
	assert.deepEqual(parseUpdateNotice(JSON.stringify(NOTICE)), NOTICE);
	assert.equal(parseUpdateNotice(JSON.stringify({ ...NOTICE, changelog: 5 }))?.changelog, undefined);
});

test("renderUpdateNoticeBox mirrors pi's box: warning rules, bold title, accent command and changelog", () => {
	const lines = renderUpdateNoticeBox(NOTICE, THEME, 8);
	assert.deepEqual(lines, [
		"<warning>────────</warning>",
		" *<warning>Update Available</warning>*",
		" <muted>New version abc1234 is available (2 new commits on origin/main). Run </muted><accent>nub-ia update</accent>",
		" <muted>Changelog: </muted><accent>https://github.com/sebamar88/nub-ia/compare/1111111...abc1234</accent>",
		"<warning>────────</warning>",
		"",
	]);
	assert.equal(renderUpdateNoticeBox({ ...NOTICE, changelog: undefined }, THEME, 8).length, 5);
});

test("update-notice extension: inert without the env; with it, claims the env and shows the box until the first prompt", () => {
	assert.deepEqual(loadExtension({}), {});

	const env: NodeJS.ProcessEnv = { [UPDATE_NOTICE_ENV]: JSON.stringify(NOTICE) };
	const handlers = loadExtension(env);
	assert.equal(env[UPDATE_NOTICE_ENV], undefined, "children must not inherit the notice");

	const headless = fakeCtx(false);
	handlers.session_start[0]({}, headless.ctx);
	assert.deepEqual(headless.widgets, {});

	const { ctx, widgets } = fakeCtx();
	handlers.session_start[0]({}, ctx);
	const factory = widgets["nub-ia-update-notice"] as Factory;
	assert.equal(typeof factory, "function");
	assert.deepEqual(factory({}, THEME).render(8), renderUpdateNoticeBox(NOTICE, THEME, 8));

	handlers.before_agent_start[0]({}, ctx);
	assert.equal(widgets["nub-ia-update-notice"], undefined, "dismissed on the first prompt");
	handlers.session_start[0]({}, ctx);
	assert.equal(widgets["nub-ia-update-notice"], undefined, "stays dismissed");

	// /reload: the env is gone but the claimed notice survives in the process.
	assert.equal(loadExtension({}, false).session_start?.length, 1);
	resetUpdateNoticeState();
});

test("update-notice extension: silent in delegated rpc children", () => {
	const handlers = loadExtension({ [UPDATE_NOTICE_ENV]: JSON.stringify(NOTICE), NUB_IA_AGENTS_CHILD: "1" });
	const { ctx, widgets } = fakeCtx();
	handlers.session_start[0]({}, ctx);
	assert.deepEqual(widgets, {});
	resetUpdateNoticeState();
});
