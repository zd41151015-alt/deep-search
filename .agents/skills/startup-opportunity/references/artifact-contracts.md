# Artifact Contracts

Formal research state lives under `runs/<run_id>/`; chat history and subagent responses are not authoritative. Every formal artifact envelope records a schema version, typed document version, Run-relative path, creation time, producer role, input references, and content hash. G0.2 publishes the closed envelope and core document schemas plus deterministic validation. G0.3 will own computing hashes and writing, validating, and atomically publishing envelopes at formal paths.

Evidence, Claim, Finding, Insight, and Judgment Assessment are separate layers. Decisive facts, quotes, hard-gate inputs, opposition, and recommendations must trace through those layers to real Evidence. Evidence lifecycle, judgment direction, and decision sufficiency use separate fields. Source independence, shared datasets, rejection reasons, unavailable sources, bias, geography, language, and freshness remain auditable.

Published Research Plans, Gap Snapshots, and Adaptation Decisions are immutable. Downstream-referenced artifacts are revised at a new path rather than overwritten. Each subagent owns one branch path; only the main agent serially updates manifest indexes, applies approved plan revisions, creates checkpoints, and assembles final output.

G0.2 now provides the versioned closed core schema bundle and deterministic schema/reference validation for explicitly supplied documents. G0.3 owns Run, Artifact, and Evidence storage, atomic publication, event/decision logs, checkpointing, and recovery. A valid document is not a published artifact, and schema/reference validity does not establish research quality or decision readiness.
