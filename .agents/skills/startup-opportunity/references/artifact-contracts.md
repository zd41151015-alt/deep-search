# Artifact Contracts

Formal research state lives under `runs/<run_id>/`; chat history and subagent responses are not authoritative. Every formal artifact records a schema version, creation time, producer role, input references, and content hash. Publication writes a temporary file, validates it, and atomically moves it to the formal path.

Evidence, Claim, Finding, Insight, and Judgment Assessment are separate layers. Decisive facts, quotes, hard-gate inputs, opposition, and recommendations must trace through those layers to real Evidence. Evidence lifecycle, judgment direction, and decision sufficiency use separate fields. Source independence, shared datasets, rejection reasons, unavailable sources, bias, geography, language, and freshness remain auditable.

Published Research Plans, Gap Snapshots, and Adaptation Decisions are immutable. Downstream-referenced artifacts are revised at a new path rather than overwritten. Each subagent owns one branch path; only the main agent serially updates manifest indexes, applies approved plan revisions, creates checkpoints, and assembles final output.

G0.2 owns the complete closed schema bundle and deterministic schema/reference validation. G0.3 owns Run, Artifact, and Evidence storage, atomic publication, event/decision logs, checkpointing, and recovery. Directory or script presence in G0.1 does not satisfy either contract.
