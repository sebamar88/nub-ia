# Delegated verification

How the Nub-IA orchestrator decides who verifies a bounded writer's work. The rule itself lives once, in `assets/orchestrator-verification.md`; this page is the human-readable summary.

## The writer's report

The bounded writer runs the exact commands the parent lists under `## Verification`, in the foreground, and reports each as `<command>: <observed result>`. That report is the verification of record for the writer's own change. `## Known environmental failures` lists exact test names or command lines that already fail on the base: they are reported as evidence, not as a blocker, while any other failing required command still forces `status: partial`.

## Independent verification

A separate `gentle-ai-verify` run (or the native `Agent` fallback, with the same read-only task and the exact parent-authorized commands) is added when:

- the change touches a Task Size high-risk item (data or irreversible effects, security, changing a consumed contract, concurrency, delivery or environment, or no test would catch a regression);
- the writer reports `partial` or `blocked`;
- the check is expensive or external (E2E runs, installs) and the parent wants a cheaper profile; or
- the writer is a small model (mini or low effort) and the change is medium risk.

The parent spot check (re-running one reported command before delivery) stays required in every case.

## Review before delivery

Before delivery of a non-trivial change, the orchestrator runs the `nub_review` tool over the diff and addresses its BLOCKER/CRITICAL findings. The push gate asks for confirmation when changes were not reviewed or were blocked. A code review is not a substitute for applicable functional checks: tests, builds, and functional verification such as browser checks for UI changes still run when applicable.
