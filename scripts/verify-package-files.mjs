#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

const requiredPaths = [
  "bin/nub-ia.mjs",
  "assets/orchestrator.md",
  "assets/orchestrator-delegation.md",
  "assets/orchestrator-tracking.md",
  "assets/orchestrator-verification.md",
  "assets/orchestrator-writer.md",
  "assets/orchestrator-prompts.md",
  "assets/orchestrator-memory.md",
  "assets/orchestrator-skills.md",
  "assets/agents/gentle-ai-explore.md",
  "assets/agents/gentle-ai-verify.md",
  "assets/agents/gentle-ai-worker.md",
  "assets/agents/jd-fix-agent.md",
  "assets/agents/jd-judge-a.md",
  "assets/agents/jd-judge-b.md",
  "assets/agents/review-readability.md",
  "assets/agents/review-reliability.md",
  "assets/agents/review-resilience.md",
  "assets/agents/review-risk.md",
  "assets/chains/4r-review.chain.md",
  "assets/migrations/managed-assets-v0.10.7.json",
  "assets/migrations/managed-assets-v0.13.json",
  "assets/migrations/managed-assets-v0.14.json",
  "assets/support/strict-tdd.md",
  "assets/support/strict-tdd-verify.md",
  "docs/delegated-verification.md",
  "docs/skill-style-guide.md",
  "assets/model-tiers.json",
  "extensions/gentle-ai.ts",
  "extensions/nub-ia-router.ts",
  "extensions/rtk-rewrite.ts",
  "extensions/nub-ia-review.ts",
  "lib/nub-review.ts",
  "scripts/rtk-installer.mjs",
  "scripts/install-rtk.mjs",
  "lib/model-tier-router.ts",
  "extensions/resume-hint.ts",
  "extensions/skill-registry.ts",
  "lib/child-package-injection.ts",
  "lib/gentle-shell-launcher.ts",
  "lib/gentle-shell-resume-hint.ts",
  "lib/agent-assets.ts",
	"runtime/child-package-injection.mjs",
	"runtime/gentle-shell-launcher.mjs",
	"runtime/gentle-shell-resume-hint.mjs",
  "scripts/install-tui-mode-setting.mjs",
  "prompts/skill-creation.md",
  "skills/branch-pr/SKILL.md",
  "skills/chained-pr/SKILL.md",
  "skills/cognitive-doc-design/SKILL.md",
  "skills/comment-writer/SKILL.md",
  "skills/gentle-ai/SKILL.md",
  "skills/issue-creation/SKILL.md",
  "skills/judgment-day/SKILL.md",
  "skills/skill-creator/SKILL.md",
  "skills/skill-improver/SKILL.md",
  "skills/skill-registry/SKILL.md",
  "skills/work-unit-commits/SKILL.md",
];


// Reads the generator's `sources` array by regex rather than importing it,
// so this script never needs the generator to export anything it doesn't
// already export for its own `--write`/`--check` CLI use.
export function extractGeneratedRuntimeSources(packageRoot) {
  const generatorPath = join(packageRoot, "scripts/build-runtime-modules.mjs");
  const generatorSource = readFileSync(generatorPath, "utf8");
  const sourcesMatch = generatorSource.match(/const sources = \[([\s\S]*?)\];/);
  if (!sourcesMatch) {
    throw new Error(`${generatorPath} does not declare a "sources" array`);
  }
  return [...sourcesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

// Three-way reconciliation: the generator's `sources` names must equal the
// `.mjs` basenames on disk in `runtime/`, which must equal the `runtime/`
// entries in `requiredPaths`. Deliberately not a `lib/`-driven walk: most
// `lib/` modules are intentionally unpaired with a generated runtime file.
export function reconcileGeneratedRuntimeSources(packageRoot, sources, paths) {
  const runtimeRoot = join(packageRoot, "runtime");
  const runtimeBasenames = existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot)
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => name.slice(0, -".mjs".length))
    : [];
  const requiredRuntimeBasenames = paths
    .filter((relativePath) => relativePath.startsWith("runtime/") && relativePath.endsWith(".mjs"))
    .map((relativePath) => relativePath.slice("runtime/".length, -".mjs".length));

  const sourceSet = new Set(sources);
  const runtimeSet = new Set(runtimeBasenames);
  const requiredSet = new Set(requiredRuntimeBasenames);
  const names = new Set([...sourceSet, ...runtimeSet, ...requiredSet]);

  const drifted = [...names]
    .filter((name) => !(sourceSet.has(name) && runtimeSet.has(name) && requiredSet.has(name)))
    .sort()
    .map((name) => ({
      name,
      inSources: sourceSet.has(name),
      inRuntimeDir: runtimeSet.has(name),
      inRequiredPaths: requiredSet.has(name),
    }));

  return { drifted };
}

async function main() {
  if (existsSync(join(root, "extensions/sdd-init.ts"))) {
    console.error("gentle-pi package must not restore the retired SDD init extension");
    process.exit(1);
  }

  const missing = requiredPaths.filter((relativePath) => {
    const absolutePath = join(root, relativePath);
    return !existsSync(absolutePath) || !statSync(absolutePath).isFile();
  });

  if (missing.length > 0) {
    console.error("gentle-pi package is missing required Pi resources:");
    for (const relativePath of missing) {
      console.error(`- ${relativePath}`);
    }
    console.error("\nRefusing to pack/publish an incomplete npm package.");
    process.exit(1);
  }

  const generatedRuntimeSources = extractGeneratedRuntimeSources(root);
  const { drifted } = reconcileGeneratedRuntimeSources(root, generatedRuntimeSources, requiredPaths);
  if (drifted.length > 0) {
    console.error("gentle-pi generated runtime sources, runtime/*.mjs, and requiredPaths have drifted apart:");
    for (const entry of drifted) {
      const where = [];
      if (!entry.inSources) where.push("missing from generator sources");
      if (!entry.inRuntimeDir) where.push("missing from runtime/*.mjs");
      if (!entry.inRequiredPaths) where.push("missing from requiredPaths");
      console.error(`- ${entry.name}: ${where.join(", ")}`);
    }
    console.error("\nRefusing to pack/publish an unreconciled generated runtime.");
    process.exit(1);
  }

  const generatedRuntimeCheck = spawnSync(process.execPath, [join(root, "scripts/build-runtime-modules.mjs"), "--check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  if (generatedRuntimeCheck.status !== 0) {
    console.error("gentle-pi generated runtime does not match its TypeScript sources:");
    console.error((generatedRuntimeCheck.stderr || generatedRuntimeCheck.stdout || "unknown generator failure").trim());
    process.exit(1);
  }

  console.log(`nub-ia package resource check passed (${requiredPaths.length} files).`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
