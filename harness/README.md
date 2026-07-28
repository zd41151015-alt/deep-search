# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G2.4 repair 默认加载 schema bundle `12.0.0`。v9-v12 与 bundle `8.0.0`-`11.0.0` bytes 保持 immutable；repair 另用 v13 Envelope/Document Bundle、receipt v11、discovery evaluation policy v2、discovery adaptation binding v1 和 publication policy v8。Enrichment、Business Engine、hard gates、comparison、sensitivity、portfolio、recommendation、traceability 与 report 语义由调用方显式提供并经 deterministic validator/Store fail closed。

The public developer entry is `npm run harness -- <command>`. G2.1-G2.4 caller-supplied Artifacts use `validate-artifact`, `record-evidence`, `publish-artifact`, `checkpoint-run`, and `load-run`; G2.4 also opens read-only `calculate-comparison`, `calculate-sensitivity`, discovery-aware `audit-traceability`, and deterministic `build-report`. The Harness does not start lanes, obtain Evidence, synthesize thesis/enrichment/evaluation semantics, infer dispositions, or make research judgments. Discover orchestration and G3+ remain unavailable.
