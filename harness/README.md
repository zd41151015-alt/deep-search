# Deterministic Harness

`harness/` contains repository-controlled mechanics for Startup Opportunity research. It validates, persists, versions, compares, checkpoints, recovers, and renders caller-supplied typed Artifacts. It never performs open-ended research, hidden model calls, agent dispatch, network access, benchmark execution, or recommendation synthesis.

The public entry is:

```sh
npm run harness -- <command>
```

Run `npm run harness -- help` for the complete command list and `npm run harness -- doctor --json` before relying on a checkout. `create-run`, read-only `status-run`, recovery-oriented `load-run`, Evidence/Artifact publication, plan validation/adaptation, comparison, traceability, report materialization, and checkpoints all consume explicit inputs and validated on-disk state.

The G4 local Evidence MCP adapter is a narrow transport over the existing `EvidenceStore` API. `record_evidence` persists caller-supplied bytes; `get_evidence_manifest` returns validated substrate records. The server does not fetch a source, infer provenance, evaluate Evidence quality, form a Claim, or dispatch an agent. Its stdio registration and approval policy live in `.codex/config.toml`.

Project hooks are optional lifecycle guardrails. They do not write formal `events.jsonl`, route mode, create plans, advance Run status, retry work, or build reports. Disabling hooks leaves all explicit Skill and Harness commands available.

The current contract is selected directly by `harness/schemas/current.json`. It has no product release version and does not load a historical base chain. It includes both Discovery and Assessment execution shapes that current producers and consumers still use. A terminal gate can intentionally skip later stages while projecting research conclusion separately from execution completeness and runtime health. Terminal reporting still requires a caller-supplied main-agent source and deterministically materializes `report.json`, `decision-brief.md`, and `report.md`. Mechanical success never proves Evidence truth, sufficiency, external validation, market demand, decision readiness, or product viability.

`compile-artifacts` separates agent-authored document semantics from Harness-derived envelopes,
hashes, refs, validation closure, and publication plans. Use `operation: "validate_only"` as the
publication dry-run, then publish the returned immutable plan. `materialize-lane-result` additionally
requires a one-shot delivery declaration covering every required Artifact and assigned scope item,
including explicit `no_evidence_found` coverage and Search Closure. The Harness preflights the full
delivery, emits a formal `lane_delivery_receipt`, and atomically publishes it with the Lane bundle;
preflight failures return stable, root-cause-grouped diagnostics and publish nothing.
