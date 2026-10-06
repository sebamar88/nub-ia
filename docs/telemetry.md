# Runtime metrics

Nub-IA aggregates runtime usage (tokens, durations, model and agent class) in process in
`lib/runtime-metrics.ts` and `extensions/runtime-metrics.ts`. The external `gentle-ai`
binary that used to receive these events was removed, so nothing leaves the machine:
without an injected `send` callback the aggregated rows are dropped.

- Opt-outs are honored regardless: `DO_NOT_TRACK`, `CI`, `GITHUB_ACTIONS`, and
  `GENTLE_AI_TELEMETRY=0` disable collection entirely (`lib/runtime-metrics-policy.ts`).
- Delegated children report through the parent (`lib/runtime-metrics-children.ts`); they never
  send independently.
- Rows are event-local, never cumulative session totals, and an occupied attempt slot discards
  the event instead of queueing it. The row schema is `lib/runtime-metrics-schema.json`.
