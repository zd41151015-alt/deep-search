# Deterministic Schema And Reference Validator

默认 validator 使用 schema bundle `2.1.0`，同时兼容读取 `1.0.0`/`2.0.0` 中的已发布 documents。`validate-artifact` 继续只验证显式 document/bundle；不会扫描 Run、启动 Agent 或隐式迁移历史 artifact。

`PlanningContractEvaluator` 只读消费显式 Document Bundle、`adaptation.v1.json` 和 AI trigger source-binding policy，返回排序稳定的 contract issues。它机械校验 Planning Context v2 的 source existence/schema/canonical hash/Run/mode/context revision/subject/trigger exact binding、closed unit tuple、AI aggregate coverage、canonical coverage_key/relation、pending/active coverage target 和 Run Manifest failed-only retry；不接通 `validate-plan`、`validate-adaptation`、Store publication 或 Plan Revision runtime。
