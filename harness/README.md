# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G3.2 默认加载 schema bundle `14.0.0`。既有 schema/policy bytes 保持 immutable；v14/policy v9继续冻结 G3.1 baseline/reliability/data 语义，v15 Envelope/Document Bundle、receipt v13 与 publication policy v10只追加 caller-supplied inference economics、commoditization 和 adoption/trust Artifact。Harness 只验证、聚合和持久化显式输入，不运行 research/benchmark，不生成语义判断，不访问 network，也不调用或派发 agent/LLM。

The public developer entry is `npm run harness -- <command>`. G2 and G3 caller-supplied Artifacts use `validate-artifact`, `record-evidence`, `publish-artifact`, `checkpoint-run`, and `load-run`; G2.4 also opens read-only `calculate-comparison`, `calculate-sensitivity`, discovery-aware `audit-traceability`, and deterministic `build-report`. The Harness does not start lanes, obtain Evidence, synthesize research/evaluation semantics, infer dispositions, or make research judgments.
