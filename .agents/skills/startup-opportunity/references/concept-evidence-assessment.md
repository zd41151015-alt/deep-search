# Concept Evidence Assessment

`assess` 为一个具体产品或功能 thesis 创建 `concept_evidence_assessment` Run。G1.1 的 static assess contract 保持不变；G1.2 新增 `document_bundle.v5`、typed Research Task、public/user-provided Evidence substrate、Evidence/Claim/Finding/Insight/Source Manifest 与 branch publication/recovery。Harness 只处理显式输入，不自动启动 `assess`、分派 lane 或获取来源。

G1.3 对 plan r1 后已发布的 buyer 或 acquisition Branch Result 形成 `gap_snapshot.v2`。Snapshot 必须绑定 exact Run、ConceptHypothesis、ScopeFrame/hash、current Research Plan/ref/revision/hash、assessment plan/ref/revision/hash、coverage_key、observed branch/task hash 和 unit/attempt/state。`adaptation_decision.v3` 只有 `add_unit` 与 `stop_followup`：合法 Evidence 缺口可生成 bounded Research Plan r2 与 assessment plan r2；coverage 已充分、没有 material new Evidence 或没有 executable follow-up 时停止且不创建 revision。chat 与 task summary 不能替代这些 Artifact。

每个 research branch 必须指向同一个 concept hypothesis。具体方向形成后才进入方案定价、获客、留存、单位经济与合规深挖。必需维度覆盖 target user 与 JTBD、需求与行为、替代方案与解决方案失败、竞争饱和度与差异化、买方语言与支付意愿、获客与分发、business engine 可行性、交付可行性、合规/平台风险和 counter-evidence。商业行为材料占主要规划投入，实际采用分布由 Evidence Register 推导且比例偏差不门禁；学术材料只补充机制、作用边界和反证。每个维度区分 observed/inferred/unknown，推测不得冒充直接事实。厂商材料可支持公开报价、产品、定位和厂商声明，但不得独立证明购买、价格接受度、效果、留存或市场规模。AI profile 还必须加入其 mandatory capability bundle。

每个 branch 按 Dispatch 分工完成 provider-agnostic `targeted_deep_dive` commercial delivery，只关闭明确分配的量化 family 和广义替代类型，并绑定 exact raw Evidence acquisition provenance。Harness 将 Delivery 编译为正式 Audit；八个稳定量化 family 与七类替代的整体覆盖在 candidate/Wave/report 聚合。没有数据时一次交付 attempted routes、`partial | unavailable | not_applicable`、未解决 Gap、limitations 和 decision impact，不因研究不足返修 JSON；proxy、未追溯新闻或估算保留但不能冒充购买人数、付费人数、收入 observation 或市场验证。

assessment result 只有 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence`。G1.4 用 Evidence audit、独立 Adversarial Review、closed Hard Gates 和 conclusion ceiling 机械校验显式最终 Assessment；`prioritize` 只表示当前 Evidence 支持优先关注，不表示市场已验证。决定性低等级、stale、single/overlap source、unavailable source 或 mandatory dimension 缺失必须限制或阻止方向性结论；高质量反证与 thesis-killing opposition 可以触发 `deprioritize`。缺少系统职责外的行为、承诺、交易或实验 Evidence 只形成 ceiling、critical gap 或 limitation，不能自动算作反对 Evidence。

该 mode 不生成 TopN opportunity pool，也不执行或跟踪访谈、landing page、定金、付费实验或 MVP 测试。
