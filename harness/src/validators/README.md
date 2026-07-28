# Deterministic Schema And Reference Validator

默认 validator 使用 schema bundle `11.0.0`，同时保留既有 v1-v11 contract bytes。`validate-artifact` 继续只验证显式 document/bundle；不会扫描 Run、启动 Agent、执行 network research 或隐式迁移历史 Artifact。

`PlanningContractEvaluator` 只读消费显式 Document Bundle、`adaptation.v1.json` 和 AI trigger source-binding policy，返回排序稳定的 contract issue。它机械校验 Planning Context v2 的 source existence/schema/canonical hash/Run/mode/context revision/subject/trigger exact binding、closed unit tuple、AI aggregate coverage、canonical coverage_key/relation、pending/active coverage target 和 Run Manifest failed-only retry。

`PlanSemanticValidator` 与 `AdaptationPolicyValidator` 在该只读结果上增加 G0.4 DAG、manifest disposition、parent immutability、closed action、coverage、retry/supersede 和 stale 前置条件。显式 v2 planning bundle 继续执行 live stale binding；v3 Store bundle 只验证历史 Planning Context 的 self-binding 与 lineage，避免用最新 manifest 重解释不可变历史 context。

`AssessDomainValidator` 只对显式 `document_bundle.v4` 中的 G1.1 document 执行确定性校验：same-Run/singleton identity、intake/scope/concept framing、assessment plan mandatory dimensions 与 revision lineage、Research Plan 静态绑定、branch output ownership、Judgment signal/sufficiency、fan-in 分类、Matrix、BusinessEngine 和 Assessment 一致性。它不读取网络或 Run Store，不生成 Evidence/Claim/Finding/Insight，也不执行 Evidence ceiling、audit、adversarial review 或 report gate。

`ResearchBranchValidator` 只对显式 `document_bundle.v5` 校验 Research Task 与 `Evidence -> Claim -> Finding -> Insight` chain：same-Run/subject/scope/plan/unit/attempt lineage、唯一 path/identity、lane ownership、support/oppose direction、v2 substrate exact binding、Source Manifest 与 Branch Result input closure。引用方向固定为 `Branch Result -> Insight -> Finding -> Claim -> Evidence`。开放语义字段只验证闭集和显式值，不做质量推断；G1.4 Evidence ceiling、Hard Gate、audit/review/report 不在本 validator 内。

`AssessmentAdaptationValidator` 只对显式 `document_bundle.v6` 校验 Gap Snapshot v2 与 Adaptation Decision v3 的 exact current/historical ancestry binding、coverage_key、observed branch/task hashes、unit/attempt state、closed buyer/acquisition target 与 duplicate/stale/branched/forged/replay 边界。它不判断 Evidence 是否真实或充分，不创建任意 DAG，也不执行 G1.4 gate。

`G14Validator` 只对显式 `document_bundle.v7` 执行 same-Run/final Plan/assessment-plan/input-hash/producer binding、Evidence audit ceiling、challenger independence、Hard Gate/closed result、decisive trace chain 和 three-output consistency 校验。它不做语义 research、不修改 Evidence/Claim/Finding/Insight/Judgment/Matrix/Plan，也不把 fixture 成功解释为 Evidence 充分或市场验证。

`DiscoveryMapsValidator` 只对显式 `document_bundle.v8` 执行 G2.1 same-Run/mode/profile/market/language/current Plan/path/ref/hash/producer binding，以及 seed-independent/counterfactual unit、initial question、solution-neutral map、九类 solution/status quo、AI boundary 和 no-Evidence/no-thesis 校验。它不创建 lane/fan-in、Demand/Opportunity Thesis、comparison/report，也不执行 research 或 agent orchestration。

`DiscoveryCandidateValidator` 对显式 v9 contract bundle 或 v10 runtime bundle执行 exact map fragment/revision/hash、candidate immutability、task/material candidate binding、generation/evaluation separation、per-candidate pre-kill Judgment、terminal lane exclusion、fan-in disposition/Judgment closure 与 candidate lineage校验。它不生成 candidate、执行 lane/pre-kill、判断 Evidence 质量或发布 G2.3 thesis。

`DiscoverySynthesisValidator` 对显式 v11 bundle 执行 executable conversion/target 双向 binding、formal target candidate ancestry、typed material task binding、generation/evaluation source separation、Demand-first dependency order、Solution Evaluation exact classification、Opportunity selection lineage、immutable pre-enrichment snapshot 和 non-title semantic merge closure。它不合成 thesis、不判断 Evidence 真实性/充分性，也不开放 G2.4 enrichment/comparison/report。

`DiscoveryEvaluationValidator` 对显式 v12 bundle 执行 task/current enabled Plan unit exact tuple、snapshot/merge、v3 material/substrate、branch/fan-in、domain subject、hard gate/panel、Evidence ceiling、sensitivity/partial order、portfolio/recommendation、traceability/freshness/hash 与 discovery report closure。它不获取 Evidence、不生成 Judgment、panel band、排名或推荐；validation 只证明 contract mechanics。
