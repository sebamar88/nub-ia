---
name: nubia-svsd-backlog
description: "Trigger: SVSD workflow, approved Spec ready to decompose, backlog of user stories. Turns an approved Spec into a short ordered list of vertical user-value Stories and stops for the human to review and pick one."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# SVSD Backlog

Second phase of the SVSD workflow (Spec, Backlog, Story, Pair). Concepts inspired by nschurmann/hola-ai; no text reused.

## Activation Contract

Use when the SVSD workflow is active and the human has approved a Spec and asks for its Backlog. Do not use without an
approved Spec (go back to `nubia-svsd-spec`) and do not refine any Story here.

## Hard Rules

- **Do not invent requirements.** Every Story must trace to the Spec's Scope; anything in Out of Scope stays out.
- **Vertical only.** A Story is observable user value that cuts through every layer it needs. No technical Stories:
  "create the table", "build the API", "build the login page", "add tests" are rejected and reshaped.
- Infrastructure belongs inside the first Story that genuinely needs it. Never a Story to prepare for future ones.
- The first Story is the smallest usable walking skeleton.
- One line per Story. **No acceptance criteria, mini plans or designs yet**: those are written per Story, just in time.
- Keep it small. About 10-15 Stories is a signal to reconsider the Spec's scope, not a target; a bounded Spec is often 3-6.
- Write no code and create no files. Never refine Story 1 on your own: the human picks.

## Decision Gates

- A candidate Story is a layer or a task → reshape it into the behavior it enables, or merge it into the first Story that needs it.
- A candidate Story needs more than a sentence to describe, or hides two independent behaviors → split it now.
- The Spec leaves a Story's behavior undefined → ask or add it to Open Questions; do not fill the gap.
- Backlog exceeds ~15 Stories → stop and propose narrowing the Spec.
- Human reorders or edits → apply, show only what changed, keep waiting. Human picks a Story → recommend the Story phase and wait for their go-ahead.

## Execution Steps

1. Re-read the approved Spec: Scope, Out of Scope, Invariants.
2. List the user-observable behaviors the Scope promises.
3. Order them as a walking skeleton first, then incremental value.
4. Check each against the vertical and no-invention rules.
5. Propose the Backlog and ask the human to review, reorder or edit, then select ONE Story.

## Output Contract

A numbered list, one line per Story, in the form "<Actor> can <behavior>.", in proposed order:

```
1. User can register with email/password.
2. Registered user can log in.
3. Authenticated user can retrieve their session.
4. User can log out.
```

Plus one line naming why Story 1 is the walking skeleton. Ends asking which Story to refine. Nothing else is produced.

## References

- Previous phase: `skills/nubia-svsd-spec/SKILL.md`; next phase: Story
- Feedback upward: if Stories contradict the Spec, propose the smallest Spec amendment and wait for approval
