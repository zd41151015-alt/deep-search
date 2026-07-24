# Run Store Ownership

G0.3 implements creation and loading of Run directories, atomic manifest indexing, operation-keyed Event and Decision append, immutable checkpoints, reopen reconciliation, and crash recovery. G0.4 adds the exact v2 receipt adapter required to publish v2/v3 control envelopes and recover Plan Revision operations. Paths use the published Run id/relative-path grammar, reject symlinks and mixed separators, and never write outside the selected `runs/<run_id>/` boundary.

`manifest.json` is the mutable current index and is replaced atomically from a same-Run temporary file. Formal envelopes and checkpoints are immutable. Non-initial checkpoints must advance both the current manifest timestamp and the latest valid published checkpoint timestamp; the initial checkpoint may equal Run creation time. The pre-publication check is read-only, so a published-but-unindexed checkpoint participates in durable ordering without rolling back valid current manifest changes.

Reopen validates schema, canonical hashes, known typed refs, manifest set exclusivity, current Plan revision/lineage, exact operation receipt identity, JSONL record-id uniqueness, and the last valid checkpoint. It completes validated temp publications, reconciles published Artifact and missing checkpoint events, truncates only a corrupt JSONL tail, and completes post-CAS Plan Revision receipts from validated disk state.

Publication checks a current Plan-owned output against its exact `required_artifact_schema`. Results for cancelled, invalidated, or superseded units are persisted only in `ignored_late_artifact_refs`; reopen reclassifies them so they cannot re-enter current `artifact_refs`. `future_declared` schemas remain unpublishable until their owning versioned schema and Store adapter exist.
