---
name: nubia-spec-design-tasks
description: "Trigger: SDD workflow, well-understood feature with independent parts, plan upfront and delegate. Spec, Design, Tasks, then Task-by-Task delegated execution with verification and review; human approves each phase."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# SDD

Development workflow SDD: Spec, Design, Tasks, delegated execution. It optimizes for planning and delegation; use SVSD
when understanding should emerge through implementation, and no workflow for tiny work. SDD reuses Nub-IA's agents,
router, review and gates; it adds no agents, commands or files of its own.

## Activation Contract

Use when the SDD workflow is active and the request is a non-trivial feature whose requirements are understood, whose
costly decisions are known, and whose parts can be separated into independent Tasks. Trivial requests skip the ceremony.
If the work is full of unknowns, say so and suggest SVSD (`/nubia:workflow svsd`) instead of guessing a plan.

## Hard Rules

- Phases are sequential and each ends at a **human checkpoint**: Spec, Design, Tasks, then execution. Never cross one
  without the human's go-ahead.
- Spec = what and why. Design = how, including only decisions this feature needs. Tasks = small ordered units, each
  with a goal, files or area, a verification, and its dependencies. Do not invent requirements or speculative design.
- The **Task is the unit of execution**: one bounded Task per delegation. Independent Tasks may run in parallel;
  dependent ones run in order. Do not delegate a Task the Design has not made unambiguous.
- Execution uses Nub-IA primitives: `nubia-explore` to look, `nubia-worker` to write, `nubia-verify` to check, tier
  routing as usual. Writers respect the permission mode and guardrails.
- Each Task needs verification evidence (test-first where meaningful, real RED/GREEN, never weaken a test to pass).
- Persist the plan only when asked or when the work is large: `odd/tasks/<feature>.md`, never `.atl/`.

## Decision Gates

- Execution reveals the Design is wrong → stop, propose the smallest Design (or Spec) amendment, wait for approval.
- A Task grows beyond its bounds or touches another Task's area → split or reorder it, do not stretch it.
- Material ambiguity before the Spec is final → run `nubia-grill-me`.
- All Tasks verified → relevant checks, `nub_review` (4R), then report; push keeps the review gate.

## Execution Steps

1. Spec: capability, scope, out of scope, invariants, acceptance outcomes. Checkpoint.
2. Design: approach, affected areas, key decisions with the alternative rejected. Checkpoint.
3. Tasks: ordered list with goal, area, verification, dependencies; mark which can run in parallel. Checkpoint.
4. Execute Task by Task, delegating per the rules; collect each result and its evidence.
5. Verify the whole against the Spec's acceptance outcomes; review; summarize.

## Output Contract

Per phase, the artifact in the conversation and the approval question. During execution, a Task table (Task, status,
evidence). At the end: outcomes met or not, review result, open risks.

## References

- Alternative workflow: `skills/nubia-svsd-spec/SKILL.md`
- `skills/nubia-grill-me/SKILL.md`; agents in `assets/agents/`
