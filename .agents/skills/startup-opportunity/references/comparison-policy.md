# Comparison Policy

Comparison 是决策辅助，不是客观概率模型。先执行 Hard Gate。通过的 Startup Opportunity 分别在四个独立 panel 中评估：`demand_and_market`、`solution_and_business`、`evidence_strength` 和 `team_fit_and_learning`。

每个 panel 使用可观察 anchor，返回 `strong`、`medium`、`weak`、`unknown` 或 `not_applicable`，并附支持/反对引用与局限。未知值必须保持 `unknown`。Evidence strength 控制 conclusion ceiling 与不确定性，不增加吸引力分数。相关 demand signal 不做机械求和；仅适用于 AI 的维度对非 AI 解决方案返回 `not_applicable`。

`team_fit_and_learning` 同时承载主 Agent 的机会启动负担与团队匹配分析。负担固定覆盖启动资本/开发复杂度、持续人工交付、获客与渠道依赖、合规/数据/专业责任、首次有效验证或收入时间；每维必须保留 assessment、supporting/opposing refs、limitations 和不完整状态。匹配分析只允许主 Agent填写 `match`、`conditional`、`mismatch` 或 `unknown`，并绑定 ScopeFrame、条件 IDs、未知前提及改变条件。团队上下文只接受硬约束、已知优势/短板和其他条件 `unknown`，不构成完整团队画像。

排序使用 pairwise dominance、downside/upside 关系、speed to learn 和 partial order。面向用户的输出可以识别稳健领先组、近乎无法区分的候选，或指出 Evidence 不足以排序。绝不展示伪精确的全局分数或成功概率。

policy 与 profile 均已发布并版本化。用户或 agent 可以通过 Decision Context 选择可用 profile，但不得在 active Run 中重新设置单个维度权重。G2.4 validator 对调用方显式提供的 hard gate、四面板、Evidence ceiling、pairwise/sensitivity、partial order、portfolio 和 recommendation 执行 closed consistency checks。repair policy 还沿 Opportunity selected Solution 解析 `uses_ai`，在 G3 bundle 缺失时强制 `ai_mandatory_bundle=insufficient_evidence`。每个候选分别受自己的 comparison、fan-in、hard gates、panel sufficiency 和 Harness-derived commercial subject aggregate ceiling 约束；alternative 或其他 top candidate 不压低 first bet，但也不得超过自身 ceiling。first bet 切换后读取新 subject ceiling。null first bet 不得 `prioritize`，其最高 tier 取最佳候选 readiness：`investigate_further`、其次 `watch`，均不满足则 `insufficient_evidence`，而不是取展示集合中最弱候选。`calculate-comparison` 与 `calculate-sensitivity` 只读验证并摘要这些 Artifact；它们不生成 panel band、Judgment、排名或推荐。

团队匹配不会改变既有 panel tier、Evidence ceiling 或 hard-gate readiness，也不会成为自动硬拒绝；只有用户明确的 Scope 硬约束和主 Agent 的共同判断才能在排序/处置中产生明确影响。高负担、反证、弱证据和所有不完整状态继续进入比较与报告。
