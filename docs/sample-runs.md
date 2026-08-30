# Synthetic Sample Runs

These walkthroughs exercise repository mechanics only. Every sample source is `.invalid` or a reserved user-provided URN, fixture bytes are explicitly `SYNTHETIC / UNVERIFIED`, and no result is Evidence truth, market data, a user quote, external validation, product viability, or a recommendation.

## Discover

Invoke the Skill:

```text
$startup-opportunity

action: discover
query: Explore recurring household pet-care tasks in one primary market.
market: US
language: en-US
```

After Codex presents `action=discover` and `mode=opportunity_discovery`, a deterministic Run boundary can be created with:

```sh
npm run harness -- create-run \
  --run-id sample-discover-unverified \
  --mode opportunity_discovery \
  --created-at 2026-07-30T00:00:00Z
```

The Skill must next publish caller-authored Intake, DecisionContext, ScopeFrame, and a validated research Plan before any bounded lane work. The Harness does not invent that content.

## Assess

Invoke the Skill:

```text
$startup-opportunity

action: assess
query: Assess a pre-booking itinerary conflict checker for independent travelers.
market: US
language: en-US
```

Create and inspect the Run:

```sh
npm run harness -- create-run \
  --run-id sample-assess-unverified \
  --mode concept_evidence_assessment \
  --created-at 2026-07-30T00:00:00Z

npm run harness -- status-run --run-id sample-assess-unverified
```

Record synthetic caller-supplied bytes without MCP:

```sh
npm run harness -- record-evidence \
  --run-id sample-assess-unverified \
  --unit-id unit-synthetic-example \
  --unit-attempt 1 \
  --source-url https://example.invalid/g4-synthetic-unverified \
  --acquisition-goal "Exercise deterministic Evidence handoff only." \
  --content-file tests/fixtures/g4/synthetic-evidence.txt \
  --recorded-at 2026-07-30T00:01:00Z
```

The equivalent MCP call supplies the same fields, optional `unit_attempt`, and raw content to `record_evidence`. It does not fetch `example.invalid`.

## Resume And Status

Use the Skill actions for an existing Run:

```text
$startup-opportunity

action: status
run_id: sample-assess-unverified
```

```text
$startup-opportunity

action: resume
run_id: sample-assess-unverified
instruction: Continue from the latest validated checkpoint.
```

The explicit deterministic equivalents are:

```sh
npm run harness -- status-run --run-id sample-assess-unverified
npm run harness -- load-run --run-id sample-assess-unverified
```

`status-run` is read-only. `load-run` performs validation and supported recovery. Neither starts a subagent or forms a research judgment.
