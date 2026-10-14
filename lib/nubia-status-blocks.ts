// Nub-IA's additions to the Status card, in one place (roadmap T4.1): the
// Review, Subagents, Router, Mode and Audit blocks, with the pi.events
// subscriptions that feed them. The upstream shell (extensions/nubia-shell.ts)
// only constructs this, subscribes once, and spreads `model()` into the
// ShellBarModel it already builds — so a future upstream merge touches three
// lines there instead of a dozen scattered blocks.

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENTS_STATUS_EVENT, type AgentsStatusPayload, agentsStatusLines, parseAgentsStatus } from "./agents-status-model.ts";
import { auditToday, parseAuditRows } from "./audit-log.ts";
import { MODE_LABEL } from "./permission-mode-policy.ts";
import { ROUTER_STATUS_EVENT, type RouterStatusPayload, parseRouterStatus, routerStatusLines } from "./router-status-model.ts";
import { metricsFilePath } from "./runtime-metrics-sink.ts";
import type { ShellBarModel } from "./shell-bar.ts";
import { reviewStatusLines, type LastReview } from "./nub-review.ts";
import { resolveReviewGate } from "./review-gate-policy.ts";
import { modeChip, parsePermissionModePayload, PERMISSION_MODE_EVENT, type PermissionModePayload } from "../extensions/nubia-permission-mode.ts";

export interface NubiaStatusDeps {
	env: NodeJS.ProcessEnv;
	now(): number;
	/** The last nub_review on record for a worktree (extensions/nub-ia-review.ts). */
	readLastReview(cwd: string): LastReview | undefined;
	/** Hash of the diff a push would deliver, or undefined when unknown. */
	pushDiffHash(cwd: string): Promise<string | undefined>;
}

export type NubiaStatusModel = Pick<ShellBarModel, "review" | "agents" | "router" | "mode" | "audit">;

export class NubiaStatusBlocks {
	private agents: AgentsStatusPayload | undefined;
	private router: RouterStatusPayload | undefined;
	private permissionMode: PermissionModePayload | undefined;
	// The deliverable hash is a git call: memoised per (changes count, 10 s) and
	// refreshed in the background; the first paint shows the record without
	// staleness until the hash arrives.
	private readonly reviewHashMemo = new Map<string, { key: string; at: number; hash: string | undefined; pending: boolean }>();
	private auditMemo: { at: number; text: string | undefined } | undefined;
	private readonly deps: NubiaStatusDeps;

	constructor(deps: NubiaStatusDeps) {
		this.deps = deps;
	}

	/** Subscribes to the channels the agents, router and permission-mode extensions publish on. */
	subscribe(pi: ExtensionAPI): void {
		pi.events.on(AGENTS_STATUS_EVENT, (payload) => { const parsed = parseAgentsStatus(payload); if (parsed) this.agents = parsed; });
		pi.events.on(ROUTER_STATUS_EVENT, (payload) => { const parsed = parseRouterStatus(payload); if (parsed) this.router = parsed; });
		pi.events.on(PERMISSION_MODE_EVENT, (payload) => { const parsed = parsePermissionModePayload(payload); if (parsed) this.permissionMode = parsed; });
	}

	/** Everything Nub-IA adds to the Status card for this worktree, built per frame. */
	model(cwd: string, changeCount: number): NubiaStatusModel {
		const now = this.deps.now();
		return {
			review: this.review(cwd, changeCount),
			agents: agentsStatusLines(this.agents, now),
			router: routerStatusLines(this.router, now),
			audit: this.audit(now),
			...(this.permissionMode ? { mode: { chip: modeChip(this.permissionMode.mode), cap: this.permissionMode.max ? `max ${MODE_LABEL[this.permissionMode.max]} · ${this.permissionMode.source.max === "project-guardrails" ? "repo" : this.permissionMode.source.max === "org-policy" ? "org" : "user"}` : undefined, mode: this.permissionMode.mode } } : {}),
		};
	}

	/** Current permission mode payload, for the customize menu row. */
	get mode(): PermissionModePayload | undefined {
		return this.permissionMode;
	}

	private review(cwd: string, changeCount: number): ShellBarModel["review"] {
		const last = this.deps.readLastReview(cwd);
		const memo = this.reviewHashMemo.get(cwd);
		const key = `${changeCount}`;
		const now = this.deps.now();
		if (!memo || memo.key !== key || now - memo.at > 10_000) {
			const next = { key, at: now, hash: memo?.hash, pending: true };
			this.reviewHashMemo.set(cwd, next);
			void this.deps.pushDiffHash(cwd).then((hash) => { next.hash = hash; next.pending = false; }, () => { next.pending = false; });
		}
		return reviewStatusLines(last, this.reviewHashMemo.get(cwd)?.hash, resolveReviewGate(cwd).mode);
	}

	/** Today's approvals/denials from the local trail, re-read at most every 10 s. */
	private audit(now: number): string | undefined {
		if (!this.auditMemo || now - this.auditMemo.at > 10_000) {
			let text: string | undefined;
			try { text = readFileSync(metricsFilePath("audit", this.deps.env), "utf8"); } catch { text = undefined; }
			this.auditMemo = { at: now, text };
		}
		if (!this.auditMemo.text) return undefined;
		const today = auditToday(parseAuditRows(this.auditMemo.text).rows, new Date(now));
		if (today.approved === 0 && today.denied === 0) return undefined;
		return `${today.approved} approved · ${today.denied} denied today`;
	}
}
