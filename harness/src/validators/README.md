# Deterministic Schema And Reference Validator

默认 validator 使用 schema bundle `2.2.0`，同时兼容读取 `1.0.0`/`2.0.0`/`2.1.0` 中的已发布 document。`validate-artifact` 继续只验证显式 document/bundle；不会扫描 Run、启动 Agent 或隐式迁移历史 Artifact。

`PlanningContractEvaluator` 只读消费显式 Document Bundle、`adaptation.v1.json` 和 AI trigger source-binding policy，返回排序稳定的 contract issue。它机械校验 Planning Context v2 的 source existence/schema/canonical hash/Run/mode/context revision/subject/trigger exact binding、closed unit tuple、AI aggregate coverage、canonical coverage_key/relation、pending/active coverage target 和 Run Manifest failed-only retry。

`PlanSemanticValidator` 与 `AdaptationPolicyValidator` 在该只读结果上增加 G0.4 DAG、manifest disposition、parent immutability、closed action、coverage、retry/supersede 和 stale 前置条件。显式 v2 planning bundle 继续执行 live stale binding；v3 Store bundle 只验证历史 Planning Context 的 self-binding 与 lineage，避免用最新 manifest 重解释不可变历史 context。
