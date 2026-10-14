---
name: nubia-bedrock
description: "Trigger: Bedrock, Amazon Bedrock, AWS credentials for Nub-IA, nub-ia/strong resolves nothing, client data must stay in our AWS account, CI review with Bedrock. Configure and verify Amazon Bedrock as a Nub-IA model provider, locally and in CI, with the allowlist that keeps code inside the account."
license: MIT
metadata:
  author: nubiral
  version: "1.0"
---

# Nub-IA on Amazon Bedrock

## Activation Contract

Use when a session, a repository or a CI job must run Nub-IA models through Amazon Bedrock, or when `/nubia:doctor` reports a tier that resolves nothing while Bedrock credentials are expected.

## Hard Rules

- Bedrock needs no `/login`: Pi reads the standard `AWS_*` variables or `~/.aws` profiles. Never write access keys into a file in the repository or into `settings.json`; the secret redactor will mask them, but the leak is already done.
- A client requirement that code must not leave the company's AWS account is a policy, not a habit: set `"allowedProviders": ["amazon-bedrock"]` in `.pi/nub-ia/model-tiers.json` (or the organisation policy) so `/model` cannot bypass it.
- Bedrock model ids are region-prefixed (`us.anthropic.claude-…`); the tier patterns already match `us.`, `global.`, `eu.` and the bare `anthropic.` form. Do not hand-edit ids into agent frontmatter; pin through `/nubia:models` if a pin is really needed.
- In CI, use the job's assumed role (OIDC) over long-lived keys.

## Decision Gates

- No credentials → stop: ask the human which profile/role to use; never search the filesystem for keys.
- `/nubia:doctor` says `warn: Tier … falls back` with Bedrock present → the account lacks model access for that family, or the region differs; report it, do not swap tiers silently.
- Requirement is "only Bedrock" → add the allowlist to the repository policy and verify with `/nubia:doctor` before any model call.

## Execution Steps

1. Verify identity: `aws sts get-caller-identity` (read-only; allowed in every permission mode).
2. Set `AWS_REGION` (or `AWS_DEFAULT_REGION`) to a region where the Claude models are enabled for the account.
3. Run `/nubia:doctor`; confirm `Providers with credentials` lists `amazon-bedrock` and each tier resolves to an `amazon-bedrock/…` model when Bedrock is the only or preferred provider.
4. For a Bedrock-only repository, write `.pi/nub-ia/model-tiers.json` from `model-tiers.json.example` (`nub-ia init`) with `allowedProviders: ["amazon-bedrock"]`; commit it.
5. For CI reviews, set `AWS_*` from the job's role and run `nub-ia review --base origin/<default> --json` (see `docs/review-ci.md`).

## Output Contract

Report: region, caller identity (account id only, never the ARN's user name if it is a person), the `/nubia:doctor` tier lines, and the policy file changed. Never paste credentials or `AWS_SESSION_TOKEN` values.

## References

- `README.md` → Router de modelos por tier · Allowlist
- `docs/review-ci.md`
- `docs/governance.md`
