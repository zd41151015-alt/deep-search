# Concept Evidence Assessment

`assess` 为一个具体产品或功能 thesis 创建 `concept_evidence_assessment` Run。G1.1 已发布 intake、DecisionContext、ScopeFrame、ConceptHypothesis、assessment plan/branch/fan-in、JudgmentAssessment、Hypothesis Evidence Matrix、BusinessEngine 和 Assessment 的 closed static contract；`validate-artifact` 可离线校验显式 `document_bundle.v4`。`assess` 执行、research branch、Evidence persistence 与 v4 Store publication 仍未开放。

每个 research branch 必须指向同一个 concept hypothesis。必需的 desk-research 维度覆盖 target user 与 JTBD、需求与行为、替代方案与解决方案失败、竞争饱和度与差异化、买方语言与支付意愿、获客与分发、business engine 可行性、交付可行性、合规/平台风险和 counter-evidence。AI profile 还必须加入其 mandatory capability bundle。

assessment result 只有 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence`。G1.1 只校验静态 identity、lineage、typed refs、mandatory dimension、branch/fan-in、Judgment、Matrix、BusinessEngine 与 Assessment 一致性；完整 Evidence conclusion ceiling、hard failure 和 decision-readiness gate 由后续 G1 切片负责。缺少外部行为、承诺或交易 Evidence 会限制置信度，但不会自动算作反对 Evidence。

该 mode 不生成 TopN opportunity pool，也不执行或跟踪访谈、landing page、定金、付费实验或 MVP 测试。
