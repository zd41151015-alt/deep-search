# Startup Opportunity Research Harness

This repository is the repo-backed, deterministic control layer for the Codex-native Startup Opportunity research workflow. Codex owns reasoning, tools, interaction, and subagent sessions; this Harness owns the published core artifact contracts, validated Run state, immutable artifact publication, Evidence storage substrate, checkpoints, and later bounded plan, comparison, and report mechanics.

The repository is currently at the G0.3 store and recovery boundary. Repository checks, the unchanged versioned core JSON Schema bundle, typed-reference validation, confined Run creation/reopen, immutable formal artifact publication, Event/Decision append, Evidence raw-content deduplication, checkpointing, and crash recovery are runnable. Plan/adaptation policy, research actions, Evidence judgment records, comparison, and reporting remain unavailable until their owning slices are completed.

## Toolchain

The only implementation stack is:

- TypeScript `7.0.2` on Node.js `24.18.x` LTS.
- npm `11.16.x`.
- `package-lock.json` lockfile v3.

Use a version manager that reads `.node-version`, or put the Homebrew Node 24 binary first on `PATH`. Then install exactly the locked dependency graph:

```sh
npm ci
```

The repository enables npm engine checks, so an unsupported Node/npm pair fails during installation instead of silently creating a second baseline.

## Development Commands

```sh
npm run lint
npm run typecheck
npm test
npm run validate:schemas
npm run validate:fixtures
npm run validate:store
npm run test:faults
npm run test:recovery
npm run verify:skeleton
```

The Harness entry is also directly inspectable:

```sh
npm run harness -- help
npm run harness -- doctor --json
npm run harness -- validate-artifact --schema-bundle --json
npm run harness -- validate-artifact --file path/to/document.json --json
npm run harness -- validate-artifact --bundle path/to/document-bundle.json --json
npm run harness -- create-run --run-id RUN_ID --mode concept_evidence_assessment
npm run harness -- load-run --run-id RUN_ID
npm run harness -- record-evidence --run-id RUN_ID --unit-id UNIT_ID --url URL --research-goal GOAL --content-file FILE
npm run harness -- checkpoint-run --file path/to/checkpoint-input.json
```

`doctor` verifies required files, ownership documents, the single lockfile rule, and frozen package metadata. `validate-artifact` provides the unchanged G0.2 schema/reference contract. Store commands return structured results and fail closed on invalid paths, symlinks, hashes, references, operation replay, JSONL corruption, or checkpoint divergence. Store success proves mechanical persistence only; it does not establish evidence sufficiency, decision readiness, research completion, or Gate completion.

## Repository Layout

- `AGENTS.md`: durable repository rules and validation commands.
- `.agents/skills/startup-opportunity/`: the repo-local Skill, progressive-disclosure references, and explicit script entrypoints.
- `.codex/agents/`: lane researcher, evidence auditor, and adversarial reviewer role contracts.
- `harness/src/`: deterministic TypeScript entry, repository contract, schema/reference validator, and Run/Artifact/Evidence stores.
- `harness/schemas/v1/`: versioned Draft 2020-12 core schema bundle and bundle manifest.
- `harness/policies/`, `harness/templates/`, `harness/evals/`: owned landing zones for later policies, reporting, and non-schema evaluators.
- `tests/`: executable repository, schema/reference, real-filesystem store, fault, and recovery tests.
- `runs/`: ignored runtime data boundary; only `.gitkeep` is committed.

The architecture authority is `startup-opportunity-codex-research-harness.md`. Live slice status, accepted commits, verification evidence, and the only allowed next slice live in `startup-opportunity-implementation-progress.md`.

## Current Boundaries

The G0.3 `create-run`, `load-run`, `record-evidence`, and `checkpoint-run` entries are operational. They do not make `discover`, `assess`, `resume`, or `status` complete research workflows. `load-run` performs deterministic reopen/recovery; it does not restart agents or infer research judgment. Every downstream reserved script still fails with a machine-readable message naming its owning future slice.

Formal envelopes are immutable after publication. Their `content_hash` is SHA-256 over the UTF-8 canonical JSON of `document`, with object keys recursively sorted by code unit and arrays preserved in order. `manifest.json` is the explicitly mutable current index and is replaced atomically; checkpoints preserve immutable manifest snapshots. G0.3 does not enforce the full Research Plan/adaptation policy, create Claim/Finding/Insight objects, judge research quality, or provide research/reporting execution. It also does not provide a general workflow engine, Web UI, external validation execution, cross-market ranking, runtime comparison reweighting, agent-cost ledger, Plugin packaging, hooks, or MCP integration.
