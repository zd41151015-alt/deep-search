# Report Contract

每个可交付终态 Run 都有一个结构化审计来源和两个用户 Markdown view：

```text
validated artifacts -> report.json -> decision-brief.md -> report.md -> audit-appendix.md -> consistency evaluation
```

decision brief 是默认用户入口。它说明决策问题、当前建议及其含义、决定性的支持与反对 Evidence、未选替代方案、关键未知项、能够改变决策的 Evidence、belief update、有效日期、scope 和局限。不能为了简短而省略强 counter-evidence。

v17 terminal source 适用于完整结论和提前收口，不要求伪造未执行的 comparison、portfolio 或 assessment stage。它分别声明 `execution.completeness`、`research_conclusion` 和 `runtime_health`，并显式列出未完成阶段、required follow-up、pending operation 和工程问题。terminal source 只能随 `apply-plan-revision` 的正式终止动作提交，由同一 durable intent 在 Manifest 变为终态前闭合 source、三张 sidecar 和三个 materialized view；`build-report` 不接受 terminal source。只有 source 与正式 terminal Manifest 匹配、三视图闭合且 `status-run` 返回 `terminalReportDisposition=ready` 才能交付。

Decision Brief 按 canonical `research_language` 本地化 Harness 自己生成的固定文案、状态、内部枚举与机械 inference/reason 文案；结构化 terminal source 与 Audit 的 exact prose/ref/hash 真值不被翻译覆盖。用户正文先给动作建议，再展示带名称、链接、有效日期、立场和强弱的可读来源；错误码、内部 stage、文件/Schema/Manifest/Validator 名、堆栈、Gap 和内部路径只保留在日志或结构化审计数据，不进入 Decision Brief 或完整报告正文。`zh-CN` 用户正文使用自然业务语言并执行确定性的内部术语 leakage guard；来源原始标题与 URL 可以保留，不对所有用户字段做无边界的词表扫描。

Discovery 报告必须清楚分开三层：Scope 当前已知团队条件（硬约束、优势/短板、其他条件 `unknown`）、每个机会自身的五维启动负担、以及主 Agent 对该机会的匹配结论和未知前提。匹配结论只能是 `match`、`conditional`、`mismatch` 或 `unknown`；`unknown` 团队信息不得被渲染成无条件“适合当前团队”，也不得阻止机会保留和完整研究。Portfolio 的显式排序逐项绑定 comparison 与主 Agent 匹配分析，同时保留其他研究维度和限制；允许并列、局部排序和明确未排序。Harness 从 exact Scope、Comparison、Portfolio 与 Opportunity title 机械投影 `team_decision_summary` 供报告渲染，Agent 不手写该机械摘要；Harness 不计算匹配或排序。

每个方向必须直观写清谁使用、什么场景、什么问题、产品具体做什么、当前替代、谁付款、为何现在值得看。商业维度在审计来源中明确区分 `observed`、`inferred` 和 `unknown`；用户正文可以保留有依据的推测，但必须呈现依据、推理、不确定性和待验证项，不能写成已观察事实。没有直接商业材料支持的方向不能成为第一优先或已成立机会，只能是未排序待验证假设；Vendor-only 方向也保持低置信度待验证，直到有独立或行为材料验证。

Discovery 的 `report.json`、Decision Brief 与完整报告必须从同一 exact Merge family projection 展示独立机会家族数、具体方向数、unknown family relation、每个 family 的共享机制/风险和 member-specific 差异。Markdown 必须显示共享机制 state，并对每个 member difference 显示 dimension、state 和 description；unknown、unavailable、inferred、not_applicable、no_evidence_found 等状态不得在用户报告中升格成已声明事实。报告保留每个方向自己的 ranking、readiness、ceiling 与 Evidence；同一 family 的多个 segment 不得被无条件叙述为多个独立创业机会。请求固定数量机会时仍以正式投影如实写成“X 个机会家族、Y 个具体方向”，允许只有一个 family，不为凑数制造或删除方向。

所有正式完整报告固定包含量化信号表、竞品/广义替代矩阵、头部公司吸收与响应风险表和数据缺口表。量化表显示 metric family/name/value、definition、地域、周期、measurement type、可比性、误差/不确定性和 Evidence refs；竞争矩阵显示 direct/adjacent product、service、platform、manual workaround、status quo、non-consumption 的定位、价格/traction refs、优势、弱点和差异化缺口；响应表显示 subject/depth/state、responder/category/control point、response modes、ability/cost、incentive/disincentive/cannibalization、horizon、distribution leverage、thesis coverage、residual differentiation、supporting/opposing/background Evidence、inference boundary、uncertainty/gap 和 Harness 固定生成的 reference-only strategic context，并在有行和空表两种情况下固定显示 context-only/非门禁声明。报告 projection 与 renderer 不接受或转述 Agent authored pass/fail、淘汰、行动或 recommendation ceiling 文本。`unknown` 同时投影到数据缺口表，保留其可选 supporting/opposing/background refs，但强风险维度继续显示为 unknown/空；有 refs 和无 refs 的统一 rationale 都只说明提交材料与 assessment 语义不足以形成完整 responder-specific conclusion，不声称没有 assessment、没有调研或 Evidence Register 中不存在材料。`not_applicable` 不形成缺口；两者都不能静默省略。

响应风险表只提供战略判断上下文。报告不得把高 ability 写成必然响应，不得把 feature copying 写成完整 thesis 已覆盖，也不得把该表本身解释为淘汰、unrank、Claim confidence reduction 或 recommendation ceiling 的确定性原因。任何实际影响排序或建议的使用都必须出现在 agent-authored synthesis 的可解释文本中，并继续受原有 Evidence、comparison 和 recommendation contracts 约束。

完整 report 在相同 judgment context 上展开来源链、业务对象、比较或评估维度、风险、停止条件、来源审计，以及可选的用户自主管理验证建议。它不得引入 `report.json` 中不存在的结论，也不得把 assessment 描述为已完成的市场验证。最终主体顺序来自 Manifest-authoritative snapshot；每个 synthesis 只保留本地 1..N 验证顺序，Harness 按主体顺序机械派生报告全局 1..N。最终 source 必须纳入原 Run 的全部 validated Evidence：采用的来源进入结论链，未采用的来源保留明确排除理由；所有计划 lane 都必须有 Search Closure 后才能发布。

生成过程由已经验证的引用和 policy version deterministic 驱动。G1.4 assessment 与 G2.4 discovery 都使用 immutable JSON sidecar、receipt 和 fixed materialized paths；exact replay 必须保持字节不变，冲突或 receipt/source/hash drift 必须 fail closed。G2.4 v13 从 validated `report.v1` 确定性派生 Decision Brief v2、Discovery Report View 和 Consistency Evaluation v3；v3 对 structured report、Decision Brief Markdown 和完整 Report Markdown 执行同一 versioned deterministic scan，并拒绝 ref/hash/freshness/limitations/counter-evidence/partial-order/evidence-ceiling/external-boundary 漂移、新结论、validation-success、概率或 global-score 表述。任何命中都必须在 publication/materialization/reopen/recovery 前 fail closed，caller 不能用空 matches 或固定 `passed` 覆盖扫描结果。
