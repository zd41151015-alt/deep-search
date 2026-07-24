# Policy Boundary

`adaptation.v1.json` 发布 domain-specific closed planning/adaptation policy `1.0.0`。它以 exact `mode + phase + unit_type + agent_role + required_artifact_schema` tuple 约束 Research Plan，区分 `installed` 与 `future_declared` output schema，并固定 Coverage Attestation relation、failed-only retry 和 partial retry fail-closed 边界。

`ai-trigger-source-binding.v1.json` 发布 source-binding policy `1.0.0`。它用 exact ref/schema/version/canonical hash 绑定上述 adaptation policy，要求 Planning Context v2 的 `source_ref` 解析为显式 Document Bundle 中已安装的 AI Trigger Source Attestation v1，并固定 Run/mode/context revision/subject/trigger exact bindings；future-declared source schema 被禁止。

`plan-revision-apply.v1.json` 固定 operation identity、add/retry/supersede placement、non-revision action、late Artifact 和 partial retry 行为，并以 canonical hash 绑定前述 accepted policy。G0.4 runtime 只执行这些 closed choice。

Policy 不是通用规则引擎，不包含任意表达式、可执行 workflow code 或运行时用户调权。
