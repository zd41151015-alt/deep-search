# Policy Boundary

`adaptation.v1.json` 发布 domain-specific closed planning/adaptation policy `1.0.0`。它以 exact `mode + phase + unit_type + agent_role + required_artifact_schema` tuple 约束 Research Plan，区分 `installed` 与 `future_declared` output schema，并固定 Coverage Attestation relation、failed-only retry 和 partial retry fail-closed 边界。

Policy 不是通用规则引擎，不包含任意表达式、可执行 workflow code 或运行时用户调权。G0.4 runtime 尚未接通；当前 policy 只由 schema/reference/contract fixtures 确认可机械执行。
