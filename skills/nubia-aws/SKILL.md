---
name: nubia-aws
description: "Trigger: aws cli, S3, Lambda, IAM, CloudWatch logs, ECS, EKS, account, region, assume role. Operate the AWS CLI from Nub-IA safely: read-only by default, destructive calls confirmed, identities and secrets never pasted, regions and accounts stated explicitly."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# AWS CLI under Nub-IA

## Activation Contract

Use when a task runs `aws …` commands or touches AWS resources through scripts.

## Hard Rules

- Start every AWS task by stating account and region: `aws sts get-caller-identity --query Account --output text` and the `AWS_REGION` in use. Never guess the account.
- `describe-*`, `list-*`, `get-*`, `sts get-caller-identity`, `logs tail|filter-log-events` are read-only and allowed in every permission mode. `delete-*`, `terminate-*`, `put-*`, `update-*`, `create-*`, `s3 rm|mv|sync --delete`, IAM policy changes are mutating: confirm in manual/accept-edits and never from a subagent.
- Never print `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` or presigned URLs into the transcript; the redactor masks the common shapes, but do not rely on it. Use `--query` to select only the fields needed.
- Prefer `--dry-run` where the service supports it (`ec2`, `s3 sync --dryrun`) before the real call.
- Pagination: use `--max-items`/`--page-size` or `--query` so a listing never floods the context.

## Decision Gates

- The command names a production account or `prod` resource → stop and ask for explicit confirmation of the target even in auto mode.
- An IAM change widens permissions (`*` actions or resources) → propose the least-privilege alternative first.
- `s3 rm --recursive`, `delete-stack`, `terminate-instances` → list the exact targets, then wait for the human.

## Execution Steps

1. Identity and region check (read-only).
2. Describe the current state of the resources involved with a bounded `--query`.
3. For changes: show the exact command and its targets; run it only under the mode's rules and after any confirmation.
4. Verify the result with a read-only call; report the before/after.

## Output Contract

Account id, region, the read-only commands used, the mutating command(s) with their targets (or "none"), verification output trimmed with `--query`. No credentials, tokens or presigned URLs.

## References

- `skills/nubia-bedrock/SKILL.md` (Bedrock as a Nub-IA provider)
- `docs/permission-modes.md`
