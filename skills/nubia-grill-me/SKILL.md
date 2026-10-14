---
name: nubia-grill-me
description: "Trigger: grill me, grill this plan, interrogame, hazme preguntas, stress-test this design, challenge my idea, before we build this, am I missing something. A relentless, round-based interview that maps a plan or decision as a design tree and stops only when nothing is left silently assumed; never acts until the user confirms shared understanding."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
  upstream: "mattpocock/skills (skills/productivity/grilling, MIT, commit 49dd158)"
---

# Grill me

Adapted from Matt Pocock's `grilling` skill (MIT). Same method; wired to Nub-IA's tools and ODD.

## Activation Contract

Use when the user asks to be grilled, interviewed or challenged about a plan, design, decision or idea, or when ODD's
"resolve uncertainty" step finds more than one open product decision before a large implementation. Do not use for a
request the user already specified precisely; one focused question suffices there.

## Hard Rules

- Interview until **shared understanding**; never start implementing, delegating writers or creating task documents
  until the user confirms the understanding is complete.
- Decisions are the user's; **facts are yours**. Anything that can be looked up (filesystem, git, docs, tests) is never
  asked: look it up inline or dispatch `nubia-explore`, and only the questions downstream of that fact wait.
- Word every question so that **"yes" accepts your recommended answer**. Always give a recommendation.
- Ask the whole **frontier** in one round (every decision whose prerequisites are settled); a question that depends on
  another still open this round belongs to a later round.
- Number questions `Q1…Qn`; each with a title, body (options when useful) and `➡️` recommendation. When the
  `ask_user_question` tool is available and a round has ≤ 4 questions with ≤ 4 options each, use it; otherwise write the
  round as text in the format below.
- Keep rounds small and concrete: a round with more than ~6 questions means the tree was not pruned by prerequisites.

## Decision Gates

- User answers "yes" / "ok" to a question → the recommendation is settled; move on.
- An answer reveals a new branch → add it to the tree; it becomes frontier only when its prerequisites settle.
- An answer contradicts an earlier settled decision → surface the contradiction as the first question of the next round.
- Frontier empty → summarise the settled tree (one line per decision) and ask the single closing question: "¿Queda algo
  sin decidir?" / "Anything still undecided?". Only a confirmation ends the session.

## Execution Steps

1. Restate the plan or decision in one or two lines as you understood it.
2. Build the initial design tree: root decision, the decisions hanging off it, their prerequisites.
3. Compute the frontier; dispatch fact lookups (inline or `nubia-explore`) for anything environmental.
4. Ask the round (tool or text format), wait for all answers.
5. Update the tree, recompute the frontier, repeat from 3.
6. Close with the settled summary and the confirmation question. After confirmation, hand off to ODD as usual (classify,
   track if large, implement); the summary is the spec's first draft.

Text format for a round:

```
❓ **Q1** - **<title>**: <body, options if useful>

➡️ <recommended answer>

---

❓ **Q2** - **<title>**: <body>

➡️ <recommended answer>
```

## Output Contract

Rounds as above until the frontier is empty; then a numbered summary of every settled decision (decision → choice →
why) and the explicit confirmation question. No code, no files, no delegation before confirmation.

## References

- Upstream method: https://github.com/mattpocock/skills (`skills/productivity/grilling/SKILL.md`, MIT)
- ODD step "Resolve uncertainty": `assets/orchestrator.md`
- `ask_user_question` tool (extensions/ask-user-question.ts)
