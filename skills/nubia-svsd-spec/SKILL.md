---
name: nubia-svsd-spec
description: "Trigger: SVSD workflow, new capability or feature to specify, /nubia:workflow svsd spec phase. Shapes one bounded capability into a Spec (what and why, never how) and stops for the human's approval."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# SVSD Spec

First phase of the SVSD workflow (Spec, Backlog, Story, Pair). Concepts inspired by nschurmann/hola-ai; no text reused.

## Activation Contract

Use when the SVSD workflow is active and the user asks for a new capability or feature. Do not use for trivial requests
(typo, padding, isolated bug): those skip the ceremony. One Spec is one bounded capability ("email/password
authentication", "checkout"), never a whole product and never an endpoint or class.

## Hard Rules

- The Spec answers **what and why**. No services, repositories, DTOs, schemas, module trees, adapters or patterns,
  unless the existing system already constrains them.
- **Do not invent requirements.** Anything the user did not say and the code cannot answer goes under Open Questions.
- Facts are yours (read the code, docs, tests); decisions are the user's.
- Material ambiguity (several open product decisions) → run `nubia-grill-me` before drafting. Do not grill every Spec.
- Write no code and create no files. The Spec lives in the conversation unless the user asks to persist it (then
  `odd/tasks/<capability>.md`, never `.atl/`, which is a gitignored registry).
- Never continue into the Backlog yourself: the Spec is a checkpoint.

## Decision Gates

- Request is a single small change → say SVSD is unnecessary and offer the direct path (`/nubia:workflow none`).
- Request spans several unrelated capabilities → propose one Spec per capability and ask which comes first.
- User edits the Spec → apply the edit, show only what changed, keep waiting.
- User approves → recommend the Backlog phase as the next step and wait for their go-ahead.

## Execution Steps

1. Restate the capability in one line.
2. Inspect the repository for what already exists and constrains it.
3. Resolve open decisions (grill if material); list the rest as Open Questions.
4. Draft the Spec using the structure below; omit sections that do not apply, never pad them.
5. Propose it and stop: "Approve, or tell me what to change."

## Output Contract

```markdown
# Capability: <name>
## Goal
## User / Business Value
## Scope
## Out of Scope
## Constraints
## Invariants
## Acceptance Outcomes
## Expensive-to-change Decisions   (only those that apply: tenancy, permissions model, offline sync, i18n, security, external contracts; name them, do not design them)
## Known Risks
## Open Questions
```

Ends with the approval question. Nothing else is produced in this phase.

## References

- Next phase: Backlog (the Spec's Scope and Out of Scope become its input)
- `skills/nubia-grill-me/SKILL.md`
- `/nubia:workflow` (extensions/nubia-workflow.ts)
