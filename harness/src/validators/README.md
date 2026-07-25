# Deterministic Schema And Reference Validator

默认 validator 使用 schema bundle `3.0.0`，同时保留既有 v1/v2/v3 document contract。`validate-artifact` 继续只验证显式 document/bundle；不会扫描 Run、启动 Agent、执行 research branch 或隐式迁移历史 Artifact。

`PlanningContractEvaluator` 只读消费显式 Document Bundle、`adaptation.v1.json` 和 AI trigger source-binding policy，返回排序稳定的 contract issue。它机械校验 Planning Context v2 的 source existence/schema/canonical hash/Run/mode/context revision/subject/trigger exact binding、closed unit tuple、AI aggregate coverage、canonical coverage_key/relation、pending/active coverage target 和 Run Manifest failed-only retry。

`PlanSemanticValidator` 与 `AdaptationPolicyValidator` 在该只读结果上增加 G0.4 DAG、manifest disposition、parent immutability、closed action、coverage、retry/supersede 和 stale 前置条件。显式 v2 planning bundle 继续执行 live stale binding；v3 Store bundle 只验证历史 Planning Context 的 self-binding 与 lineage，避免用最新 manifest 重解释不可变历史 context。

`AssessDomainValidator` 只对显式 `document_bundle.v4` 中的 G1.1 document 执行确定性校验：same-Run/singleton identity、intake/scope/concept framing、assessment plan mandatory dimensions 与 revision lineage、Research Plan 静态绑定、branch output ownership、Judgment signal/sufficiency、fan-in 分类、Matrix、BusinessEngine 和 Assessment 一致性。它不读取网络或 Run Store，不生成 Evidence/Claim/Finding/Insight，也不执行 Evidence ceiling、audit、adversarial review 或 report gate。
