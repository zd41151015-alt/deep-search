# Research Kernel

Research Kernel 是可复用的 lane 方法，不是顶层 orchestrator 或隐藏服务。agent 定义 research goal，搜索并阅读有代表性的来源，记录 Evidence，提取 Claim，综合 Finding 与 Insight，并提出与决策相关的问题。Harness 负责验证和存储由此产生的 Artifact。

记录来源时先通过 `record-evidence` 保存调用方已取得的 raw bytes，再用 v5 envelope 发布 materialized Evidence。public source 使用 canonical HTTP(S) URL；user-provided existing material 使用保留 URN。Agent 必须显式填写 provenance、independence、bias、freshness、representativeness 与 limitations；不得让 Harness 根据 URL 或内容猜测。chat 和 task completion message 永远不是正式 Evidence 或 branch Artifact。

G2.4 enrichment Evidence 使用 v3 document/v12 或 repaired v13 envelope，但仍只绑定 `record-evidence` 已持久化的 exact v2 substrate record；版本升级不授权 Harness 获取来源、推断 provenance 或把 synthetic/unknown material 提升为真实 Evidence。

正式记录的查询保留 query text、searched_at、候选结果、采用来源、拒绝来源与理由，以及仍未覆盖的商业维度。每个计划 lane 的所有终态都要留下 Search Closure；纯综合/校验标为 `search_not_required`，搜索前失败标为 `failed_before_search`，开始搜索后的失败保留已有记录。只在正式提交的 search results 与 Evidence Register 之间对账，不要求还原未记录的探索查询。当前 Harness 不拦截 Codex 浏览器或搜索工具调用；`telemetry_basis=unavailable` 时研究目标、主要 route、采用来源、已有记录和停止原因足够，`query_log_complete=false` 是正常披露，不得伪装为 Harness 已记录或完整 telemetry。

量化 acquisition 是 agent/caller 的显式动作，不是 Harness 网络能力。来源可以是任意合法可访问的公开 API、已授权商业 API、官方或下载数据集、用户/仓库数据或网页；没有 provider/endpoint allowlist，API 也不是必选。每次 acquisition 都把脱敏 endpoint/query、provider、method、retrieved_at、raw response ref/hash、access basis 和 limitations 绑定到 exact Evidence substrate。不得保存 credential、Cookie、Token 或敏感 header，不得绕过登录、付费、验证码或访问控制。

来源时间分别记录 `retrieved_at`、`published_at`、`observed_at` 与 `data_period_end`。`valid_as_of` 由规则按 `data_period_end -> observed_at -> published_at` 推导，`retrieved_at` 只作审计，不能刷新来源年龄。当前价格、产品与竞品公开信息可用近期页面观察；当前用户语言、购买、渠道、竞品使用、留存和市场变化必须落在 claim-specific 窗口内。今天抓取的旧论文仍只能支持机制、历史基线、作用边界和反证，不能称为新鲜市场信号。

默认投入分配为：60%-70% 用户语言、行为、购买、价格、替代、渠道和留存，15%-20% 经营披露、监管和市场结构，不超过 20% 学术机制、作用边界和反证。这只是查询规划提示，不要求实际检索次数严格符合比例；最终采用来源的实际分布由 Evidence Register 推导，偏差只观察、不门禁。覆盖不足或来源偏弱保留为 `partial | unavailable | not_applicable`、warning 和局限，并降低 Claim confidence、ranking eligibility 或 recommendation ceiling；只有真实性、安全、exact ref/hash、数值/proxy 语义以及结论越过 Evidence ceiling 才阻塞发布。学术材料可以保留用于机制、边界、历史背景和反证，但不得冒充 buyer、pricing、distribution、retention 或 unit economics 的直接观察。

遵循 preserve first, weight later：新闻、评论、论坛、厂商披露、监管材料、API/数据集、proxy、estimate 和支持/反对/背景材料均保留，不设置来源白名单。每个商业维度明确区分 `observed`、`inferred` 和 `unknown`；一个来源可以覆盖多个维度，但每个维度都要有自己的数据点、摘录或明确事实。缺少直接材料时，能合理推测就保留为 `inferred` 并写清依据引用、推理起点、推理过程、不确定性和待验证项；无法合理推测才是 `unknown`。来源类型、证据角色、freshness、独立性和局限决定 Claim 强度，不把弱材料过滤成不存在。

量化/竞争 audit 另用 `observed | partial | unavailable | not_applicable` 表达 coverage。量化 observation 必须记录 definition、地域、周期、measurement/estimation、sample/population、误差、不确定性和可比性；rank、ratings、downloads、MAU 等 proxy 不得冒充购买、付费人数或市场验证。每个 `partial`/`unavailable` 维度保留查询尝试、原因、替代指标和 decision impact，不为补 schema 伪造数值。

厂商材料可以证明其公开报价、宣称功能、定位和“厂商作出某项声明”，应保留为 `vendor_claim`；它不能单独证明真实购买、价格接受度、效果、留存或市场规模。Vendor-only 候选可作为低置信度、未排序待验证假设并披露独立材料缺口，只有与行为数据或独立来源交叉验证后才能升级。

follow-up 可处理重大的支持/反对失衡、来源独立性不足、baseline 不清晰、缺少买方或获客 Evidence、AI bundle 不完整、审查者挑战，或决定性 Evidence 过期。这些观察必须先形成 Gap Snapshot。只有在已验证 Adaptation Decision 变更不可变 Plan 后，才能开始新工作。

达到已发布的 follow-up 上限、完整一轮没有产生重要新 Evidence、更多 Evidence 无法改变决策、可访问来源只是在重复同一样本，或用户要求停止时，就必须停止。Evidence 缺失时应 abstain 或降低 conclusion ceiling，绝不能用模型记忆替代。
