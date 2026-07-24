# Startup Opportunity Research Harness

This repository is the repo-backed, deterministic control layer for the Codex-native Startup Opportunity research workflow. Codex owns reasoning, tools, interaction, and subagent sessions; this Harness owns the published core artifact contracts and will own validated run state, bounded plan changes, checkpoints, comparison, and report assembly as later ledger slices open.

The repository is currently at the G0.2 core schema boundary. Repository discovery, toolchain checks, Skill/reference routing, custom-agent contracts, the versioned core JSON Schema bundle, and deterministic schema/typed-reference validation are runnable. Run storage, artifact publication, recovery, plan/adaptation policy, research actions, and reporting remain unavailable until their owning slices are completed.

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
npm run verify:skeleton
```

The Harness entry is also directly inspectable:

```sh
npm run harness -- help
npm run harness -- doctor --json
npm run harness -- validate-artifact --schema-bundle --json
npm run harness -- validate-artifact --file path/to/document.json --json
npm run harness -- validate-artifact --bundle path/to/document-bundle.json --json
```

`doctor` verifies required files, non-empty ownership documents, the single lockfile rule, and the frozen package metadata. `validate-artifact` validates one published document contract, validates all known typed references in an explicitly supplied document bundle, or verifies that every internal schema `$ref` resolves. Results are structured and deterministic. Schema validity does not establish evidence sufficiency, decision readiness, publication, or Gate completion.

## Repository Layout

- `AGENTS.md`: durable repository rules and validation commands.
- `.agents/skills/startup-opportunity/`: the repo-local Skill, progressive-disclosure references, and explicit script entrypoints.
- `.codex/agents/`: lane researcher, evidence auditor, and adversarial reviewer role contracts.
- `harness/src/`: deterministic TypeScript entry, repository contract, and schema/reference validator.
- `harness/schemas/v1/`: versioned Draft 2020-12 core schema bundle and bundle manifest.
- `harness/policies/`, `harness/templates/`, `harness/evals/`: owned landing zones for later policies, reporting, and non-schema evaluators.
- `tests/`: executable repository and schema/reference contract tests with positive and negative fixtures.
- `runs/`: ignored runtime data boundary; only `.gitkeep` is committed.

The architecture authority is `startup-opportunity-codex-research-harness.md`. Live slice status, accepted commits, verification evidence, and the only allowed next slice live in `startup-opportunity-implementation-progress.md`.

## Current Boundaries

The Skill exposes the RFC action vocabulary (`discover`, `assess`, `resume`, and `status`) for routing, but G0.2 does not create or load Runs. `doctor` and `validate-artifact` are operational. Every other reserved script entrypoint fails with a machine-readable message naming its owning future slice and must not be treated as successful research execution.

The validator does not create directories, publish artifacts, append JSONL records, compute content hashes, checkpoint or recover a Run, enforce the full Research Plan/adaptation policy, or judge research quality. This repository also does not provide a general workflow engine, a Web UI, external validation execution, cross-market ranking, runtime comparison reweighting, an agent-cost ledger, Plugin packaging, hooks, or MCP integration at this stage.
