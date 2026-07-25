# Artifact Store Ownership

G0.2 publishes the typed artifact-envelope schema and validates its closed metadata/document shape. G0.3 implements path confinement, same-Run temp writes, schema/reference checks, fsync, no-replace atomic publication, immutable formal paths, operation receipts, idempotent replay, and explicit write conflicts. Downstream-referenced artifacts are never overwritten in place. Reopen validates each receipt's exact shape, canonical operation key, filename hash, Run id, artifact metadata, and complete envelope before any receipt-driven publication.

G0.4 adds only the versioned compatibility needed by Plan/Adaptation control artifacts: envelope v1 keeps receipt v1, while envelope v2/v3 uses receipt v2 and its matching Document Bundle reference rules. This does not install `future_declared` business schemas or turn the Artifact Store into a generic migration layer.

G1.2 的 `research-publication.v1.json` 为 envelope v1-v5 发布唯一 adapter：receipt v1 对 v1，receipt v2 对 v2/v3，receipt v3 对 v4，receipt v4 对 v5。所有旧 schema/bundle/policy bytes 保持 immutable。v4 可发布已接受的 G1.1 Artifact，但明确阻止 `concept_evidence_assessment_branch_result.v1`；research branch 必须使用 v5 并经过 Evidence exact-record 与 typed traceability 校验。

`publish-artifact` 接收一个显式 envelope，或至少两个 envelope 的有界 bundle。bundle 先对 pending 与已发布 documents 整体校验，用于处理 Research Plan/Assessment Plan 互引；随后每个 path 仍使用独立 immutable receipt 和 no-replace publication。Harness 不分派 lane、不调用 LLM、不访问网络，也不把 chat/completion message 作为 Artifact。

The envelope `content_hash` basis is the SHA-256 of UTF-8 canonical `document` JSON: object keys are recursively sorted by code unit, arrays keep order, and only JSON values are accepted. The hash excludes envelope metadata, including the `content_hash` field itself. No script response or chat message is accepted as a stored artifact.
