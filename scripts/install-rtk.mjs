#!/usr/bin/env node
// postinstall step: ship the pinned rtk binary with the package so every
// Nub-IA install gets token-filtered tool output without a manual step.
// Never fails the install: rtk is an optimisation, and extensions/rtk-rewrite.ts
// falls back to a PATH `rtk` or passes commands through unchanged.
import { RTK_VERSION, installRtk } from "./rtk-installer.mjs";

if (process.env.NUB_IA_SKIP_RTK_INSTALL === "1") {
	console.warn("NUB_IA_SKIP_RTK_INSTALL=1: skipped the package-local rtk install; the rtk-rewrite extension will use a PATH rtk if present.");
} else {
	try {
		const result = await installRtk();
		console.log(`rtk v${RTK_VERSION} ${result.installed ? "installed" : "already present"} at ${result.binaryPath}`);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? ` [${error.code}]` : "";
		console.warn(`nub-ia could not install the package-local rtk v${RTK_VERSION}${code}: ${error instanceof Error ? error.message : String(error)}. Commands will run unfiltered until \`rtk\` is on PATH or \`node scripts/install-rtk.mjs\` succeeds.`);
	}
}
