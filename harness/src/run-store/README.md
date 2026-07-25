# Run Store Ownership

G0.3 implements creation and loading of Run directories, atomic manifest indexing, operation-keyed Event and Decision append, immutable checkpoints, reopen reconciliation, and crash recovery. G0.4 adds the exact v2 receipt adapter required to publish v2/v3 control envelopes and recover Plan Revision operations. Paths use the published Run id/relative-path grammar, reject symlinks and mixed separators, and never write outside the selected `runs/<run_id>/` boundary.

`manifest.json` is the mutable current index and is replaced atomically from a same-Run temporary file. Formal envelopes and checkpoints are immutable. Non-initial checkpoints must advance both the current manifest timestamp and the latest valid published checkpoint timestamp; the initial checkpoint may equal Run creation time. The pre-publication check is read-only, so a published-but-unindexed checkpoint participates in durable ordering without rolling back valid current manifest changes.

Reopen validates schema, canonical hashes, known typed refs, manifest set exclusivity, current Plan revision/lineage, exact operation receipt identity, JSONL record-id uniqueness, and the last valid checkpoint. It completes validated temp publications, reconciles published Artifact and missing checkpoint events, truncates only a corrupt JSONL tail, and completes post-CAS Plan Revision receipts from validated disk state.

Publication checks a current Plan-owned output against its exact `required_artifact_schema`. Results for cancelled, invalidated, or superseded units are persisted only in `ignored_late_artifact_refs`; reopen reclassifies them so they cannot re-enter current `artifact_refs`. `future_declared` schemas remain unpublishable until their owning versioned schema and Store adapter exist.

G1.2 task envelope publication 只做 `pending -> active` 的 deterministic manifest transition；Harness 不启动或管理 agent。v5 branch 的 `completed`、`partial`、`insufficient_evidence` 进入 `completed_units`，`failed` 进入 `failed_units`，existing cancelled/skipped/superseded/ignored-late 集合按 versioned policy 映射。`partial` retry 仍 fail closed。Reopen 使用磁盘上的 envelope、v2 Evidence exact records 和最新有效 checkpoint 重建同一状态；不会把 late/superseded output 恢复成 current。

G1.3 Plan operation receipt v2 同时绑定 base/result Research Plan 与 assessment plan ref/hash。`add_unit` 的三个 revision control Artifacts 全部验证并发布后才允许 Manifest CAS；`stop_followup` 保留 current plan。Crash/reopen 只完成已验证 receipt 的剩余步骤，stale base、branched ancestry、drift 或 operation-key conflict 均 fail closed。
