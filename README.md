# Startup Opportunity Research Harness

This repository is the repo-backed, deterministic control layer for the Codex-native Startup Opportunity research workflow. Codex owns reasoning, tools, interaction, and subagent sessions; this Harness owns published core Artifact contracts, validated Run state, immutable Artifact publication, the Evidence storage substrate, checkpoints, and bounded Plan/Adaptation mechanics.

The repository has a G2 Opportunity Discovery implementation exit candidate pending independent whole-gate regression. Schema bundle `11.0.0` retains accepted G0-G2.3 contracts and adds caller-supplied G2.4 enrichment, Business Engine, hard gates, four-panel comparison, sensitivity, partial order, portfolio, recommendation, traceability, and discovery reporting through v12 publication with receipt v10. The deterministic Harness validates, publishes, checkpoints, recovers, summarizes validated comparison/sensitivity Artifacts, and materializes report views; it does not dispatch agents, synthesize research or decision semantics, perform network research, or infer provenance, independence, bias, freshness, Evidence quality, or validation success. G3+ remains unavailable.

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
npm run test:g1.1
npm run test:g1.2
npm run test:g1.3
npm run test:g1.4
npm run test:g2.1
npm run test:g2.2
npm run test:g2.3
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
npm run harness -- record-evidence --run-id RUN_ID --unit-id UNIT_ID --source-url URL --research-goal GOAL --content-file FILE
npm run harness -- record-evidence --run-id RUN_ID --unit-id UNIT_ID --source-uri URN --research-goal GOAL --content-file FILE
npm run harness -- publish-artifact --file path/to/envelope-or-envelope-bundle.json
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
- `harness/src/`: deterministic TypeScript entry, repository contract, schema/reference validators through G2.3, Run/Artifact/Evidence stores, reporting, and bounded Plan/Adaptation runtime.
- `harness/schemas/`: immutable Draft 2020-12 compatibility bundles plus default bundle `10.0.0`; v11 adds the G2.3 synthesis publication surface without rewriting accepted upstream bytes.
- `harness/policies/`, `harness/templates/`, `harness/evals/`: owned landing zones for later policies, reporting, and non-schema evaluators.
- `tests/`: executable repository, schema/reference, real-filesystem store, fault, and recovery tests.
- `runs/`: ignored runtime data boundary; only `.gitkeep` is committed.

The architecture authority is `startup-opportunity-codex-research-harness.md`. Live slice status, accepted commits, verification evidence, and the only allowed next slice live in `startup-opportunity-implementation-progress.md`.

## Current Boundaries

The accepted G0/G1 mechanics, G2.1 maps, G2.2 discovery lane/fan-in runtime, and caller-supplied G2.3 synthesis publication are operational. `validate-artifact` and `publish-artifact` apply their exact versioned envelope/bundle adapters; v11 accepts executable conversion v2 and formal synthesis only after the closed cross-artifact contract passes. This does not make `discover`, `assess`, `resume`, or `status` complete research workflows. `load-run` performs deterministic reopen/recovery; it does not restart agents or infer research judgment. Every downstream reserved script still fails with a machine-readable message naming its owning future slice.

Formal envelopes are immutable after publication. Their `content_hash` is SHA-256 over canonical `document` JSON. `manifest.json` is the atomically replaced current index; checkpoints preserve immutable snapshots. Receipt v1-v9 map exactly to their published envelope adapters. G2.3 formalization does not mutate pre-thesis candidates and does not establish Evidence sufficiency, external validation, or market success. Evidence Store materialization keeps mechanical substrate fields separate from Agent-attested origin/provenance/freshness/independence/bias fields. Partial retry remains fail closed. No general workflow engine, daemon, UI, database, external validation execution, Plugin, hook, or MCP integration is implemented.
