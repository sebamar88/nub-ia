---
name: nubia-terraform
description: "Trigger: terraform, tofu, infra change, plan and apply, state, modules, infra/ directory. Safe Terraform workflow under Nub-IA's permission modes: plan freely, apply only with the human, protect state and infra paths, and review infra diffs with the 4R lenses."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# Terraform under Nub-IA

## Activation Contract

Use for any change under an infrastructure directory (`infra/`, `terraform/`, `*.tf`, `*.tfvars`) or any request that mentions plan, apply, state or modules.

## Hard Rules

- `terraform plan`, `validate`, `fmt -check`, `show`, `output`, `state list|show` are read-only and run in every permission mode. `apply`, `destroy`, `import`, `state mv|rm`, `taint`, `workspace delete` change the world: they are mutating, confirm in manual/accept-edits, and must never be run from a subagent.
- Never edit `.tfstate`, `*.tfstate.backup` or `.terraform.lock.hcl` by hand; never commit state. Recommend `paths.deny: ["**/*.tfstate*", "**/.terraform/**"]` in the repository guardrails when absent.
- Never put secrets in `*.tfvars` committed to the repository; reference them from the provider's secret store or environment.
- A plan with destroys (`-/+` or `-`) is a decision for the human: show the resource addresses and stop.
- Apply only what was planned: `terraform plan -out=tfplan` then `terraform apply tfplan`, never a bare `apply` after a chat.

## Decision Gates

- Infra diff touches more than one environment/workspace → split the change; ask before continuing.
- Plan shows destroys or replacements of stateful resources (databases, buckets, queues) → stop and ask; propose `prevent_destroy` or a migration.
- Provider or module version bump → run plan on every affected root module before reporting done.

## Execution Steps

1. `terraform fmt -check` and `terraform validate` in the root module.
2. `terraform plan -out=tfplan -no-color` (or the project's wrapper); summarise adds/changes/destroys by resource address.
3. If destroys: report and stop. Otherwise show the summary and wait for the human's explicit go-ahead before `apply`.
4. `terraform apply tfplan` only in auto/yolo or after the confirmation dialog; never in plan mode.
5. Run `/nubia:review` on the infra diff; the resilience lens checks rollback and observability, the risk lens checks exposed resources and secrets.

## Output Contract

Plan summary as `+N ~M -K`, the list of destroyed/replaced addresses (or "none"), the exact apply command used (or "not applied"), and the review verdict.

## References

- `docs/permission-modes.md` (what counts as read-only)
- `docs/governance.md` (protected paths)
