# Concept Evidence Assessment

`assess` 为一个具体产品或功能 thesis 创建 `concept_evidence_assessment` Run。G1.1 的 static assess contract 保持不变；G1.2 新增 `document_bundle.v5`、typed Research Task、public/user-provided Evidence substrate、Evidence/Claim/Finding/Insight/Source Manifest 与 branch publication/recovery。Harness 只处理显式输入，不自动启动 `assess`、分派 lane 或获取来源。

G1.3 对 plan r1 后已发布的 buyer 或 acquisition Branch Result 形成 `gap_snapshot.v2`。Snapshot 必须绑定 exact Run、ConceptHypothesis、ScopeFrame/hash、current Research Plan/ref/revision/hash、assessment plan/ref/revision/hash、coverage_key、observed branch/task hash 和 unit/attempt/state。`adaptation_decision.v3` 只有 `add_unit` 与 `stop_followup`：合法 Evidence 缺口可生成 bounded Research Plan r2 与 assessment plan r2；coverage 已充分、没有 material new Evidence 或没有 executable follow-up 时停止且不创建 revision。chat 与 task summary 不能替代这些 Artifact。

每个 research branch 必须指向同一个 concept hypothesis。必需的 desk-research 维度覆盖 target user 与 JTBD、需求与行为、替代方案与解决方案失败、竞争饱和度与差异化、买方语言与支付意愿、获客与分发、business engine 可行性、交付可行性、合规/平台风险和 counter-evidence。AI profile 还必须加入其 mandatory capability bundle。

assessment result 只有 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence`。G1.4 用 Evidence audit、独立 Adversarial Review、closed Hard Gates 和 conclusion ceiling 机械校验显式最终 Assessment；`prioritize` 只表示当前 Evidence 支持优先关注，不表示市场已验证。决定性低等级、stale、single/overlap source、unavailable source 或 mandatory dimension 缺失必须限制或阻止方向性结论；高质量反证与 thesis-killing opposition 可以触发 `deprioritize`。缺少系统职责外的行为、承诺、交易或实验 Evidence 只形成 ceiling、critical gap 或 limitation，不能自动算作反对 Evidence。

该 mode 不生成 TopN opportunity pool，也不执行或跟踪访谈、landing page、定金、付费实验或 MVP 测试。
