# Startup Opportunity Research Harness

This repository is the repo-backed, deterministic control layer for the Codex-native Startup Opportunity research workflow. Codex owns reasoning, tools, interaction, and subagent sessions; this Harness will own validated run state, evidence and artifact contracts, bounded plan changes, checkpoints, comparison, and report assembly.

The repository is currently at the G0.1 skeleton boundary. Repository discovery, toolchain checks, Skill/reference routing, and custom-agent contracts are runnable. Research actions and the schema/store/adaptation/reporting implementations are intentionally unavailable until their owning slices are completed.

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
npm run verify:skeleton
```

The Harness entry is also directly inspectable:

```sh
npm run harness -- help
npm run harness -- doctor --json
```

`doctor` verifies required files, non-empty ownership documents, the single lockfile rule, and the frozen package metadata. It does not validate research artifacts; that belongs to G0.2.

## Repository Layout

- `AGENTS.md`: durable repository rules and validation commands.
- `.agents/skills/startup-opportunity/`: the repo-local Skill, progressive-disclosure references, and explicit script entrypoints.
- `.codex/agents/`: lane researcher, evidence auditor, and adversarial reviewer role contracts.
- `harness/src/`: deterministic TypeScript entry and repository contract.
- `harness/schemas/`, `harness/policies/`, `harness/templates/`, `harness/evals/`: owned landing zones for later slices, each with a non-empty boundary contract.
- `tests/`: executable skeleton contract tests plus future fixture/eval landing zones.
- `runs/`: ignored runtime data boundary; only `.gitkeep` is committed.

The architecture authority is `startup-opportunity-codex-research-harness.md`. Live slice status, accepted commits, verification evidence, and the only allowed next slice live in `startup-opportunity-implementation-progress.md`.

## Current Boundaries

The Skill exposes the RFC action vocabulary (`discover`, `assess`, `resume`, and `status`) for routing, but G0.1 does not create or load Runs. Reserved script entrypoints fail with a machine-readable message naming the owning future slice. They must not be treated as successful research execution.

This repository does not provide a general workflow engine, a Web UI, external validation execution, cross-market ranking, runtime comparison reweighting, an agent-cost ledger, Plugin packaging, hooks, or MCP integration at this stage.
