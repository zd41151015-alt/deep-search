# Lane Catalog And Handoff

Research unit 使用已发布的 unit type 和三个稳定 custom-agent role 之一。planner 不得自行发明 role、Artifact schema、权限或输出位置。

lane researcher 负责有界来源发现、支持与反对 Claim、Finding、局限、未解决问题，以及唯一一个指定 branch Artifact。evidence auditor 独立检查引用是否存在、引文忠实度、支持关系、独立性、偏差、freshness 和立场平衡。adversarial reviewer 使用独立挑战查询攻击综合结论，并记录修订请求或足以改变结论的 gap。

每个 subagent 都会收到 task envelope，其中包含 run id、unit id、mode、research goal、input references、唯一允许的 output path、required Artifact schema、required support/opposition stances、工具指引、stop conditions 和 completion-message contract。完成消息只包含 Artifact 路径、验证状态、局限和未解决问题；它不是正式 branch result。

G1.2 task envelope 使用 `tasks/<unit_id>.attempt-<n>.json`，只允许 main agent 发布。lane-researcher 只发布其 task lineage 下的 Evidence、Claim、Finding、Insight、Source Manifest 和唯一 branch output。task publication 只让 Run unit 进入 `active_units`；Harness 不创建 subagent。retry 必须显式 supersede 上一 attempt，`partial` retry 继续 fail closed，late/superseded result 不得回到 current artifact set。

G1.3 `add_unit` 只能新增一个 `buyer_language` 或 `acquisition` follow-up unit，owner 固定为 `lane-researcher`，必须依赖 Gap Snapshot 中实际观察到的已终止 unit，并使用唯一 output path 与 `concept_evidence_assessment_branch_result.v1`。它不是任意 DAG 入口；`stop_followup` 不创建 unit、retry wave 或 Plan revision。

同一 wave 中的 unit 必须相互独立，并拥有唯一 output path。subagent 绝不写入 manifest、Plan、Adaptation Decision、comparison policy、decision brief 或 report。fan-in 只消费已经验证的 Artifact，并保留 `partial`、`failed`、`cancelled`、`skipped`、`ignored-late` 和 `superseded` 状态，不得把缺失工作当作中性 Evidence。

G2.4 enrichment 使用 `research_task.v3` 和唯一 `enrichment_branch_result.v1` output。每项 v3 material 必须绑定 exact task、frozen thesis snapshot、semantic merge、Scope、Plan 与 target opportunity；Evidence 还绑定 exact substrate record。只有 completed/partial/insufficient branch 可进入 enrichment fan-in material closure；failed/ignored-late/superseded 保持 excluded，reopen 不得把它们恢复为 current。
