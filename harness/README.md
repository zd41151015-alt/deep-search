# Deterministic Harness

`harness/` contains repository-controlled mechanics for Startup Opportunity research. It validates, persists, versions, compares, checkpoints, recovers, and renders caller-supplied typed Artifacts. It never performs open-ended research, hidden model calls, agent dispatch, network access, benchmark execution, or recommendation synthesis.

The public entry is:

```sh
npm run harness -- <command>
```

Run `npm run harness -- help` for the complete command list and `npm run harness -- doctor --json` before relying on a checkout. `create-run`, read-only `status-run`, recovery-oriented `load-run`, Evidence/Artifact publication, plan validation/adaptation, comparison, traceability, report materialization, and checkpoints all consume explicit inputs and validated on-disk state.

The G4 local Evidence MCP adapter is a narrow transport over the existing `EvidenceStore` API. `record_evidence` persists caller-supplied bytes; `get_evidence_manifest` returns validated substrate records. The server does not fetch a source, infer provenance, evaluate Evidence quality, form a Claim, or dispatch an agent. Its stdio registration and approval policy live in `.codex/config.toml`.

Project hooks are optional lifecycle guardrails. They do not write formal `events.jsonl`, route mode, create plans, advance Run status, retry work, or build reports. Disabling hooks leaves all explicit Skill and Harness commands available.

The current schema bundle is `18.0.0`. It accepts new Runs produced by the current compiler and includes the v19 Assessment execution surface: a frozen v2 Thesis, an execution overlay, bounded dispatch, task-bound `assessment_evidence.v1`, lane results, controlled follow-up, and terminal stage gates. A terminal gate can intentionally skip later stages while projecting research conclusion separately from execution completeness and runtime health. Terminal reporting still requires a caller-supplied main-agent source and deterministically materializes `report.json`, `decision-brief.md`, and `report.md`. Mechanical success never proves Evidence truth, sufficiency, external validation, market demand, decision readiness, or product viability.
