# Startup Opportunity Research Harness

This repository is the repo-backed control layer for evidence-based Startup Opportunity research in Codex. Codex owns reasoning, interaction, tools, and subagent sessions. The deterministic Harness owns Run state, immutable Artifact publication, Evidence storage, validation, plan adaptation, checkpoints, recovery, comparison, and report consistency. Final reporting derives `report.json`, a bounded `decision-brief.md`, the core `report.md`, and the complete `audit-appendix.md` from one report authority.

Formal research enters through the repo-local `$startup-opportunity` Skill. The same Skill and project configuration are used from Codex Desktop, CLI, and IDE integrations.

## Install

The implementation stack is frozen to TypeScript `7.0.2`, Node.js `24.18.x`, npm `11.16.x`, and the single npm lockfile v3. Use a version manager that reads `.node-version`, then install the exact dependency graph and validate the checkout:

```sh
npm ci
npm run harness -- doctor --json
```

The repository enables npm engine checks. Installation fails when the active Node/npm pair is outside the frozen versions.
The same pair is also declared through npm `devEngines`, so `npm run` commands fail before execution when a shell has drifted to another Node or npm release.

Codex loads `.codex/config.toml`, the three project agents, optional hooks, and the local Evidence MCP server only for a trusted project. The MCP server uses stdio and receives no credentials. The main-agent configuration exposes prompt-approved `create_run`, `propose_scope`, `confirm_scope`, and `record_evidence` operations plus read-only `get_evidence_manifest`; project agents receive narrower role-specific allow-lists. The server cannot fetch a URL or form a research judgment.

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
npm run harness -- create-run --run-id RUN_ID --mode concept_evidence_assessment --geography GEO --customer-model b2c --target-user USER --decision-goal GOAL --research-language LANG
npm run harness -- confirm-scope --run-id RUN_ID --expected-scope-proposal-revision N --expected-scope-proposal-ref REF --expected-scope-proposal-hash HASH --user-confirmation-attestation TEXT
npm run harness -- propose-scope --run-id RUN_ID --expected-scope-revision N --geography GEO --customer-model b2c --target-user USER --decision-goal GOAL --research-language LANG --reason REASON
npm run harness -- status-run --run-id RUN_ID
npm run harness -- load-run --run-id RUN_ID
npm run harness -- create-research-handoff --file path/to/research-handoff-input.json
npm run harness -- read-research-handoff --run-id RUN_ID --handoff-ref REF --item-id ITEM_ID
npm run harness -- record-evidence --run-id RUN_ID --unit-id UNIT_ID --source-url URL --research-goal GOAL --content-file FILE
npm run harness -- validate-artifact --file path/to/document.json --json
npm run harness -- validate-plan --bundle path/to/document-bundle.json --json
npm run harness -- publish-artifact --file path/to/envelope-or-bundle.json
npm run harness -- compile-artifacts --file path/to/runtime-artifact-compilation-request.json
npm run harness -- materialize-formal-stage --file path/to/formal-stage-materialization-request.json
npm run harness -- materialize-lane-result --file path/to/lane-staging-document.json
npm run harness -- scaffold-lane-submission --run-id RUN_ID --task-ref REF
npm run harness -- checkpoint-run --file path/to/checkpoint-input.json
npm run harness -- analyze-gaps --file path/to/gap-analysis-input.json --json
npm run harness -- validate-adaptation --bundle path/to/document-bundle.json --json
npm run harness -- apply-plan-revision --file path/to/apply-input.json --json
npm run harness -- author-plan-adaptation --file path/to/adaptation-author-request.json --runs-root path/to/runs --json
npm run harness -- calculate-comparison --bundle path/to/document-bundle.json --json
npm run harness -- calculate-sensitivity --bundle path/to/document-bundle.json --json
npm run harness -- audit-traceability --bundle path/to/document-bundle.json --json
npm run harness -- build-report --file path/to/build-report-input.json --json
```

Command success proves mechanical validity only. It does not establish Evidence truth, sufficiency, market demand, recommendation readiness, external validation, or startup success.

For Discovery G2.1 setup, dispatch waves, G2.2 fan-in, and G2.3 synthesis, Main Agent submits explicit research semantics to `materialize-formal-stage`: first `validate_only` to obtain a zero-write exact `publication_plan`, then `publish` with the same request and that exact plan. The Harness derives paths, revisions, refs, hashes, Run/Plan/Task bindings, envelopes, and atomic publication order; it does not dispatch agents or infer research judgments. `compile-artifacts` remains the generic formal Artifact surface outside those stage-specific paths.

Normal research Runs use doctor once plus the workflow's targeted Artifact, Plan, adaptation, traceability, report, and status checks. The full repository test suite is reserved for engineering changes and is not part of an ordinary research Run.

## Recovery

Run data lives under `runs/<run_id>/` and is ignored by Git. `manifest.json` is the atomically replaced current index; plans, formal envelopes, checkpoints, and operation receipts are immutable. `create-run` appends an exact Scope proposal to `decisions.jsonl` and leaves the Run at `awaiting_scope_confirmation`. After that exact revision/ref/hash has been shown to the user, `confirm-scope` records only caller-attested confirmation; the Harness cannot authenticate chat identity and discloses that boundary. A correction uses `propose-scope` followed by a separate exact-bound `confirm-scope`; prior records are never replaced, and research remains blocked until the corrected Scope is reconciled through Gap/Decision/Plan. A user-authorized prior current-contract Run may enter only through `create-research-handoff`, which captures exact source bytes into the target Run and never inherits Plan, Task, Gate, ranking, execution, or terminal state. Discovery handoffs bind the current Plan; an Assessment pre-Plan handoff is Harness-marked and may only form the initial intake Concept before normal Plan publication. `read-research-handoff` reads only named items from that target-owned Artifact. Reopen only through `load-run`, which validates durable state, repairs supported incomplete tails, reconciles completed operations, and fails closed on integrity conflicts without needing the source Run. A genuinely new market, language, decision scope, or later refresh uses a new current-contract Run. Terminal reporting always finishes on the original Run.

Search allocation percentages are planning guidance, not query-count or deadline Gates. Actual adopted-source distribution is derived from the Evidence Register, and deviations are observable only. Ranking requires current, direct, dimension-specific commercial coverage; academic material cannot replace buyer, pricing, distribution, retention, or unit-economics evidence, and vendor-only support remains a low-confidence unranked hypothesis.

## Development

Use the frozen runtime for every command:

```sh
npm run lint
npm run typecheck
npm test
npm run validate:schemas
npm run validate:current-contract
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
- Implementation closure does not establish Evidence truth, completed research or external validation, market demand, product viability, recommendation readiness, or startup success.
