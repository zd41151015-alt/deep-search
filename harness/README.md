# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G3.3 默认加载 schema bundle `15.0.0`。既有 schema/policy bytes 保持 immutable；v16 Envelope/Document Bundle、receipt v14、publication policy v11 与 evaluation policy v3只追加 caller-supplied mandatory AI bundle、固定六维 coverage 和 consumer binding。missing、incomplete、desk-research-only 或 stale coverage 必须显式降级；Harness 不生成 bundle/research/benchmark/语义判断，不访问 network，也不调用或派发 agent/LLM。

The public developer entry is `npm run harness -- <command>`. G2 and G3 caller-supplied Artifacts use `validate-artifact`, `record-evidence`, `publish-artifact`, `checkpoint-run`, and `load-run`; G2.4 also opens read-only `calculate-comparison`, `calculate-sensitivity`, discovery-aware `audit-traceability`, and deterministic `build-report`. The Harness does not start lanes, obtain Evidence, synthesize research/evaluation semantics, infer dispositions, or make research judgments.
