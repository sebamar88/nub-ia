# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nub-IA (`nub-ia`) is Nubiral's coding-agent shell, a fork of gentle-shell (`gentle-pi`) built as a **Pi package** (`@earendil-works/pi-coding-agent`). It is not an app with a server: Pi loads `extensions/`, `skills/`, `prompts/` and `themes/` (declared under `pi` in `package.json`), and `bin/nub-ia.mjs` is a launcher that provisions an isolated home (`~/.nub-ia/agent`) and then execs `pi`. Private package, installed from Git, never published to npm (`npm publish` is blocked by guardrails).

## Commands

Node >= 22.19, pnpm 11 (`packageManager` is pinned). TypeScript runs directly via `--experimental-strip-types`; there is no build step for `lib/` or `extensions/`.

```bash
pnpm test                         # unit tests + runtime harness (scripts/run-test-suite.mjs; every stage runs even if one fails)
node --experimental-strip-types --test tests/<name>.test.ts   # single test file
node --experimental-strip-types --test --test-name-pattern="<regex>" tests/<name>.test.ts   # single test
pnpm run test:harness             # only tests/runtime-harness.mjs (loads the real extensions through Pi)
pnpm run typecheck                # tsc via scripts/check-types.mjs (strict is off)
pnpm run build:runtime-modules    # regenerate runtime/*.mjs from lib/*.ts
pnpm run check:runtime-modules    # CI check that runtime/ is up to date
node scripts/verify-package-files.mjs   # package `files` manifest check
pnpm run test:packed-package      # pack + install into a temp project
node scripts/release.mjs --dry-run      # preview the release the next push to main would cut
```

CI (`.github/workflows/ci.yml`) runs: test, typecheck, check:runtime-modules, verify-package-files, test:packed-package.

## Architecture

- **`bin/nub-ia.mjs`**: thin process/fs/exec glue. All decision logic (argv parsing, home resolution, pi lookup, version gate, invocation) lives in `lib/nubia-launcher.ts` so it can be unit tested.
- **`runtime/*.mjs` is generated**, never edit by hand. The launcher cannot load `.ts` before Pi is running, so `scripts/build-runtime-modules.mjs` strips types from the `lib/` modules listed in its `sources` array (`child-package-injection`, `nubia-launcher`, `nubia-resume-hint`, `usage-report`). Any `lib/` module the launcher imports must be added to that list and `runtime/` regenerated.
- **`extensions/*.ts`**: Pi extensions that register commands (`/nubia:*`), tools, and event hooks. `nubia-harness.ts` is the core (ODD protocol, system-prompt injection, guardrails, subagent dispatch). Others: `nub-ia-review.ts` (4R review + push gate), `nub-ia-router.ts` (virtual `nub-ia/{strong,strong-alt,balanced,fast}` models), `rtk-rewrite.ts` (rewrites bash commands through the pinned `rtk` binary), `nubia-permission-mode.ts`, `startup-banner.ts`, `nubia-agents.ts`.
- **`lib/*.ts`**: pure, unit-tested logic behind the extensions (policies, routers, review engine `nub-review.ts`, agents-* runner/view/messaging, org policy, secret redaction, ODD phase registry). Extensions should stay thin; put logic in `lib/`.
- **`assets/`**: `agents/*.md` (subagent definitions; frontmatter `model: nub-ia/<tier>`; `review-*` are the four review lenses, `jd-*` the judgment-day agents), `model-tiers.json` (tier -> physical model per provider), `profiles/`, `migrations/`, `brand/`.
- **`skills/`**: SKILL.md files shipped with the package (follow `docs/skill-style-guide.md`).
- **`odd/tasks/`**: durable feature documents the ODD workflow writes for large work.
- **`tests/`**: flat `*.test.ts` files (node:test), plus `runtime-harness.mjs` and `tests/fixtures/` (including review fixtures and `prompt-pins.json`).

### Policy precedence (hard invariant)

Everything configurable at repo level (`.pi/nub-ia/*.json`) or org level (`nub-ia policy set ...`) can **only tighten** the user's settings, never loosen them: permission modes, protected paths, per-agent rules, review gate, model allowlists, budgets. A change that lets a repo or org relax something is a bug. See `docs/governance.md`.

### Origin

Nub-IA began as a fork of `Gentleman-Programming/gentle-shell` but **no longer syncs with it**: the `upstream` remote, `upstream-sync.yml` and `upstream-diff.mjs` were removed, so there is no mergeability constraint on inherited files. Internal identifiers, persisted schemas, message types and env vars were renamed to `nubia` / `nub-ia` / `NUB_IA_*` with no compatibility layer (the tool had no users yet). What still carries upstream names on purpose: the legacy read fallbacks (`~/.pi/gentle-ai`, `LEGACY_AGENT_NAMES`, `assets/migrations/`), the `Gentle*` themes, the `gentleman` persona, and launcher detection of an installed upstream `gentle-pi` package. Keep `LICENSE` and `docs/UPSTREAM-*.md` (MIT attribution and trademark notice).

## Conventions

- **Language split**: code, identifiers, comments, commit messages, model-facing prompts/block reasons, TUI text, `--help`, tests, skills and technical docs in **English**. `README.md` and usage docs under `docs/` are in **Spanish** (read by the team). Keep technical terms (`review`, `push`, `tier`) in English inside Spanish text. Details in `docs/CONTRIBUTING.md`.
- **Commits**: Conventional Commits. Each push to `main` cuts a semver release (`feat!`/`BREAKING CHANGE` -> major, `feat` -> minor, rest -> patch), so the commit type decides the version. Never edit `version` in `package.json` or `CHANGELOG.md` by hand; the release workflow writes them.
- **PRs**: one task per PR, ~400 lines max (see `skills/chained-pr`).
- **Behavior changes** need a test and an update to the doc that describes them. A new shipped file must be added to `scripts/verify-package-files.mjs`.
- **Review lens prompts** (`assets/agents/review-*.md`): validate with `/nubia:review eval` against the fixtures and update `tests/fixtures/review/prompt-pins.json`.
- External pins (rtk binary SHA-256 in `scripts/rtk-installer.mjs`, ponytail version in `lib/nubia-launcher.ts` `TEAM_PACKAGE_SOURCES`) are bumped by `pin-bumps.yml`; do not loosen them to ranges.
- `.pi/nub-ia/runtime-guardrails.json` is the committed command-guardrail config for this repo.

## Further reading

`docs/readme-reference.md` (technical reference and the ODD protocol), `docs/nub-ia-shell.md`, `docs/permission-modes.md`, `docs/governance.md`, `docs/review-ci.md`, `docs/CONTRIBUTING.md`.
