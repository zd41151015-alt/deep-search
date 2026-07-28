# Research Kernel

Research Kernel 是可复用的 lane 方法，不是顶层 orchestrator 或隐藏服务。agent 定义 research goal，搜索并阅读有代表性的来源，记录 Evidence，提取 Claim，综合 Finding 与 Insight，并提出与决策相关的问题。Harness 负责验证和存储由此产生的 Artifact。

记录来源时先通过 `record-evidence` 保存调用方已取得的 raw bytes，再用 v5 envelope 发布 materialized Evidence。public source 使用 canonical HTTP(S) URL；user-provided existing material 使用保留 URN。Agent 必须显式填写 provenance、independence、bias、freshness、representativeness 与 limitations；不得让 Harness 根据 URL 或内容猜测。chat 和 task completion message 永远不是正式 Evidence 或 branch Artifact。

G2.4 enrichment Evidence 使用 v3 document/v12 envelope，但仍只绑定 `record-evidence` 已持久化的 exact v2 substrate record；版本升级不授权 Harness 获取来源、推断 provenance 或把 synthetic/unknown material 提升为真实 Evidence。

每个查询都要明确 query text、research goal、target subject、预期 Evidence 类型、地域、语言、时间范围、来源偏好和 stop condition。原始来源内容保留在 Evidence Store；下游 context 通常只携带 typed summary 和引用。引文或决定性 Claim 需要审计时，按 Evidence 引用重新读取来源原文。

follow-up 可处理重大的支持/反对失衡、来源独立性不足、baseline 不清晰、缺少买方或获客 Evidence、AI bundle 不完整、审查者挑战，或决定性 Evidence 过期。这些观察必须先形成 Gap Snapshot。只有在已验证 Adaptation Decision 变更不可变 Plan 后，才能开始新工作。

达到已发布的 follow-up 上限、完整一轮没有产生重要新 Evidence、更多 Evidence 无法改变决策、可访问来源只是在重复同一样本，或用户要求停止时，就必须停止。Evidence 缺失时应 abstain 或降低 conclusion ceiling，绝不能用模型记忆替代。
