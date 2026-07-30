# Startup Opportunity Research Harness

This repository is the repo-backed control layer for evidence-based Startup Opportunity research in Codex. Codex owns reasoning, interaction, tools, and subagent sessions. The deterministic Harness owns Run state, immutable Artifact publication, Evidence storage, validation, plan adaptation, checkpoints, recovery, comparison, and report consistency.

Formal research enters through the repo-local `$startup-opportunity` Skill. The same Skill and project configuration are used from Codex Desktop, CLI, and IDE integrations.

## Install

The implementation stack is frozen to TypeScript `7.0.2`, Node.js `24.18.x`, npm `11.16.x`, and the single npm lockfile v3. Use a version manager that reads `.node-version`, then install the exact dependency graph and validate the checkout:

```sh
npm ci
npm run harness -- doctor --json
```

The repository enables npm engine checks. Installation fails when the active Node/npm pair is outside the frozen versions.

Codex loads `.codex/config.toml`, the three project agents, optional hooks, and the local Evidence MCP server only for a trusted project. The MCP server uses stdio, receives no credentials, exposes only `record_evidence` and `get_evidence_manifest`, and cannot fetch a URL or form a research judgment.

See [Operations](docs/operations.md) for clean-checkout setup, trust, hooks-disabled operation, recovery, and surface-specific launch notes.

## Use

Invoke the Skill in Codex and provide one explicit action:

```text
$startup-opportunity

action: discover
query: pet care apps for households in one primary market
```

```text
$startup-opportunity

action: assess
query: Should independent travelers use a conflict checker before booking an itinerary?
```

```text
$startup-opportunity

action: resume
run_id: RUN_ID
instruction: Reopen from the latest validated checkpoint.
```

```text
$startup-opportunity

action: status
run_id: RUN_ID
```

`discover` creates an `opportunity_discovery` Run and `assess` creates a `concept_evidence_assessment` Run. `resume` explicitly validates and reconciles persisted state. `status` is read-only and never starts a subagent. If action selection would change the output contract, Codex must clarify before creating a Run.

[Sample Runs](docs/sample-runs.md) provides executable, synthetic walkthroughs. Its `.invalid` sources and fixture text are unverified and are not Evidence truth, market data, external validation, or product viability claims.

## Explicit Harness

Hooks and MCP improve guardrails and handoff ergonomics, but neither is a correctness dependency. The explicit entrypoints remain available when hooks are disabled or the local MCP server is unavailable:

```sh
npm run harness -- help
npm run harness -- doctor --json
npm run harness -- create-run --run-id RUN_ID --mode concept_evidence_assessment
npm run harness -- status-run --run-id RUN_ID
npm run harness -- load-run --run-id RUN_ID
npm run harness -- record-evidence --run-id RUN_ID --unit-id UNIT_ID --source-url URL --research-goal GOAL --content-file FILE
npm run harness -- validate-artifact --file path/to/document.json --json
npm run harness -- validate-plan --bundle path/to/document-bundle.json --json
npm run harness -- publish-artifact --file path/to/envelope-or-bundle.json
npm run harness -- checkpoint-run --file path/to/checkpoint-input.json
npm run harness -- analyze-gaps --file path/to/gap-analysis-input.json --json
npm run harness -- validate-adaptation --bundle path/to/document-bundle.json --json
npm run harness -- apply-plan-revision --file path/to/apply-input.json --json
npm run harness -- calculate-comparison --bundle path/to/document-bundle.json --json
npm run harness -- calculate-sensitivity --bundle path/to/document-bundle.json --json
npm run harness -- audit-traceability --bundle path/to/document-bundle.json --json
npm run harness -- build-report --file path/to/build-report-input.json --json
```

Command success proves mechanical validity only. It does not establish Evidence truth, sufficiency, market demand, recommendation readiness, external validation, or startup success.

## Recovery

Run data lives under `runs/<run_id>/` and is ignored by Git. `manifest.json` is the atomically replaced current index; plans, formal envelopes, checkpoints, and operation receipts are immutable. Reopen only through `load-run`, which validates durable state, repairs supported incomplete tails, reconciles completed operations, and fails closed on integrity conflicts. Completed Runs are not rewritten in place; use a continuation Run for refreshed Evidence or a changed decision.

## Development

Use the frozen runtime for every command:

```sh
npm run lint
npm run typecheck
npm test
npm run validate:schemas
npm run validate:fixtures
npm run validate:store
npm run test:faults
npm run test:recovery
npm run test:g4
npm run test:g4:clean
npm run verify:skeleton
```

The architecture authority is `startup-opportunity-codex-research-harness.md`. Implementation state and accepted verification evidence live in `startup-opportunity-implementation-progress.md`.

## Boundaries

- The Harness never dispatches agents, calls an LLM, executes research lanes, benchmarks a model, accesses the network, or synthesizes open-ended judgments.
- Chat replies and subagent completion summaries are not formal Artifacts.
- External sources used by formal Claims must enter the Evidence Store with explicit provenance and limitations.
- Hooks do not route modes, advance state, retry work, or synthesize reports.
- The MCP adapter does not judge an opportunity, recommend a product, or replace Codex permissions and thread lifecycle.
- The system does not execute interviews, landing pages, deposits, advertising, paid experiments, MVP tests, or other external validation.
- No general workflow runtime, DAG DSL, daemon, UI, or database is part of this repository.
- The repo-local G4 operational exit received an independent PASS for exact candidate `060029fbcfc6e4b543873642b7e3657c67c913af`. This documentation/current-state repair is a direct descendant and requires a fresh independent whole-G4 acceptance created by the controller before it replaces that accepted candidate.
- The G4 result covers only the repo-local operational exit. It does not establish that the project-wide RFC sections 29 and 30 completion scope is complete; that requires a separate independent completion-scope audit.
