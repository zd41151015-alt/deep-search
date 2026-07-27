# Run Store Ownership

G0.3 implements creation and loading of Run directories, atomic manifest indexing, operation-keyed Event and Decision append, immutable checkpoints, reopen reconciliation, and crash recovery. G0.4 adds the exact v2 receipt adapter required to publish v2/v3 control envelopes and recover Plan Revision operations. Paths use the published Run id/relative-path grammar, reject symlinks and mixed separators, and never write outside the selected `runs/<run_id>/` boundary.

`manifest.json` is the mutable current index and is replaced atomically from a same-Run temporary file. Formal envelopes and checkpoints are immutable. Non-initial checkpoints must advance both the current manifest timestamp and the latest valid published checkpoint timestamp; the initial checkpoint may equal Run creation time. The pre-publication check is read-only, so a published-but-unindexed checkpoint participates in durable ordering without rolling back valid current manifest changes.

Reopen validates schema, canonical hashes, known typed refs, manifest set exclusivity, current Plan revision/lineage, exact operation receipt identity, JSONL record-id uniqueness, and the last valid checkpoint. It completes validated temp publications, reconciles published Artifact and missing checkpoint events, truncates only a corrupt JSONL tail, and completes post-CAS Plan Revision receipts from validated disk state.

Publication checks a current Plan-owned output against its exact `required_artifact_schema`. Results for cancelled, invalidated, or superseded units are persisted only in `ignored_late_artifact_refs`; reopen reclassifies them so they cannot re-enter current `artifact_refs`. `future_declared` schemas remain unpublishable until their owning versioned schema and Store adapter exist.

G1.2 task envelope publication 只做 `pending -> active` 的 deterministic manifest transition；Harness 不启动或管理 agent。v5 branch 的 `completed`、`partial`、`insufficient_evidence` 进入 `completed_units`，`failed` 进入 `failed_units`，existing cancelled/skipped/superseded/ignored-late 集合按 versioned policy 映射。`partial` retry 仍 fail closed。Reopen 使用磁盘上的 envelope、v2 Evidence exact records 和最新有效 checkpoint 重建同一状态；不会把 late/superseded output 恢复成 current。

G1.3 Plan operation receipt v2 同时绑定 base/result Research Plan 与 assessment plan ref/hash。`add_unit` 的三个 revision control Artifacts 全部验证并发布后才允许 Manifest CAS；`stop_followup` 保留 current plan。Crash/reopen 只完成已验证 receipt 的剩余步骤，stale base、branched ancestry、drift 或 operation-key conflict 均 fail closed。

G1.4 reopen 在 Artifact receipt recovery 后检查 immutable report sidecar，按 report -> brief -> full view -> consistency 的闭合 contract 补齐缺失 derived sidecar 和 materialized view。`report.json` 不作为 formal envelope 重复索引；它与两个 Markdown 文件的冲突 bytes、receipt drift、sidecar/hash drift 都使 reopen fail closed。

G2.1 为 Run 增加 `artifacts/discovery/` 路径，并在首个 discovery Research Plan publication 后确定性设置 `current_phase=discovery`。v8 map/checkpoint receipt 参与既有 crash recovery 与 reopen；恢复只消费 validated on-disk envelope/temp/receipt，不从 chat、task completion 或模型记忆重建 map。
