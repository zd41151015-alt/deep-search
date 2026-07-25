# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G1.1 在不改写既有 v1/v2/v3 schema 与 G0 policy 的前提下，默认发布 schema bundle `3.0.0`，加入 11 个 Assess domain closed contracts、v4 definitions、Artifact Envelope 与 Document Bundle。`validate-artifact` 可对显式 G1.1 bundle 执行 schema、typed ref、same-Run、lineage、identity、assessment plan、branch/fan-in、Judgment、Matrix、BusinessEngine 与 Assessment 一致性校验。G0.4 Store 仍只发布 v1/v2/v3 envelope；v4 publication 在 G1.2 adapter 落地前显式 fail closed。

The public developer entry is `npm run harness -- <command>`. In addition to the Store commands, `validate-plan`, `analyze-gaps`, `validate-adaptation`, and `apply-plan-revision` are available. `validate-artifact` now validates G1.1 static contracts, but research, comparison, and reporting commands remain fail closed until their implementation, positive and negative fixtures, and ledger status are committed together.
