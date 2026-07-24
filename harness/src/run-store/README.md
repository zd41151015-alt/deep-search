# Run Store Ownership

G0.3 implements creation and loading of Run directories, atomic manifest indexing, operation-keyed Event and Decision append, immutable checkpoints, reopen reconciliation, and crash recovery. Paths use the published Run id/relative-path grammar, reject symlinks and mixed separators, and never write outside the selected `runs/<run_id>/` boundary.

`manifest.json` is the mutable current index and is replaced atomically from a same-Run temporary file. Formal envelopes and checkpoints are immutable. Reopen validates schema, canonical hashes, known typed refs, manifest set exclusivity, current plan revision/lineage, operation receipts, JSONL, and the last valid checkpoint. It completes validated temp publications, reconciles published artifacts and missing checkpoint events, truncates only a corrupt JSONL tail, and reports orphan active units without choosing G0.4 retry/supersede semantics.
