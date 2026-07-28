# Policy Boundary

`adaptation.v1.json` 发布 domain-specific closed planning/adaptation policy `1.0.0`。它以 exact `mode + phase + unit_type + agent_role + required_artifact_schema` tuple 约束 Research Plan，区分 `installed` 与 `future_declared` output schema，并固定 Coverage Attestation relation、failed-only retry 和 partial retry fail-closed 边界。

`ai-trigger-source-binding.v1.json` 发布 source-binding policy `1.0.0`。它用 exact ref/schema/version/canonical hash 绑定上述 adaptation policy，要求 Planning Context v2 的 `source_ref` 解析为显式 Document Bundle 中已安装的 AI Trigger Source Attestation v1，并固定 Run/mode/context revision/subject/trigger exact bindings；future-declared source schema 被禁止。

`plan-revision-apply.v1.json` 固定 operation identity、add/retry/supersede placement、non-revision action、late Artifact 和 partial retry 行为，并以 canonical hash 绑定前述 accepted policy。G0.4 runtime 只执行这些 closed choice。

`research-publication.v1.json` 固定 envelope v1-v5 到 Document Bundle、receipt、manifest bundle 的 adapter，v4 branch block、v2 substrate 与 materialized Evidence 分层、traceability 方向、task lifecycle 和 branch status mapping。它不包含 research quality inference、agent dispatch、network access、G1.3 plan adaptation 或 G1.4 report gate。

`assessment-adaptation.v1.json` 固定 G1.3 buyer/acquisition coverage、`add_unit|stop_followup`、target tuple、follow-up 上限与 immutable assessment plan revision。`ai-trigger-source-binding.v2.json` 只增加对该 policy 的 canonical binding；`research-publication.v2.json` 只增加 v6/receipt v5 adapter。三者不改写既有 policy bytes，也不开放 audit、Assessment gate 或 reporting。

`assessment-reporting.v1.json` 固定 G1.4 四类 Assessment result、evaluator result、十二个 Hard Gates、Evidence ceiling、report generation order、禁用表述与 producer ownership。`research-publication.v3.json` 只增加 v7/document bundle v7/receipt v6 adapter 和 receipt-driven report view contract；它不修改历史 adapter，也不执行 research 或 agent orchestration。

`discovery-maps.v1.json` 固定 G2.1 四种 discovery profile、三张 map path、seed-independent/counterfactual Plan 约束、九类 solution/status-quo breadth、AI capability boundary 和 no-Evidence/no-thesis source boundary。`research-publication.v4.json` 只增加 v8/document bundle v8/receipt v7 adapter，并阻止 G2.2+ artifact types；它不执行 discovery、lane orchestration、LLM 或 network research。

`discovery-candidates.v1.json` 固定方案 A candidate/task/material/lane/fan-in/conversion contract。`research-publication.v5.json` 只增加 v10/document bundle v10/receipt v8 adapter、G2.2 lane status projection与显式 runtime boundary；v9 保持 Store unsupported，G2.3/G2.4 artifact types 保持 blocked。Harness 不 dispatch agent、不执行 lane、pre-kill、LLM、network research 或 external validation。

`discovery-synthesis.v1.json` 固定 G2.3 executable conversion v2、Demand-first formalization、solution evaluation、source separation、pre-enrichment freeze 和 semantic merge contract。`research-publication.v6.json` 只增加 v11/document bundle v11/receipt v9 adapter与稳定 publication/reopen boundary；v1 conversion 保持 contract-only，G2.4 artifact types 保持 blocked。Harness 不生成 thesis 语义、不调用 LLM、不执行 research 或 external validation，publication 不表示 Evidence 充分或 validation success。

`discovery-evaluation.v1.json` 固定 G2.4 enrichment eligible/excluded branch、十三个 hard gates、四个独立 comparison panel、Evidence ceiling、publication order 与 report boundary。`research-publication.v7.json` 只增加 v12/document bundle v12/receipt v10 adapter、enrichment status projection 和 discovery report recovery；v11 继续 block G2.4 types，v12 继续 block G3 AI bundle。Harness 不生成 enrichment/comparison/recommendation 语义、不调用 LLM、不执行 research 或 external validation。

Policy 不是通用规则引擎，不包含任意表达式、可执行 workflow code 或运行时用户调权。
