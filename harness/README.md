# Deterministic Harness

`harness/` contains repository-controlled mechanics for Startup Opportunity research. It validates, persists, versions, compares, checkpoints, recovers, and renders caller-supplied typed Artifacts. It never performs open-ended research, hidden model calls, agent dispatch, network access, benchmark execution, or recommendation synthesis.

The public entry is:

```sh
npm run harness -- <command>
```

Run `npm run harness -- help` for the complete command list and `npm run harness -- doctor --json` before relying on a checkout. `create-run`, read-only `status-run`, recovery-oriented `load-run`, Evidence/Artifact publication, plan validation/adaptation, comparison, traceability, report materialization, and checkpoints all consume explicit inputs and validated on-disk state.

The G4 local Evidence MCP adapter is a narrow transport over the existing `EvidenceStore` API. `record_evidence` persists caller-supplied bytes; `get_evidence_manifest` returns validated substrate records. The server does not fetch a source, infer provenance, evaluate Evidence quality, form a Claim, or dispatch an agent. Its stdio registration and approval policy live in `.codex/config.toml`.

Project hooks are optional lifecycle guardrails. They do not write formal `events.jsonl`, route mode, create plans, advance Run status, retry work, or build reports. Disabling hooks leaves all explicit Skill and Harness commands available.

Schema bundle `16.0.0`, immutable v1-v17 envelopes/document bundles, receipts, and policies preserve the accepted G0-G3 contracts while adding the versioned terminal-reporting contract. A terminal adaptation requires a caller-supplied main-agent source and deterministically materializes `report.json`, `decision-brief.md`, and `report.md`; `status-run` separately reports execution disposition and terminal report delivery. Mechanical success never proves Evidence truth, sufficiency, external validation, market demand, decision readiness, or product viability.
