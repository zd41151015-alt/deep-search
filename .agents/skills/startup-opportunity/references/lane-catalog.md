# Lane Catalog And Handoff

Research unit 使用已发布的 unit type 和三个稳定 custom-agent role 之一。planner 不得自行发明 role、Artifact schema、权限或输出位置。

lane researcher 负责有界来源发现、支持与反对 Claim、Finding、局限、未解决问题，以及唯一一个指定 branch Artifact。evidence auditor 独立检查引用是否存在、引文忠实度、支持关系、独立性、偏差、freshness 和立场平衡。adversarial reviewer 使用独立挑战查询攻击综合结论，并记录修订请求或足以改变结论的 gap。

每个 subagent 都会收到 task envelope，其中包含 run id、unit id、mode、research goal、input references、唯一允许的 output path、required Artifact schema、required support/opposition stances、工具指引、stop conditions 和 completion-message contract。完成消息只包含 Artifact 路径、验证状态、局限和未解决问题；它不是正式 branch result。

同一 wave 中的 unit 必须相互独立，并拥有唯一 output path。subagent 绝不写入 manifest、Plan、Adaptation Decision、comparison policy、decision brief 或 report。fan-in 只消费已经验证的 Artifact，并保留 `partial`、`failed`、`cancelled`、`skipped`、`ignored-late` 和 `superseded` 状态，不得把缺失工作当作中性 Evidence。
