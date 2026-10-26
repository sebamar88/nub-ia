// Outdated-checkout notice for `nub-ia` (the Git checkout made by install.sh /
// install.ps1). Mirrors how pi announces a new version: the launch itself never
// waits on the network. Each interactive launch compares HEAD with its already
// fetched upstream (local, instant) and, at most once per interval, refreshes
// the remote-tracking refs with a detached background `git fetch`, so the next
// launch sees what was pushed meanwhile. A Pi-managed install (`pi install
// git:`) or an npm install has no upstream and stays silent.
import { brand } from "../runtime/brand.mjs";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Env var the launcher sets for the TUI extension (extensions/update-notice.ts). */
export const UPDATE_NOTICE_ENV = "NUB_IA_UPDATE_NOTICE";
/** Set to 1 to disable the check (also skips the background fetch). */
export const UPDATE_CHECK_OPT_OUT_ENV = "NUB_IA_NO_UPDATE_CHECK";
export const DEFAULT_FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function git(root, args, run = spawnSync) {
	const result = run("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", windowsHide: true });
	return result.status === 0 ? (result.stdout ?? "").trim() : undefined;
}

/** GitHub web URL for an https:// or ssh origin (incl. `~/.ssh/config` host aliases), else undefined. */
export function githubWebUrl(remote) {
	if (typeof remote !== "string") return undefined;
	const match = /^(?:https?:\/\/[^/]*github\.com\/|(?:ssh:\/\/)?git@[^:/]+[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

/** "version" of a package.json text, or undefined. */
function packageVersion(text) {
	try {
		const version = JSON.parse(text)?.version;
		return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pure: the notice lines for an update, shaped like pi's "Update Available"
 * box (title, instruction, changelog), or undefined when up to date. A remote
 * package.json version newer than the local one is announced as "New version
 * X.Y.Z" with the GitHub Release as changelog; unreleased commits fall back to
 * the commit count and the compare page.
 */
export function formatUpdateNotice(update) {
	if (!update || !Number.isInteger(update.behind) || update.behind <= 0) return undefined;
	const commits = `${update.behind} new commit${update.behind === 1 ? "" : "s"}`;
	const released = update.remoteVersion !== undefined && update.remoteVersion !== update.localVersion;
	const lines = {
		title: "Update Available",
		instruction: released
			? `New version ${update.remoteVersion} is available${update.localVersion ? ` (you have ${update.localVersion})` : ""}. Run `
			: `${commits} on ${update.upstream} (${update.remoteSha}) since ${update.localVersion ? `v${update.localVersion}` : "your checkout"}. Run `,
		command: `${brand.bin} update`,
	};
	if (released && update.webUrl) lines.changelog = `${update.webUrl}/releases/tag/v${update.remoteVersion}`;
	else if (update.compareUrl) lines.changelog = update.compareUrl;
	return lines;
}

/** Plain-text rendering of formatUpdateNotice for stderr. */
export function renderUpdateNoticeText(lines, width = 60) {
	const rule = "\u2500".repeat(width);
	return [rule, lines.title, `${lines.instruction}${lines.command}`, lines.changelog ? `Changelog: ${lines.changelog}` : undefined, rule]
		.filter((line) => line !== undefined)
		.join("\n");
}

/**
 * How far HEAD is behind its upstream, using refs already fetched (no network).
 * undefined when `root` is not a Git checkout on a branch with an upstream.
 */
export function commitsBehindUpstream(root, { run } = {}) {
	if (git(root, ["rev-parse", "--is-inside-work-tree"], run) !== "true") return undefined;
	const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], run);
	if (!branch || branch === "HEAD") return undefined;
	const upstream = git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"], run);
	if (!upstream) return undefined;
	const count = git(root, ["rev-list", "--count", `HEAD..${upstream}`], run);
	if (count === undefined || !/^\d+$/.test(count)) return undefined;
	const localSha = git(root, ["rev-parse", "--short", "HEAD"], run);
	const remoteSha = git(root, ["rev-parse", "--short", upstream], run);
	const webUrl = githubWebUrl(git(root, ["remote", "get-url", upstream.split("/")[0]], run));
	const compareUrl = webUrl && localSha && remoteSha ? `${webUrl}/compare/${localSha}...${remoteSha}` : undefined;
	let localVersion;
	try { localVersion = packageVersion(readFileSync(join(root, "package.json"), "utf8")); } catch { /* not a package */ }
	const remoteVersion = packageVersion(git(root, ["show", `${upstream}:package.json`], run) ?? "");
	return { behind: Number(count), branch, upstream, localSha, remoteSha, localVersion, remoteVersion, webUrl, compareUrl };
}

/** True when FETCH_HEAD is missing or older than `intervalMs`. */
export function fetchIsDue(root, { now = Date.now(), intervalMs = DEFAULT_FETCH_INTERVAL_MS, stat = statSync, run } = {}) {
	const gitDir = git(root, ["rev-parse", "--absolute-git-dir"], run);
	if (!gitDir) return false;
	try {
		return now - stat(join(gitDir, "FETCH_HEAD")).mtimeMs >= intervalMs;
	} catch {
		return true;
	}
}

/** Detached, silent `git fetch`; never prompts for credentials and never blocks the launch. */
export function spawnBackgroundFetch(root, { spawnImpl = spawn, env = process.env } = {}) {
	try {
		const child = spawnImpl("git", ["-C", root, "fetch", "--quiet", "origin"], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: { ...env, GIT_TERMINAL_PROMPT: "0" },
		});
		child.on?.("error", () => {});
		child.unref?.();
		return true;
	} catch {
		return false;
	}
}

/**
 * The notice lines for this launch (or undefined), scheduling a background
 * fetch when one is due. Every failure is silence: the check never breaks a launch.
 */
export function checkForUpdates(root, env = process.env, options = {}) {
	if (env[UPDATE_CHECK_OPT_OUT_ENV] === "1") return undefined;
	const state = commitsBehindUpstream(root, options);
	if (state === undefined) return undefined;
	if (fetchIsDue(root, options)) spawnBackgroundFetch(root, { spawnImpl: options.spawnImpl, env });
	return formatUpdateNotice(state);
}
