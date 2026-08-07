# Lane Catalog And Handoff

Research unit 使用已发布的 unit type 和三个稳定 custom-agent role 之一。planner 不得自行发明 role、Artifact schema、权限或输出位置。

lane researcher 负责有界来源发现、支持与反对 Claim、Finding、局限、未解决问题，以及唯一一个指定 branch Artifact。evidence auditor 独立检查引用是否存在、引文忠实度、支持关系、独立性、偏差、freshness 和立场平衡。adversarial reviewer 使用独立挑战查询攻击综合结论，并记录修订请求或足以改变结论的 gap。

每个 subagent 都会收到 task envelope，其中包含 run id、unit id、mode、research goal、商业研究规划比例、planned queries、input references、唯一允许的 output path、required Artifact schema、required support/opposition stances、工具指引、stop conditions 和 completion-message contract。规划比例不要求实际查询次数严格命中，也不是 Gate；实际采用分布由 Evidence Register 推导。完成消息只包含 Artifact 路径、验证状态、局限和未解决问题；它不是正式 branch result。

每个 discovery/assessment research task 还声明 `quantitative_competitive_scope`。Candidate discovery 使用 `broad_scan`，evaluation/assessment 使用 `targeted_deep_dive`。每个 Lane 只关闭 Dispatch 明确分配给它的 metric families 和 competitor types，不要求单 Lane 填满八个 family 或七类替代；candidate、Wave 和 report 聚合必须显示整体计划覆盖及缺口。Lane 在 task 指定路径提交 agent-authored `startup_opportunity.commercial_research_delivery.current`，Harness compiler 在同一路径生成 Harness-owned `startup_opportunity.commercial_research_audit.current`；Lane 不直接编写正式 Audit，也不写报告或其他 Lane 的输出。

一次交付包含研究目标与主要 routes、正式记录的 search results、Evidence 来源和内容、Finding/Claim/Judgment、量化与竞品 observation、未解决 Gap、limitations、停止原因和 telemetry 披露。找不到数据时可一次提交 attempted routes 与 `partial | unavailable | not_applicable`、decision impact，不因缺数据返修 JSON，也不得静默省略 Dispatch 分配的维度。ID、hash、revision、refs、freshness、来源分布、coverage closure、ranking 和 recommendation ceiling 由 Harness 派生。

G1.2 task envelope 使用 `tasks/<unit_id>.attempt-<n>.json`，只允许 main agent 发布。lane-researcher 只发布其 task lineage 下的 Evidence、Claim、Finding、Insight、Source Manifest 和唯一 branch output。task publication 只让 Run unit 进入 `active_units`；Harness 不创建 subagent。retry 必须显式 supersede 上一 attempt，`partial` retry 继续 fail closed，late/superseded result 不得回到 current artifact set。

G1.3 `add_unit` 只能新增一个 `buyer_language` 或 `acquisition` follow-up unit，owner 固定为 `lane-researcher`，必须依赖 Gap Snapshot 中实际观察到的已终止 unit，并使用唯一 output path 与 `concept_evidence_assessment_branch_result.v1`。它不是任意 DAG 入口；`stop_followup` 不创建 unit、retry wave 或 Plan revision。

同一 wave 中的 unit 必须相互独立，并拥有唯一 output path。发布带 `parallel_immediate` 的 dispatch batch 后立即并发启动所有独立 lane；Harness 不负责调度。subagent 绝不写入 manifest、Plan、Adaptation Decision、comparison policy、decision brief 或 report。fan-in 只消费已经验证的 Artifact，并保留 `partial`、`failed`、`cancelled`、`skipped`、`ignored-late` 和 `superseded` 状态，不得把缺失工作当作中性 Evidence。

每个外部研究 lane 在 completed、evidence insufficient、early stop 或搜索失败时都必须发布 Search Closure；综合/校验 lane 明确 `search_not_required`，搜索前失败明确 `failed_before_search`。Closure 保留正式记录的查询与结果、采用/拒绝理由、剩余缺口和终止原因，并与提交的 Evidence Register 对账，不要求还原未记录的探索查询。Harness 只验证收到的结构和 Store 引用，不观测或调度 Codex 搜索工具；telemetry 不可观测时如实使用 `unavailable` 和 `query_log_complete=false`。

分配到 Lane 的竞品对象记录 target segment、scenario、positioning、pricing/traction observation refs、strengths、weaknesses、differentiation gaps 和 source refs。新闻、评论、论坛、厂商披露、监管材料、API/数据集、proxy、estimate 以及支持、反对和背景材料都保留；用 source/evidence role、追溯状态和 limitations 约束其能支持的结论强度，不设置来源白名单。未追溯原始数据的新闻仍可支持背景、趋势、叙述和反证，但不能单独升级为直接购买、使用、留存或市场规模观察。

lane lifecycle 的 `execution_attempt_id` 是重试身份。`attempt_count` 为完整历史中不同 execution attempt id 的数量，`retry_count=max(0, attempt_count-1)`；receipt 幂等重放、checkpoint 重读、状态刷新和同一 attempt 内的 lifecycle revision 不算重试。最终状态取最新 attempt，因此多次失败后成功显示成功并保留累计重试数。

G2.4 enrichment 使用 `research_task.v3` 和唯一 `enrichment_branch_result.v1` output。每项 v3 material 必须绑定 exact task、frozen thesis snapshot、semantic merge、Scope、Plan 与 target opportunity；Evidence 还绑定 exact substrate record。只有 completed/partial/insufficient branch 可进入 enrichment fan-in material closure；failed/ignored-late/superseded 保持 excluded，reopen 不得把它们恢复为 current。
