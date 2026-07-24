# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G0.3 Store 保留原有 v1 records，并提供 confined Run creation/reopen、canonical hashing、immutable formal publication、manifest indexing、Event/Decision append、Evidence substrate deduplication、checkpointing 和 crash recovery。Contract 修正发布 schema bundle `2.0.0` 与只读 Planning Contract evaluator；Plan/adaptation runtime 和 downstream research judgment 仍 fail-closed。

The public developer entry is `npm run harness -- <command>`. `help`, `doctor`, `validate-artifact`, `create-run`, `load-run`, `record-evidence`, and `checkpoint-run` are available. Policy, research, comparison, and reporting commands remain fail-closed until their implementation, positive and negative fixtures, and ledger status are committed together.
