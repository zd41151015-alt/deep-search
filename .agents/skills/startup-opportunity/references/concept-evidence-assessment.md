# Concept Evidence Assessment

`assess` 为一个具体产品或功能 thesis 创建 `concept_evidence_assessment` Run。G1.1 的 static assess contract 保持不变；G1.2 新增 `document_bundle.v5`、typed Research Task、public/user-provided Evidence substrate、Evidence/Claim/Finding/Insight/Source Manifest 与 branch publication/recovery。Harness 只处理显式输入，不自动启动 `assess`、分派 lane 或获取来源。

每个 research branch 必须指向同一个 concept hypothesis。必需的 desk-research 维度覆盖 target user 与 JTBD、需求与行为、替代方案与解决方案失败、竞争饱和度与差异化、买方语言与支付意愿、获客与分发、business engine 可行性、交付可行性、合规/平台风险和 counter-evidence。AI profile 还必须加入其 mandatory capability bundle。

assessment result 只有 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence`。G1.2 固定 `Branch Result -> Insight -> Finding -> Claim -> Evidence` 引用方向与 same-Run/subject/scope/plan/unit/attempt lineage，但不执行完整 Evidence conclusion ceiling、Hard Gate、audit、adversarial review 或 report consistency；这些仍由 G1.4 拥有。缺少外部行为、承诺或交易 Evidence 会限制置信度，但不会自动算作反对 Evidence。

该 mode 不生成 TopN opportunity pool，也不执行或跟踪访谈、landing page、定金、付费实验或 MVP 测试。
