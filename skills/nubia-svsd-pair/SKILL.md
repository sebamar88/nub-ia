---
name: nubia-svsd-pair
description: "Trigger: SVSD workflow, approved Story ready to implement, pair programming on a Story. AI drives, human navigates: small verified steps (test or evidence first), inside the Story boundary, with checkpoints."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# SVSD Pair

Fourth phase of the SVSD workflow (Spec, Backlog, Story, Pair). Concepts inspired by nschurmann/hola-ai; no text reused.

## Activation Contract

Use when the SVSD workflow is active and the human approved the active Story. The AI drives (writes code); the human
navigates (direction, scope, design, whether to continue). Do not start without an approved Story.

## Hard Rules

- **The Story is the execution boundary.** Never turn it into horizontal phases or tasks (database, backend, frontend,
  tests). Work stays "User can register" end to end, in small observable steps.
- ODD primitives (explore, track, verify, delegate) serve each step. They never replace the Story with their own plan.
- **Do not touch an agreed test** to make code pass: no deleting, skipping, weakening assertions or rewriting expected
  behavior. If a test looks wrong, stop, explain the conflict with the criteria, and ask.
- Stay inside the Story: no future-Story code, no unrequested features, no unrelated changes, no new acceptance criteria.
- Simplest thing that satisfies the criteria. A new abstraction must answer "what concrete problem in this Story or
  current code does it solve?"; if hypothetical, do not add it. Security and reliability are not speculative.
- Real RED/GREEN only: never fabricate failing or passing evidence.
- Subagents may explore, verify, or do one bounded step the human agreed to. No autonomous team per layer unless the human authorizes it.
- Permission mode governs commits and push: in plan/manual propose the commit point and message; push keeps the review gate.

## Decision Gates

Stop and ask the human when: a design decision appears; behavior outside the Story is needed; a test must change; the
approach failed repeatedly; a step grows much larger than expected; an abstraction with architectural impact seems
necessary; the criteria look wrong or incomplete (propose the smallest Story or Spec amendment).
Autonomy scales inversely with risk, uncertainty and irreversibility. Mechanical work with clear tests may batch
("next 3 cycles"); the Story boundary never changes.

## Execution Steps

1. Derive a **verification list** from the criteria at the highest practical level (API/integration, component, E2E,
   runtime command, manual). Mark manual items. Human approves or edits it before any code.
2. Pick the next smallest meaningful step.
3. Write its test or executable evidence; observe RED when applicable.
4. Minimum implementation; observe GREEN (or run the check).
5. Inspect the diff; optional refactor after evidence.
6. Checkpoint: say what changed and what is next; wait unless a batch was granted. Repeat from 2.

## Output Contract

Per step: the evidence and result, a short diff summary, and the next proposed step. When all criteria have evidence:
run the relevant checks, request `nub_review` (4R) when the diff warrants it, report manual items for the human, mark the
Story complete, update the Backlog, and let the human choose the next Story. Never start it automatically.

## References

- Previous phase: `skills/nubia-svsd-story/SKILL.md`
- ODD discipline: `skills/nubia/SKILL.md`; commits: `skills/work-unit-commits/SKILL.md`
