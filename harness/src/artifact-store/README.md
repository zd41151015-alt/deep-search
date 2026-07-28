# Artifact Store Ownership

G0.2 publishes the typed artifact-envelope schema and validates its closed metadata/document shape. G0.3 implements path confinement, same-Run temp writes, schema/reference checks, fsync, no-replace atomic publication, immutable formal paths, operation receipts, idempotent replay, and explicit write conflicts. Downstream-referenced artifacts are never overwritten in place. Reopen validates each receipt's exact shape, canonical operation key, filename hash, Run id, artifact metadata, and complete envelope before any receipt-driven publication.

G0.4 adds only the versioned compatibility needed by Plan/Adaptation control artifacts: envelope v1 keeps receipt v1, while envelope v2/v3 uses receipt v2 and its matching Document Bundle reference rules. This does not install `future_declared` business schemas or turn the Artifact Store into a generic migration layer.

G1.2 的 `research-publication.v1.json` 为 envelope v1-v5 发布唯一 adapter：receipt v1 对 v1，receipt v2 对 v2/v3，receipt v3 对 v4，receipt v4 对 v5。所有旧 schema/bundle/policy bytes 保持 immutable。v4 可发布已接受的 G1.1 Artifact，但明确阻止 `concept_evidence_assessment_branch_result.v1`；research branch 必须使用 v5 并经过 Evidence exact-record 与 typed traceability 校验。

G1.3 的 `research-publication.v2.json` 增加 envelope v6/document bundle v6/receipt v5 adapter，允许 immutable Gap Snapshot、Adaptation Decision 与 revision control Artifact publication。旧 receipt 与 adapter 保持可读；recovery 必须验证 formal envelope bytes、canonical hash、operation identity 和 Manifest state，不能从 chat 或 task summary 重建。

G1.4 的 `research-publication.v3.json` 增加 envelope v7/document bundle v7/receipt v6 adapter。Audit/Review/Assessment/Traceability/report sidecar 继续使用同一 immutable envelope/no-replace model；三个 materialized report path 使用独立 receipt，并只从 validated sidecar 确定性恢复。formal 或 materialized drift 均拒绝覆盖。

G2.1 的 `research-publication.v4.json` 增加 envelope v8/document bundle v8/receipt v7 adapter。首次 Seed/Opportunity/Solution map publication 必须在同一个显式 bundle 中通过 closed cross-map validation；每个 path 仍独立 immutable/no-replace，receipt/reopen 验证 exact envelope、canonical hash 和 same-Run identity。G2.2+ artifact types 继续由 adapter fail closed。

G2.2 的 `research-publication.v5.json` 增加 envelope v10/document bundle v10/receipt v8 adapter。v9 accepted contract envelope 继续在任何写入前 fail closed。v10 只发布调用方显式提供的 pre-thesis candidate、Research Task、typed lane material/result 和 `discovery_fan_in.v2`；task 激活与 terminal lane status 机械投影到 Manifest，late/superseded output 只进入 ignored refs。Checkpoint/reopen 按 task-before-lane 的稳定顺序重放；G2.3+ types 仍 blocked。

G2.3 的 `research-publication.v6.json` 增加 envelope v11/document bundle v11/receipt v9 adapter。accepted conversion v1 与 v10 adapter bytes 不改写；只有 executable conversion v2 和 caller-supplied Demand/Baseline/Solution/Evaluation/Opportunity/Snapshot/Merge 可通过 v11 发布。bundle 先整体校验 conversion-target 循环引用，再按 Demand -> Baseline -> Solution -> evaluation -> Opportunity -> snapshot -> merge 稳定落盘；checkpoint/reopen 只从 validated envelope/receipt/on-disk state恢复。G2.4+ types 仍 blocked。

G2.4 的 `research-publication.v7.json` 增加 envelope v12/document bundle v12/receipt v10 adapter。v11 及历史 adapter bytes 不改写；v12 只发布 caller-supplied enrichment/evaluation/report Artifact，并按 task -> material -> branch -> fan-in -> domain -> comparison -> sensitivity -> portfolio/recommendation -> traceability -> report/derived views 稳定落盘。G3 AI bundle types 继续 blocked。

G2.4 repair 的 `research-publication.v8.json` 增加 envelope v13/document bundle v13/receipt v11 adapter，不改写 v12 bytes。v13 使用 evaluation policy v2、adaptation binding v1 和 Consistency v3，保持相同稳定 publication/recovery 顺序，并继续在任何写入前 block G3 AI bundle types。

`publish-artifact` 接收一个显式 envelope，或至少两个 envelope 的有界 bundle。bundle 先对 pending 与已发布 documents 整体校验，用于处理 Research Plan/Assessment Plan 互引；随后每个 path 仍使用独立 immutable receipt 和 no-replace publication。Harness 不分派 lane、不调用 LLM、不访问网络，也不把 chat/completion message 作为 Artifact。

The envelope `content_hash` basis is the SHA-256 of UTF-8 canonical `document` JSON: object keys are recursively sorted by code unit, arrays keep order, and only JSON values are accepted. The hash excludes envelope metadata, including the `content_hash` field itself. No script response or chat message is accepted as a stored artifact.
