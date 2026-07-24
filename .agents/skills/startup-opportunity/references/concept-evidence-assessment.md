# Concept Evidence Assessment

`assess` 为一个具体产品或功能 thesis 创建 `concept_evidence_assessment` Run。该 vertical slice 由 G1 负责，在 G0.4 尚不可运行。

每个 research branch 必须指向同一个 concept hypothesis。必需的 desk-research 维度覆盖 target user 与 JTBD、需求与行为、替代方案与解决方案失败、竞争饱和度与差异化、买方语言与支付意愿、获客与分发、business engine 可行性、交付可行性、合规/平台风险和 counter-evidence。AI profile 还必须加入其 mandatory capability bundle。

assessment result 只有 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence`。在 agent 解释结果前，deterministic gate 先强制执行 mandatory coverage、Evidence conclusion ceiling 和 hard failure。缺少外部行为、承诺或交易 Evidence 会限制置信度，但不会自动算作反对 Evidence。

该 mode 不生成 TopN opportunity pool，也不执行或跟踪访谈、landing page、定金、付费实验或 MVP 测试。
