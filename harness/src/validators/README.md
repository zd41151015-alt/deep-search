# Deterministic Schema And Reference Validator

默认 validator 使用 schema bundle `2.0.0`，同时兼容读取 `1.0.0` 中的 v1 documents。`validate-artifact` 继续只验证显式 document/bundle；不会扫描 Run、启动 Agent 或隐式迁移历史 artifact。

`PlanningContractEvaluator` 只读消费显式 Document Bundle 与 `adaptation.v1.json`，返回排序稳定的 contract issues。它机械校验 Planning Context stale binding、closed unit tuple、AI aggregate coverage、canonical coverage_key/relation、pending/active coverage target 和 Run Manifest failed-only retry；不接通 `validate-plan`、`validate-adaptation` 或 Plan Revision runtime。
