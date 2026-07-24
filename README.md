# Startup Opportunity Research Harness

This repository is the repo-backed, deterministic control layer for the Codex-native Startup Opportunity research workflow. Codex owns reasoning, tools, interaction, and subagent sessions; this Harness owns published core Artifact contracts, validated Run state, immutable Artifact publication, the Evidence storage substrate, checkpoints, and bounded Plan/Adaptation mechanics.

The repository is currently at the G0.4 implementation candidate boundary. In addition to the G0.3 Store, the Harness now provides deterministic Research Plan semantic validation, machine Gap Snapshot drafts, closed Adaptation Decision v2 policy validation, and CAS-safe immutable Plan Revision application with retry, supersede, late Artifact exclusion, idempotency, and crash recovery. Research actions, Evidence judgment records, comparison, reporting, and G1+ domain artifacts remain unavailable until their owning slices are completed.

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
npm run test:g0.4
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
npm run harness -- validate-plan --bundle path/to/document-bundle.json --json
npm run harness -- analyze-gaps --file path/to/gap-analysis-input.json --json
npm run harness -- validate-adaptation --bundle path/to/document-bundle.json --json
npm run harness -- apply-plan-revision --file path/to/apply-input.json --runs-root path/to/runs --json
```

`doctor` verifies required files, ownership documents, the single lockfile rule, and frozen package metadata. `validate-artifact` preserves the versioned schema/reference contracts. G0.4 commands return structured success or failure and consume only explicit files and validated Run state; they do not make hidden model calls. Store success proves mechanical persistence only; Plan/Adaptation success proves only closed mechanical preconditions. Neither establishes Evidence sufficiency, decision readiness, research completion, or Gate completion.

## Repository Layout

- `AGENTS.md`: durable repository rules and validation commands.
- `.agents/skills/startup-opportunity/`: the repo-local Skill, progressive-disclosure references, and explicit script entrypoints.
- `.codex/agents/`: lane researcher, evidence auditor, and adversarial reviewer role contracts.
- `harness/src/`: deterministic TypeScript entry, repository contract, schema/reference validator, Run/Artifact/Evidence stores, and G0.4 Plan/Adaptation runtime.
- `harness/schemas/`: immutable Draft 2020-12 schema bundles through `2.2.0`; v3 is limited to G0.4 control envelopes and Document Bundles.
- `harness/policies/`, `harness/templates/`, `harness/evals/`: owned landing zones for later policies, reporting, and non-schema evaluators.
- `tests/`: executable repository, schema/reference, real-filesystem store, fault, and recovery tests.
- `runs/`: ignored runtime data boundary; only `.gitkeep` is committed.

The architecture authority is `startup-opportunity-codex-research-harness.md`. Live slice status, accepted commits, verification evidence, and the only allowed next slice live in `startup-opportunity-implementation-progress.md`.

## Current Boundaries

The G0.3 Store entries and G0.4 `validate-plan`, `analyze-gaps`, `validate-adaptation`, and `apply-plan-revision` entries are operational. They do not make `discover`, `assess`, `resume`, or `status` complete research workflows. `load-run` performs deterministic reopen/recovery; it does not restart agents or infer research judgment. Every downstream reserved script still fails with a machine-readable message naming its owning future slice.

Formal envelopes are immutable after publication. Their `content_hash` is SHA-256 over the UTF-8 canonical JSON of `document`, with object keys recursively sorted by code unit and arrays preserved in order. `manifest.json` is the explicitly mutable current index and is replaced atomically; checkpoints preserve immutable manifest snapshots. Bundle `2.2.0` adds only the G0.4 v3 control envelope/Document Bundle and apply policy. v1 receipts remain valid for v1 envelopes; v2 receipts publish v2/v3 envelopes. Planning Context v1 and Adaptation Decision v1 are read-only, `future_declared` output schemas remain unpublishable, and partial retry fails closed. The Harness does not create Claim/Finding/Insight objects, judge research quality, provide research/reporting execution, or implement a general workflow engine, daemon, UI, database, external validation execution, Plugin, hook, or MCP integration.
