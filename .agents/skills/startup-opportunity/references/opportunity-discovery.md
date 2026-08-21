# Opportunity Discovery

`discover` 从宽泛的消费行业、用户群、场景或能力变化创建 `opportunity_discovery` Run。当前 Harness 开放调用方显式提供的 G2.1 maps、G2.2 typed candidate/lane/fan-in、G2.3 conversion/formal thesis/evaluation/freeze/merge，以及 G2.4 enrichment/Business Engine/comparison/portfolio/report 的 closed validation/publication/reopen；`discover` orchestration、lane execution 和任何 research/thesis/enrichment/comparison 语义生成仍不可运行。

G2.3 Merge 同时承载 main Agent 的机会家族声明。每个 frozen Opportunity 必须恰好属于一个独立机会、共享 family 下的 segment/delivery variant 或 unknown 关系；Harness 不自动形成 family，只机械投影 exact selected Solution facts 并校验闭包与 merge/family 交叉一致性。多成员 `decision=merge` 只能落在同一个 shared family 的 segment/delivery members 内；split/preserve 不反向强制拆开 shared family。所有 Opportunity 继续进入 G2.4 独立研究与比较，family 只约束用户可见的“独立机会数量”表述和共享机制/风险展示。

Discovery fan-in 完成后，进入 G2.3 synthesis 前必须先发布当前 Plan、fan-in 和执行 stage 绑定的 exact Readiness artifact pair：`startup_opportunity.discovery_stage_readiness.v1` 与 `startup_opportunity.gap_snapshot.discovery.readiness.current`。只有 Readiness 为 `ready`、无 blockers、下一 stage 为 `discovery_synthesis`，且每个当前 Plan question 都由同一 Run 的正式 Judgment disposition（包括 unknown、opposing、partial 或 insufficient evidence）覆盖时，才能发布 conversion/thesis synthesis。Generic Plan Gap 即使 `gaps=[]` 也只用于 Plan adaptation，不能替代 post-fan-in readiness；unresolved、method boundary、runtime blocked 和 terminal 状态必须通过 Readiness/Gap 保持可见并走 bounded follow-up 或 evidence-insufficient termination。

正式方向形成前先做方案中立的用户语言、买方、价格、替代、渠道和商业行为扫描；这一阶段不得做具体方案的定价、获客或留存评估。形成具体方向后，才可深挖该方案的定价、获客、留存、单位经济和合规。产品或 AI seed 只是搜索输入，不是机会成立的证据。

方案中立阶段同时执行 provider-agnostic `broad_scan`，方向形成后执行 `targeted_deep_dive`。每个 Lane 只对 Dispatch 分配的量化 family 和广义替代类型声明 `observed | partial | unavailable | not_applicable`；缺数据保留 attempted routes、原因、替代指标、limitations 和排序影响。八个量化 family 与七类替代的整体计划覆盖由 candidate/Wave/report 聚合显示。API 只是可选 acquisition method，Harness 不代 agent 查询。

Incumbent Absorption & Response Risk 不得进入 solution-neutral candidate generation。候选形成后的 evaluation 对 assigned candidates 做 bounded lightweight scan；只有 shortlist/retained opportunities 才由 immutable Execution Plan/Dispatch 分配 targeted deep dive。潜在 responder 不限同类公司，也包括 platform/suite owner、adjacent leader、channel/distribution controller、data owner 和 marketplace。分别判断 ability、五类响应成本、incentive/cannibalization、horizon、distribution leverage、thesis coverage 与 residual differentiation；不得由 ability 高推导一定响应或候选失败。Agent 只提交这些结构化研究维度与 Evidence/不确定性，不编写 pass/fail、淘汰、行动、推荐上限或正式 strategic implication；Harness 固定生成 validator 可验证的 reference-only strategic context。该分析只作为综合判断上下文，不改变 ranking eligibility、Claim confidence 或 recommendation ceiling；缺材料发布 `unknown`，其正式表述只说明材料与语义不足以形成完整结论，不声称没有 assessment 或 Evidence；不适用发布 `not_applicable`。

可排序方向必须同时具备近期、直接的用户语言、购买/付费信号、竞品或非产品替代及价格/使用信号、现实分发渠道和独立反对材料。各维度必须分别提供对应数据点或摘录；有依据的推测保留为 `inferred` 并披露推理与不确定性，但不能满足排序 Gate。缺少购买、价格或渠道时只能列为未排序待验证假设；Vendor-only 方向可以留在候选池，但没有独立/行为交叉验证前保持低置信度。Wave 1 连需求、买方和购买信号都没有时，停止方案评估并输出证据不足及待补维度。

Lane result 在 user、JTBD、entry scene、buyer model、delivery form 和 opportunity source 之间保留候选多样性。它们返回支持与反对 Claim、pre-kill decision、retained/watchlist/rejected 引用、Evidence sufficiency 和局限。只有 core thesis、assumption 和 kill criteria 冻结后，才能开始 enrichment。

最终 discovery 输出使用 Hard Gate、四个独立 comparison panel、sensitivity、partial-order relation、建议的 first bet、替代方案和明确局限。绝不把全局分数表示为客观成功概率。

最终报告固定输出量化信号表、竞品/替代矩阵、头部公司吸收与响应风险表和 coverage gap 表。响应风险表展示 responder/control point、ability/cost、incentive、horizon、distribution leverage、thesis coverage、residual differentiation、正反/背景 Evidence、uncertainty/gap 和 Harness-owned reference-only strategic context；未分配、缺研究或不适用也必须显示，不能静默省略。每条量化信号显示 metric definition、地域、周期、measurement type、可比性和 uncertainty；排名、评分人数、下载、MAU、收入估算和付费人数保持不同语义，跨地域/周期/类别/口径不可直接横比。

G2.4 repair contract 沿 Opportunity 的 exact selected Solution 解析 `uses_ai`；缺少 G3 mandatory bundle 的 AI/hybrid chain 必须保持 `insufficient_evidence` 且结论不高于 `investigate_further`。`prioritize` 还要求 first bet、comparison、fan-in、Portfolio 和四个 panel 全部达到 closed readiness；混合状态采用最严格 ceiling。`candidate_pre_killed` 只能 skip 唯一消费该 exact candidate revision 的 pending unit，共享候选 unit 必须保留或 supersede。
