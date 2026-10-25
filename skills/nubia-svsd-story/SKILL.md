---
name: nubia-svsd-story
description: "Trigger: SVSD workflow, Backlog Story selected for refinement. Refines exactly one Story (behavioral acceptance criteria, tiny mini plan, explicit Out of Scope) without writing code, then stops for approval before Pair."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# SVSD Story

Third phase of the SVSD workflow (Spec, Backlog, Story, Pair). Concepts inspired by nschurmann/hola-ai; no text reused.

## Activation Contract

Use when the SVSD workflow is active and the human selected ONE Story from the Backlog. Only one Story is active at a
time: if another is in progress, finish or park it first. Do not refine several Stories "to save time".

## Hard Rules

- **No code** in this phase: no edits, no scaffolding, no test files. Reading the repository is encouraged.
- Acceptance criteria describe **observable behavior** (Given / When / Then), not implementation. Default 2-3. Many more
  means the Story is too big: **split before bloating** and send the split back to the Backlog for approval.
- The Mini Plan is **at most 5 bullets** describing the vertical path through the system. No class names, no
  file-by-file instructions, no future Stories, no speculative abstractions. It is disposable guidance.
- **Out of Scope is mandatory** and explicit; it keeps neighbouring Stories out of this one.
- Do not invent requirements: ground criteria in the Spec and the Story line; unknowns become questions to the human.
- Facts are yours (inspect the code for what exists); decisions are the user's. High-risk or conflicting criteria →
  run `nubia-grill-me`, not by default.
- Never start Pair yourself: the approval is the human's.

## Decision Gates

- Criteria exceed ~3, or two independent behaviors appear → propose the split, wait.
- Criteria conflict with the Spec or an Invariant → surface it; propose the smallest Spec amendment, wait for approval.
- A criterion cannot be verified automatically → mark it under Manual Verification.
- The Mini Plan needs more than 5 bullets → the Story is too large; split.
- Human edits criteria, plan or scope → apply, show only the change. Human approves → recommend Pair and wait for their go-ahead.

## Execution Steps

1. Restate the selected Story and the Spec Invariants that touch it.
2. Inspect the code it will cross (what exists, what conventions apply).
3. Draft criteria, Mini Plan, Out of Scope, Manual Verification.
4. Check the gates (size, conflicts, invention).
5. Present it and ask the human to review criteria, plan and scope, then approve.

## Output Contract

```markdown
# Story
As a <actor>, I want <behavior>, so that <value>.
## Acceptance Criteria
- Given ... When ... Then ...
## Mini Plan
- (<= 5 bullets, the vertical path)
## Out of Scope
- ...
## Manual Verification
- ...
## Suggestions
- (optional ideas that are NOT part of this Story)
```

Ends with the approval question. Suggestions never enter the Story without the human's say.

## References

- Previous phase: `skills/nubia-svsd-backlog/SKILL.md`; next phase: Pair
- `skills/nubia-grill-me/SKILL.md`
