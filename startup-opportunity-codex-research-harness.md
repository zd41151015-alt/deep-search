# RFC: 基于 Codex Research Harness 的创业机会调研 Agent

> **状态**: 提案
> **创建日期**: 2026-07-23
> **目标版本**: Codex-native v1
> **方案范围**: 本文完整定义创业机会调研的业务原则、lane、领域模块、数据模型、比较、Artifact、决策简报、报告和验收合同，并使用 Codex Harness 的引用式产物模型实现；通用 Workflow Runtime、Macro Routing 和 Agent 执行预算不在本文范围内。首版不采集用户侧外部验证预算，不提供运行时人工动态调权，也不执行多国家统一比较和排名

## 1. 决策摘要

创业机会调研不以独立 Web 工作台、通用 Workflow Definition、Dynamic Graph Runtime、Feature Registry 或容器 IPC 为基础。首版直接运行在 Codex 中，并在当前仓库建设一个领域专用的 Research Harness。

最终架构决策如下：

- Codex 桌面主窗口是主要交互入口，用户可以在调研过程中持续补充信息、改变范围、暂停、恢复或要求深入某个方向。
- 用户通过一个通用 Skill `$startup-opportunity` 发起、恢复、查询创业机会调研。
- 主 Agent 负责决策问题澄清、范围冻结、研究规划、subagent 调度、gap analysis、综合判断、决策简报和最终报告。
- Subagents 负责边界清晰、可并行的研究 lane、证据审计和对抗式复核。
- Skill 定义可复用方法，custom agent 定义角色，脚本执行确定性操作，MCP 提供外部数据工具，hooks 只承担生命周期约束和记录。
- 仓库内 Research Harness 负责 run 状态、Decision Context、Evidence Store、artifact schema、引用校验、checkpoint、幂等写入、比较、决策简报和报告生成。
- 每个 research wave 后由结构化 Gap Snapshot 汇总已收集数据中的缺口和停止信号；主 Agent 只能通过受控 Adaptation Decision 提议追加、取消、跳过、重试、替换或停止研究动作，Harness 校验后生成不可变 Plan Revision。
- 聊天消息和 subagent 最终回复不是正式事实源。正式事实源是 `runs/<run_id>/` 下通过校验的结构化产物。
- 首版不实现 token、cost、lifetime budget、resource ledger 或精细预算统计。
- 首版不采集用户可投入的外部验证金额、人数或资源预算；验证建议只披露相对 effort，不声称适配用户的实际预算。
- 首版仍保留最大 follow-up 轮数、无新证据停止、证据充分性和用户主动停止等收敛条件，避免研究无限展开。
- 一个 Run 只研究一个 primary market 和一个 primary language；多国家请求拆成独立 Run，首版不对不同国家的分数做统一校准或排名。
- 本项目不实现一个新的通用 workflow engine。所有运行状态和脚本都只服务创业机会调研领域。

```text
用户 / Codex 主窗口
  -> $startup-opportunity
  -> 主 Agent: intake / scope / plan / orchestration
  -> Subagents: research lanes / audit / adversarial review
  -> Research Harness: evidence / artifacts / validation / checkpoint
  -> 主 Agent: synthesis / recommendation / decision brief / report
  -> 用户继续追问、纠偏或恢复 Run
```

## 2. 产品定位

该 Agent 服务面向两类不同任务。

### 2.1 机会发现

`opportunity_discovery` 从一个宽泛行业、用户群体、场景、技术变化或两者交叉方向出发，通过多 lane 调研发现、定义、筛选和比较多个创业机会。

输入示例：

```text
宠物行业 App
养老护理 App
家庭旅行规划 App
目前 AI 创业有哪些机会
多模态和 Agent 能力最近创造了哪些新创业窗口
AI 在家庭旅行场景有哪些值得小团队关注的方向
```

输出不是趋势综述，也不是模型直接生成的点子清单，而是：

- 多个结构化 Opportunity Thesis。
- 支持和反对判断链。
- Demand Thesis、候选 Solution Hypotheses、selected solution 和 Baseline Option。
- 用户触发语言、买单语言、入口场景和现有解法失效场景。
- 竞品、市场、商业化、获客、交付形态、可行性、合规和反证判断。
- AI 方案适用时的通用模型、平台和开源 baseline 比较。
- 推荐档位、敏感性、关键未知数、kill criteria 和轻量验证建议。
- `recommended_first_bet`、备选方向、共享渠道/能力和资源冲突。

### 2.2 概念证据评估

`concept_evidence_assessment` 从一个用户已经提出的产品或功能 thesis 出发，基于公开资料和用户在 Run 开始前主动提供的已有材料，评估需求、替代方案、竞品饱和度、差异化、付费、获客、可行性、合规和反证。

输入示例：

```text
宠物用药家庭协同 App 有没有市场机会
面向自由行用户的 AI 行程冲突检查功能值得做吗
把家庭票据自动整理成预算记录的 App 是否有付费空间
```

输出是单一 thesis 在当前可获得证据下的优先级判断：

```text
prioritize | investigate_further | deprioritize | insufficient_evidence
```

同时包含证据强度、支持/反对判断链、决定性证据、关键缺口、kill criteria、决策建议和可选的轻量验证建议。该模式不重新生成 TopN 机会池，不声称已经完成真实市场行动验证，也不执行或追踪访谈、落地页、订金、付费实验和 MVP 测试。

### 2.3 两种模式的共同内核

两种模式共享：

- Research Kernel。
- Evidence / Claim / Finding / Insight 分层模型。
- 用户语言、解法失效、替代方案、买单语言和反证研究方法。
- Artifact Contract 和 evaluator。
- Evidence Store、checkpoint、报告和审计工具。

两种模式不共享宏观输出合同。运行中不能从概念证据评估静默变形成机会发现，也不能从机会发现静默变形成单 thesis assessment。

### 2.4 消费者产品边界

当前业务范围以消费者产品和消费者工作流为主：

- 比较 `native_app`、`mini_program`、`mobile_web/PWA`、`hybrid_app`、`platform_native` 和 `service_assisted`。
- 支持个人自付、家庭代付、赞助支付和 provider/channel 推荐等 buyer model。
- Provider、药店、诊所、社区或 marketplace 可以作为渠道、付款或交付参与者，但不把产品默认变成企业 SaaS。
- SaaS、企业直销、API、开发者工具和基础设施不是当前默认目标空间。用户明确要求研究这些方向时应创建新的 scope/policy，而不是静默混入消费者 TopN。
- `native_app` 不具有默认优先级，交付形态必须与入口频率、分享、通知、数据权限、离线能力和验证路径比较。

## 3. 背景与动机

通用 deep research 擅长围绕问题检索、扩展子问题、并发阅读、递归追问和生成长报告，但创业机会判断还需要更强的领域控制：

| 需求 | 通用 deep research | 创业机会调研 Agent |
| --- | --- | --- |
| 输入 | 一个研究问题 | 宽泛方向或明确产品 thesis |
| 候选生成 | 容易直接从模型总结产生 | 从需求、任务、替代方案、解法失效和市场判断层形成 |
| 研究维度 | 动态扩展为主 | 预设 lane + 动态补充 |
| 证据 | 通常服务报告写作 | 必须形成可审计判断链 |
| 评估 | 自然语言综合 | hard gate、结构化比较面板、反证和敏感性 |
| 输出 | 一篇报告 | TopN 决策建议或单 thesis evidence assessment，并同时生成决策简报和完整报告 |
| 人工介入 | 常在开始和结束 | 可在主窗口中途持续纠偏 |

Codex 已经提供 Agent 执行循环、文件和命令工具、Skills、MCP、hooks、subagents、会话恢复以及桌面交互面。对于个人或小团队进行的高不确定性调研，另行建设通用工作流运行时会产生大量与核心研究质量无关的前端、状态机、发布和基础设施工作。

因此本方案采用：

```text
Codex Agent Harness
  + Startup Opportunity Research Harness
  + repo-backed artifacts
```

Codex 负责 Agent 如何运行和协作，本仓库负责一次创业机会调研如何成为可重复、可恢复、可评价的领域任务。

GPT Researcher 的 deep 模式仍是 Research Kernel 的流程参考，但不作为顶层业务接口，也不作为黑盒报告服务。

## 4. 目标

- 通过一个通用 Skill 在 Codex 桌面、CLI 和 IDE 中使用同一套调研能力。
- 让用户能在主窗口实时观察、纠偏和补充调研，而不依赖独立工作台页面。
- 支持 `opportunity_discovery` 和 `concept_evidence_assessment` 两类明确任务。
- 让需求、任务、用户语言、替代方案、竞品、市场、买单、AI baseline 和反证等 lane 可独立并行研究。
- 保留结构化 Evidence、Claim、Finding、Insight 和 Opportunity Thesis。
- 所有结论保留 source provenance、evidence refs、limitations、freshness 和反证。
- 所有 profile 先形成 solution-neutral Demand Thesis，再比较多个 Solution Hypothesis 和 Baseline Option。
- AI 能力只能作为解决方案证据，不直接构成创业机会。
- 让主 Agent 根据当前证据缺口规划有限 follow-up，而不是预先固定所有查询。
- 让数据驱动的运行时调整具有显式触发依据、closed action、计划版本、证据引用和恢复语义，而不是依赖主 Agent 临场改写计划。
- 通过 JSON Schema、确定性脚本和独立 reviewer 提高一致性。
- 通过 run directory 和 checkpoint 支持跨会话恢复，不把聊天历史当成唯一状态。
- 同时生成机器可读 JSON、默认面向用户的 Markdown 决策简报和完整 Markdown 报告。

## 5. 非目标

- 不建设通用 Dynamic DAG Runtime、Workflow Definition DSL 或 Recipe Registry。
- 不提供任意条件表达式、任意节点注入或可执行代码形式的动态路由；动态调整只能使用本领域发布的 gap type、adaptation action、unit type 和 policy。
- 不建设通用工作流平台兼容层，也不引入 host/container/IPC/Workbench 作为运行前提。
- 不建设多用户 SaaS、独立 Web 前端、任务队列或运营后台。
- 不以 custom command 作为唯一入口；Codex 桌面主窗口未明确支持自定义 `/prompts:*` command，因此入口统一为 Skill。
- 不把 Skill 写成一个只生成长报告的超级 prompt。
- 不把 subagent 聊天回复当作正式 artifact。
- 不让每个 lane 自由修改最终 schema、比较规则或报告合同。
- 不实现 token/cost 预算统计、资源账本或按模型计费归因。
- 不采集用户侧外部验证预算，不输出金额、人数或资源配置建议，也不声称建议的验证动作符合用户实际资金条件。
- 不允许用户在运行中任意修改比较面板的重要性；只使用经过版本化、校准和审计的 decision/comparison profile。
- 不在一个 Run 中混合多个国家的证据、分数和推荐；跨市场统一校准、排名和进入顺序建议不属于首版能力。
- 不自动执行或追踪用户访谈、落地页、订金、投放、付费实验、MVP 测试、产品开发或其他外部验证动作；这些内容只能作为由用户自行决定是否执行的建议出现。
- 不追踪后续创业成败，也不根据业务结果自动修改历史比较结果。
- 不保证产生的方向一定成功；系统输出的是基于当前可获得证据的决策建议。

## 6. 核心设计原则

### 6.1 机会来自判断层，而不是先生成

错误流程：

```text
宽泛方向 -> LLM 直接生成创业点子 -> 搜证据包装点子
```

目标流程：

```text
宽泛方向
  -> 用户语言 / JTBD / 替代方案 / 解法失效 / 市场研究
  -> Evidence -> Claims -> Findings -> Insights
  -> Demand Thesis
  -> Solution Hypotheses + Baseline Option
  -> Opportunity Thesis
  -> 反证、hard gate、比较和决策建议
```

### 6.2 需求发现保持方案中立

需求 lane 不允许直接产出“AI 助手”“管理 App”“智能平台”等供给侧答案。Demand Thesis 必须先描述用户、场景、任务、现有替代、失败损失、买单方和 outcome。

### 6.3 用户语言先于需求总结

先收集目标用户的真实表达，再抽象需求。高优先级机会必须说明：

```text
trigger_phrase
entry_scene
current_solution
solution_failure_scene
next_action_after_failure
mental_position_occupation
```

### 6.4 用户语言和买单语言分开验证

用户会说什么、谁会付款、付款方为什么购买是三个不同问题。每个机会必须明确 user、buyer、payer、decision maker、budget source、purchase trigger 和 decision criteria。

### 6.5 Baseline 是正式对照项

所有 Solution Hypothesis 都必须与当前工作流或维持现状比较。无法证明足够增量价值时进入 `watchlist` 或 `reject`，不能因为新方案更先进就推荐。

### 6.6 AI 是方案证据，不是机会本体

只有声明 `uses_ai=true` 的方案才执行 AI baseline、可靠性、数据、依赖和商品化风险研究。Capability Evidence 必须回连 Demand Thesis 和 Solution Hypothesis。

### 6.7 价值区分 output、workflow 和 outcome

一次性 output 容易被通用模型或平台复制。强机会应说明价值如何进入持续 workflow 或可验证 outcome。

### 6.8 反证前置

每个 lane 都必须返回 supporting claims、opposing claims、uncertainty 和 kill conditions。反证不是最终报告阶段的装饰性章节。

### 6.9 比较是决策辅助，不是客观概率

先执行 hard gates，再分别判断需求与市场、方案与商业闭环、证据强度、团队适配与学习速度。对用户默认输出 ordinal band、支配关系和 partial order，不暴露一个看似精确的全局总分。多个机会证据区间重叠时不强行制造精确排名。

### 6.10 主窗口交互必须落盘

用户在主窗口改变 scope、否决候选、要求 follow-up 或接受限制时，主 Agent 必须把决定写入 `decisions.jsonl` 并更新 manifest。聊天历史不能成为唯一的业务状态。

### 6.11 Subagent 输出必须结构化交接

Subagent 必须写入指定 artifact path，并返回简短摘要和 artifact ref。主 Agent 不得仅凭其自然语言回复继续综合。

### 6.12 Harness 只做领域控制

Harness 不重新实现 Codex 的 agent loop、subagent thread、权限系统或会话。它只补齐 Codex 没有替本领域保证的证据、schema、run 状态、恢复和评价能力。

### 6.13 高质量机会先被定义，再被发现

每个候选进入正式比较前必须回答：

```text
谁有问题？
问题发生在什么任务、步骤和入口场景？
当前使用什么替代方案？
现有方案在什么时刻、因为什么原因失效？
失败后用户采取什么 next action，是否真的存在迁移动机？
谁是 user、buyer、payer 和 decision maker？
用户触发语言如何翻译成买单语言？
预算来自哪里，购买标准是什么？
为什么现在愿意改变行为或付费？
如何触达第一批用户？
第一个切入版本和 beachhead segment 是什么？
原生 App、小程序、Web/PWA、平台内置或人工辅助哪种交付形态更合适？
当前 Baseline Option 是什么，新方案必须提供多大增量才值得迁移？
价值主要位于 output、workflow 还是 outcome？
是否需要持续用户状态、上下文、协作或反馈闭环？
如果依赖 AI，通用模型 + prompt/tool、平台原生或开源方案是否已经足够？
能力是否会被模型升级、平台内置或竞品更新快速商品化？
什么证据会推翻这个机会？
```

缺少明确买单方、baseline delta、入口场景、交付形态、价值层或可推翻条件的候选，最高只能进入 `watchlist` 或 `insufficient_evidence`。

### 6.14 心智定位不是功能名

`AI Tutor`、`智能助手`、`健康管理 App`、`行业平台` 等是供给侧功能或品类，不是用户会想起产品的那句话。

Mental positioning 必须表示：

```text
用户自然语言
  -> 具体入口场景
  -> 当前解法失效
  -> 新产品被想起
```

每个强候选必须包含 `mental_position_occupation`：当前心智位置是否已经被大厂、内容平台、线下服务、通用模型或现有产品占领，剩余 white space 是什么。

### 6.15 自然复述测试

用户原话能帮助发现定位，但不能证明定位已经成立。候选应定义一项可执行的自然复述测试：

```text
test_prompt
target_user
expected_restatement
success_signal
failure_signal
evidence_refs
status
limitations
```

成功信号不是用户说“功能不错”，而是目标用户能自然复述“我在 X 时会想到用它解决 Y”，且不需要研究者先说出产品功能名。

未实际执行测试时标记 `not_tested`，只能作为验证建议，不能伪造通过结果。

### 6.16 用户状态和上下文连续性必须可落地

持续状态、个性化和数据闭环不能被空泛地当作壁垒。每个依赖状态连续性的机会必须说明：

```text
state_variables
context_sources
state_update_triggers
feedback_or_ground_truth
retention_boundary
privacy_permission_boundary
deletion_and_export_boundary
```

如果无法获得用户授权数据、无法稳定更新状态或没有可用反馈机制，不得把 `state_context_value` 或 `data_feedback_moat` 计入高分。

### 6.17 调研 lane 同时承担发现和筛选

每个 lane 不只收集资料，还要输出：

```text
supporting_claims
opposing_claims
uncertainties
kill_conditions
pre_kill_decisions
retained_candidates
candidate_diversity_summary
```

Lane 内评分只用于 triage，不能直接与其他 lane 的分数比较。跨 lane 合并后才执行统一 hard gate 和全局比较。

### 6.18 候选保留优先多样性，不固定 TopN

Lane 不应机械保留固定 TopN。Research Plan 必须定义：

```text
candidate_retention_threshold
candidate_diversity_policy
minimum_evidence_requirement
counterfactual_candidate_requirement
```

保留策略至少考虑 user、JTBD、entry scene、buyer model、delivery form 和 opportunity source 的多样性。语义相近候选可聚类，但不能在证据尚未汇合前只保留最像初始 seed 的方向。

### 6.19 研究规划以决策价值驱动

每个 open question 记录：

```text
decision_impact
uncertainty
expected_information_gain
stop_condition
```

首版不计算 Agent 研究成本，但仍优先回答最可能改变 hard gate、concept assessment、selected solution、推荐档位或主要 limitation 的问题。研究深度本身不是质量指标。

### 6.20 人工控制和 Agent 质量是两层合同

人工介入边界：

- scope assumptions 或高影响约束缺失时澄清。
- 用户主动改变方向、否决候选、要求深入或接受 limitation 时记录 decision。
- 当前方案不执行外部验证动作，因此报告生成不需要额外业务审批。

Agent 质量分为：

```text
execution_quality
  = schema + refs + opposing evidence + freshness + completeness

decision_readiness
  = hard gates + evidence sufficiency + assessment/recommendation constraints
```

执行质量通过不代表业务结论可推荐，业务结论证据不足时仍必须 abstain。

### 6.21 先明确用户要做的决定

Run 的顶层对象不只是研究主题，还包括 `DecisionContext`。系统必须先明确用户希望当前研究回答什么决策问题，再决定 scope、lane 和输出形式。

`decision_to_make` 首版使用：

```text
choose_opportunity
assess_concept_viability
prioritize_research_gap
reassess_with_new_material
```

`decision_to_make` 不包含模糊的 `continue_validation`，也不把外部访谈、落地页、订金、付费实验或 MVP 测试变成系统 action。外部验证只能作为带有 `execution_owner=user`、`execution_supported=false` 和 `result_tracking_supported=false` 的可选建议出现。

### 6.22 证据等级限制结论强度，不表示验证生命周期

Evidence tier 描述当前 Run 已经可以访问的材料强度，不表示系统会把机会从公开资料逐步推进到访谈、承诺、交易和留存。公开来源或用户主动提供的已有材料中如果恰好包含直接行为、承诺或交易证据，可以按其真实等级使用；系统不负责生成、执行或持续追踪这些证据。

缺少高等级行为或承诺证据不等于反证。系统必须将其表达为证据缺口、结论上限或 `insufficient_evidence`，不能自动解释为 `deprioritize`。

### 6.23 决策简报和完整报告是双层输出

每个 completed Run 同时生成：

```text
report.json
  -> 结构化事实源

decision-brief.md
  -> 默认用户入口，回答当前应如何判断

report.md
  -> 完整研究、证据链和审计报告
```

决策简报与完整报告必须从同一份通过校验的结构化事实源生成。简报不得产生报告中不存在的新判断，也不得省略会改变结论的强反证。

### 6.24 候选生成与候选评估保持证据独立

Candidate generation 和 evaluation 不得完全复用同一搜索路径形成自证循环。Research Plan 必须在可行时分离生成来源与评估来源，在 enrichment 前冻结核心 thesis、关键假设和 kill criteria，并由独立 challenger query 主动寻找替代解释。

Adversarial review 不复用正向 query 简单添加否定词。无法取得独立评估来源时必须披露 `evaluation_source_overlap`，并降低 evidence sufficiency。

### 6.25 用户认知变化是正式决策上下文

系统不仅记录用户如何改变 scope，还记录：

```text
initial_belief
favored_hypothesis
assumed_truths
evidence_that_changed_belief
remaining_disagreement
final_decision_owner
```

这些字段用于发现确认偏误和解释判断变化，不用于迎合用户偏好或修改证据结论。Checkpoint 摘要应说明当前相信什么、哪些证据改变了判断、仍存在哪些分歧。

### 6.26 所有候选都需要 Business Engine Thesis

AI 产品和非 AI 产品都必须说明从用户价值到可持续业务的基本闭环，包括定价单位、使用或购买频率、留存或复购触发、毛利与服务负担、获客假设、回收逻辑、可触达 beachhead、渠道依赖、增长回路和 minimum viable scale。宽泛 TAM 不能替代可触达市场和业务闭环判断。

### 6.27 调整先结构化，再执行

主 Agent 可以判断证据是否矛盾、哪个缺口最可能改变决策以及下一步研究目标，但不得直接改写当前计划或静默启动额外 unit。每次数据驱动调整必须形成：

```text
validated artifacts
  -> Gap Snapshot
  -> Adaptation Decision proposal
  -> deterministic policy validation
  -> immutable Plan Revision
  -> scheduler execution
  -> checkpoint
```

Gap Snapshot 说明“观察到了什么”，Adaptation Decision 说明“建议改变什么以及为什么”，Plan Revision 说明“系统批准后的有效计划是什么”。语义判断与机械执行分离：LLM 负责开放式研究判断，Harness 负责边界、幂等、版本、引用和恢复。

## 7. 总体架构

### 7.1 三层模型

| 层 | 主要职责 |
| --- | --- |
| Codex Agent Harness | 模型推理、工具调用、subagents、权限、会话和交互 |
| Startup Opportunity Research Harness | run、计划、证据、artifact、checkpoint、校验、比较、决策简报和报告 |
| 可选产品层 | 未来的多用户、API、定时执行、独立 UI 和运营能力 |

首版只实现前两层。可选产品层不是当前依赖。

### 7.2 执行链路

```text
$startup-opportunity
  -> parse action and input
  -> create or load run
  -> decision framing
  -> scope framing
  -> research plan
  -> validate plan
  -> execute research waves with subagents
  -> validate branch artifacts
  -> build Gap Snapshot
  -> propose and validate bounded Adaptation Decision
  -> apply immutable Plan Revision when needed
  -> domain synthesis
  -> adversarial review
  -> deterministic gates / four-panel comparison / sensitivity
  -> report.json / decision brief / full report generation
  -> final artifact validation
  -> complete or insufficient_evidence
```

### 7.3 Codex 能力映射

| Codex surface | 本项目中的用途 |
| --- | --- |
| `AGENTS.md` | 仓库级恒定规则、正式产物要求和验证命令 |
| Skill | 唯一入口和可复用研究方法 |
| Skill references | 两种模式、lane playbook、schema 和报告规范 |
| Skill scripts | 创建 run、验证、gap 聚合、adaptation 校验、Plan Revision 应用、记录证据、比较、checkpoint、决策简报和报告 |
| Custom agents | lane researcher、evidence auditor、adversarial reviewer |
| Subagents | 并行执行边界清晰的研究任务 |
| MCP | 搜索、抓取、榜单、评论、趋势和外部结构化数据 |
| Hooks | 工具调用约束、事件记录、停止前校验和敏感信息防护 |
| Codex 主窗口 | 过程沟通、纠偏、澄清、暂停和继续 |
| Git | Skill、schema、policy 和报告模板版本化 |

### 7.4 不能委托给 Codex 隐式状态的内容

以下状态必须保存在仓库，而不是依赖某个线程记住：

- 当前 run id、action、mode 和 status。
- 当前 DecisionContext、初始判断和 belief update。
- scope assumptions 和用户决策。
- 当前 research plan revision、历史 plan lineage、已完成 lane、Gap Snapshot 和待处理 Adaptation Decision。
- Evidence、Claim、Finding、Insight、Judgment Assessment 和 source manifest。
- Artifact schema version 和校验结果。
- 当前候选、淘汰理由、hard gate 和 limitations。
- report.json、决策简报、完整报告、各自 hash 和生成时使用的 artifact refs。

## 8. 建议仓库结构

```text
deep-search/
  AGENTS.md

  .codex/
    config.toml
    hooks.json
    agents/
      lane-researcher.toml
      evidence-auditor.toml
      adversarial-reviewer.toml
    hooks/
      pre-tool-use-policy.sh
      post-tool-use-event.sh
      stop-artifact-check.sh

  .agents/
    skills/
      startup-opportunity/
        SKILL.md
        references/
          opportunity-discovery.md
          concept-evidence-assessment.md
          research-kernel.md
          lane-catalog.md
          artifact-contracts.md
          comparison-policy.md
          report-contract.md
        scripts/
          create-run
          load-run
          validate-plan
          analyze-gaps
          validate-adaptation
          apply-plan-revision
          record-evidence
          validate-artifact
          checkpoint-run
          calculate-comparison
          calculate-sensitivity
          audit-traceability
          build-report

  harness/
    schemas/
    policies/
      adaptation.v1.json
    templates/
    evals/
    src/
      run-store/
      evidence-store/
      artifact-store/
      validators/
      adaptation/
      comparison/
      reporting/

  runs/
    .gitkeep

  tests/
    fixtures/
    evals/
```

职责边界：

- `.agents/skills/startup-opportunity/` 描述 Agent 应如何完成任务。
- `.codex/agents/` 描述不同 subagent 的角色、模型偏好、推理强度和工具边界。
- `harness/` 保存确定性领域逻辑，不发起隐藏 LLM 调用。
- `runs/` 保存每次运行的状态和产物，默认不提交包含大体积 raw evidence 的内容。
- `tests/` 验证 schema、引用、比较规则和代表性研究 fixture。

后续需要跨项目安装和共享时，可以把 Skill、agents、hooks 和 MCP 配置打包为 Codex Plugin。Plugin 是分发单元，不是首版运行时前提。

## 9. 通用入口 Skill

### 9.1 唯一入口

用户通过 `$startup-opportunity` 使用系统。Skill 支持四个 action：

`SKILL.md` 使用最小、明确的 discovery metadata：

```yaml
---
name: startup-opportunity
description: 发现和评估创业机会，或评估一个明确产品/功能假设的当前证据。用于创业方向调研、市场机会发现、概念证据评估、竞品与替代方案研究、买单和获客判断、AI 方案 baseline 比较，以及恢复已有调研 Run。
---
```

```text
discover
assess
resume
status
```

典型调用：

```text
$startup-opportunity

action: discover
query: 宠物行业 App
```

```text
$startup-opportunity

action: assess
query: 面向自由行用户的 AI 行程冲突检查功能值得做吗
```

```text
$startup-opportunity

action: resume
run_id: 2026-07-23-pet-care
instruction: 优先补充家庭代付和获客证据
```

```text
$startup-opportunity

action: status
run_id: 2026-07-23-pet-care
```

Codex 也可以根据自然语言隐式选择该 Skill，但正式执行前必须把解析后的 action 和 mode 呈现给用户或写入 intake artifact。显式 action 始终优先。

### 9.2 Action 与 mode

`action` 是入口行为，`mode` 是新 Run 的业务目标：

| action | 是否创建新 Run | mode |
| --- | --- | --- |
| `discover` | 是 | `opportunity_discovery` |
| `assess` | 是 | `concept_evidence_assessment` |
| `resume` | 否 | 从 manifest 读取 |
| `status` | 否 | 从 manifest 读取，只读 |

Skill 不提供 `auto` 作为正式 mode。用户没有写 action 时可以进行轻量判断：

- 宽泛行业、技术能力、用户群体或场景通常对应 `discover`。
- 明确产品、功能、Solution Thesis 通常对应 `assess`。
- 输入同时包含宽泛发现和明确概念，且选择会显著改变输出时，先在主窗口澄清。
- 不允许在 Run 创建后仅根据模型判断切换 mode。要切换必须创建新 Run 或由用户显式要求转换并记录 provenance。

### 9.3 Intake 合同

新 Run 的 `intake.json` 至少包含：

```json
{
  "schema_version": "startup_opportunity.intake.v1",
  "action": "discover",
  "mode": "opportunity_discovery",
  "raw_query": "宠物行业 App",
  "market": "CN",
  "language": "zh-CN",
  "principal": "local_user",
  "decision_context_ref": "decision-context.json",
  "attachments": [],
  "explicit_constraints": {},
  "created_at": "2026-07-23T00:00:00Z"
}
```

可选约束包括：

```text
target_market
target_language
venture_goal
decision_horizon
founder_advantages
non_negotiable_constraints
target_users
excluded_users
delivery_form_preferences
business_model_preferences
team_capabilities
risk_preferences
ai_scope
research_axes
requested_output_count
```

`decision_horizon` 表示用户希望何时获得当前研究判断，不是外部验证计划、Agent token/cost budget 或系统对后续行动的承诺。

### 9.4 Skill 内部流程

`SKILL.md` 应规定以下顺序：

```text
1. 读取 action 和输入。
2. 对 discover/assess 创建 Run，对 resume/status 加载 Run。
3. 校验 manifest、schema version 和当前 status。
4. status 只生成状态摘要，不启动 subagent。
5. 新 Run 先形成 DecisionContext，再执行 scope framing，并记录用户澄清和初始判断。
6. 加载对应 mode reference，而不是把两套完整流程同时放入上下文。
7. 生成 `plans/research-plan.r1.json` 并运行 deterministic validation。
8. 按 wave 启动 bounded subagents。
9. 每个 wave 结束后先校验 artifact，再生成 Gap Snapshot。
10. 主 Agent 为每个 decision-relevant gap 提出 Adaptation Decision；没有此类 gap 时可以不提案，Harness 校验动作并在需要改变计划时原子应用下一版 Plan Revision。
11. 写 checkpoint 后执行新 revision，或在满足停止条件时进入综合、复核、比较和推荐。
12. 从同一 report.json 生成 decision-brief.md 和 report.md，验证一致性后再向用户汇报。
```

Skill 必须使用 progressive disclosure：

- `SKILL.md` 只保留入口、不可违反的规则和路由。
- `opportunity-discovery.md` 只在 discover Run 中读取。
- `concept-evidence-assessment.md` 只在 assess Run 中读取。
- lane、comparison、artifact 和 report reference 按阶段读取。
- 大型 schema 由验证脚本消费，不全部注入模型上下文。

## 10. 仓库级指导与配置

### 10.1 AGENTS.md

项目 `AGENTS.md` 应只包含每次运行都必须遵循的持久规则：

- 正式调研必须通过 `$startup-opportunity` 或兼容调用进入。
- 不得把聊天回复当作正式 artifact。
- 不得伪造 evidence ref、URL、用户原话或市场数据。
- Subagent 必须写入分配的 output path，不能覆盖其他 lane 文件。
- report.json、决策简报和完整报告必须通过 schema、traceability、freshness 和一致性校验。
- 用户对 scope 和候选的纠偏必须写入 `decisions.jsonl`。
- 主 Agent 不得直接覆盖 current plan；所有运行时调整必须经过 Gap Snapshot、Adaptation Decision、policy validation 和幂等 Plan Revision 应用。
- 不执行外部验证动作或其他有业务副作用的操作。
- 指定 lint、schema validation 和 eval 命令。

不要把完整研究方法复制进 `AGENTS.md`，避免每个 Codex 任务都加载无关的大量文本。

### 10.2 `.codex/config.toml`

项目配置负责：

- subagent 并发上限。
- 默认 subagent 模型和 reasoning effort。
- MCP server 注册与工具过滤。
- hooks 注册。
- 项目内权限和网络默认值。

不同 custom agent 可以覆盖 model、reasoning effort、sandbox 或 MCP，但不得扩大父线程当前允许的权限。

### 10.3 Plugin

首版先使用 repo-local Skill 和 agents。满足以下条件后再打包 Plugin：

- 需要跨多个仓库安装。
- 需要把 Skill、MCP、hooks 和 assets 一起发布。
- 需要稳定版本和团队共享入口。

Plugin 不保存 Run 状态，也不替代 Evidence Store。

## 11. Run 模型

### 11.1 Run 是领域任务边界

一次 `discover` 或 `assess` 创建一个 Run。Run 是最小恢复、审计和报告边界：

```text
runs/<run_id>/
  intake.json
  decision-context.json
  manifest.json
  scope-frame.json
  plans/
    research-plan.r1.json
    research-plan.r2.json
  adaptations/
    gap-snapshots/
    decisions/
  decisions.jsonl
  events.jsonl
  evidence/
    manifest.jsonl
    raw/
  claims/
  findings/
  insights/
  judgments/
  artifacts/
    lanes/
    synthesis/
    reviews/
    comparison/
  checkpoints/
  report.json
  decision-brief.md
  report.md
```

### 11.2 Run 状态

首版使用领域固定状态，不建设通用状态机：

```text
created
  -> decision_framed
  -> scoped
  -> planned
  -> researching
  -> synthesizing
  -> reviewing
  -> reporting
  -> completed
```

任意非 terminal 状态可以进入：

```text
paused
failed
insufficient_evidence
cancelled
```

`created` 或 `decision_framed` 可以在高影响输入缺失时进入 `needs_clarification`。`planned`、`researching`、`synthesizing` 或 `reviewing` 只有在 validated `request_clarification` Adaptation Decision 后才能进入该状态，并保存原状态和 checkpoint；澄清后生成 event-driven Gap Snapshot，回到原阶段的下一安全边界。

`resume` 只允许从 `paused`、`failed`、`needs_clarification` 或可恢复的中间状态继续。`completed` 默认只读；用户要求深入研究时创建新的 continuation Run，并记录 parent run id，避免改写历史报告。

### 11.3 Manifest

`manifest.json` 至少包含：

```json
{
  "schema_version": "startup_opportunity.run_manifest.v1",
  "run_id": "2026-07-23-pet-care",
  "mode": "opportunity_discovery",
  "status": "researching",
  "status_before_clarification": null,
  "parent_run_id": null,
  "created_at": "2026-07-23T00:00:00Z",
  "updated_at": "2026-07-23T01:00:00Z",
  "current_phase": "discovery_wave_1",
  "current_plan_ref": "plans/research-plan.r2.json",
  "plan_revision": 2,
  "followup_round": 1,
  "latest_gap_snapshot_ref": "adaptations/gap-snapshots/gap-wave-1.r1.json",
  "pending_adaptation_refs": [],
  "validated_adaptation_refs": [],
  "rejected_adaptation_refs": [],
  "applied_adaptation_refs": ["adaptations/decisions/adapt-002.json"],
  "completed_units": [],
  "active_units": [],
  "failed_units": [],
  "invalidated_units": [],
  "skipped_units": [],
  "cancelled_units": [],
  "superseded_units": [],
  "ignored_late_artifact_refs": [],
  "artifact_refs": [],
  "checkpoint_ref": null,
  "limitations": []
}
```

对尚未提交到 Git 的 Skill 和 policy，manifest 记录文件 hash，确保恢复时能识别定义漂移。

### 11.4 Event 与 Decision

`events.jsonl` 记录系统事实：

```text
run_created
decision_context_written
scope_written
plan_validated
research_unit_started
research_unit_completed
artifact_validation_failed
gap_snapshot_created
adaptation_proposed
adaptation_validated
adaptation_rejected
adaptation_applied
plan_revision_created
research_unit_invalidated
checkpoint_written
followup_stopped
report_completed
```

`decisions.jsonl` 记录影响业务方向的人工或主 Agent 决定：

```text
scope_assumption_confirmed
scope_changed_by_user
initial_belief_recorded
belief_changed_by_evidence
remaining_disagreement_recorded
candidate_rejected_by_user
followup_requested_by_user
plan_change_requested_by_user
limitation_accepted
run_paused
run_cancelled
```

事件和决定都必须包含 timestamp、actor、reason 和相关 artifact refs。事件日志用于审计，不需要模拟完整分布式事务日志。

Adaptation ref 在 manifest 中按 `pending -> validated -> applied` 推进，或从 pending/validated 进入 `rejected`；同一 ref 不能同时存在于互斥状态集合。Event 是审计事实，manifest 是当前索引，恢复时两者必须对账。

### 11.5 Checkpoint

在以下边界写 checkpoint：

- DecisionContext 完成。
- scope 完成。
- plan 通过校验。
- 每个 research wave 完成。
- 每次 Plan Revision 应用或 Adaptation Decision 被拒绝且需要人工处理。
- synthesis 完成。
- adversarial review 完成。
- report.json、decision brief 和 full report 完成。

Checkpoint 保存当前 manifest snapshot、current plan ref 和 revision、已完成或失效 unit、artifact refs、最新 Gap Snapshot、已应用或待处理 Adaptation Decision、未解决 gaps 和下一步建议。恢复时先验证 plan lineage 和引用存在，再从最后一个有效 checkpoint 继续。

Codex session resume 可以帮助恢复对话，但不能跳过上述领域恢复检查。

## 12. Research Plan

### 12.1 Plan 的定位

Research Plan 是一次 Run 的受约束执行计划，不是通用 Graph IR。它只表达：

- 需要研究哪些 lane 或 enrichment unit。
- unit 之间的依赖。
- 哪些 unit 可以在同一 wave 并行。
- 每个 unit 的研究目标、输入、输出和停止条件。
- 哪些条件允许产生 follow-up。

初始计划是 revision 1。后续计划只能由通过校验的 Adaptation Decision 派生；所有 revision 不可变，`manifest.current_plan_ref` 指向唯一生效版本。主 Agent、subagent 和 hook 都不能直接覆盖当前 plan 文件。

### 12.2 Plan schema

```json
{
  "schema_version": "startup_opportunity.research_plan.v1",
  "plan_id": "plan_2026-07-23-pet-care",
  "run_id": "2026-07-23-pet-care",
  "mode": "opportunity_discovery",
  "revision": 1,
  "parent_plan_ref": null,
  "triggered_by_adaptation_refs": [],
  "created_at": "2026-07-23T00:05:00Z",
  "research_questions": [
    {
      "question_id": "rq_001",
      "question": "家庭协同是否提供了高于微信提醒的增量价值？",
      "decision_impact": "可能改变 baseline gate 和推荐档位",
      "uncertainty": "high",
      "expected_information_gain": "high",
      "stop_condition": "获得独立用户行为证据或确认无法取得更高等级来源"
    }
  ],
  "candidate_retention_policy": {
    "minimum_evidence_requirement": "至少一个非 model_inference_only 的支持 Claim",
    "candidate_retention_threshold": "通过 pre-kill 且具有独立决策价值",
    "candidate_diversity_policy": [
      "保留不同 user/JTBD/entry scene",
      "保留不同 buyer model 和 opportunity source",
      "不按与初始 seed 的相似度截断"
    ],
    "counterfactual_candidate_requirement": true
  },
  "exploration_policy": {
    "require_seed_independent_demand_unit": true,
    "require_counterfactual_unit": true,
    "initial_hypotheses_are_questions_not_truth": true,
    "separate_generation_and_evaluation_sources": true,
    "freeze_thesis_before_enrichment": true,
    "require_independent_challenger_queries": true
  },
  "waves": [
    {
      "wave_id": "wave_1",
      "depends_on": [],
      "units": [
        {
          "unit_id": "user_language_cn",
          "unit_type": "user_language_mining",
          "plan_disposition": "enabled",
          "priority_band": "normal",
          "attempt": 1,
          "supersedes_unit_ref": null,
          "research_goal": "提取目标用户在问题发生时的自然语言",
          "input_refs": ["scope-frame.json"],
          "agent_role": "lane-researcher",
          "output_path": "artifacts/lanes/user_language_cn.json",
          "required_artifact_schema": "startup_opportunity.discovery_lane_result.v1",
          "source_preferences": [],
          "required_outputs": [
            "supporting_claims",
            "opposing_claims",
            "pre_kill_decisions",
            "retained_candidates",
            "candidate_diversity_summary"
          ],
          "stop_conditions": []
        }
      ]
    }
  ],
  "adaptation_policy_ref": "harness/policies/adaptation.v1.json",
  "followup_policy": {
    "max_followup_rounds": 2,
    "require_decision_relevance": true,
    "stop_when_no_material_new_evidence": true
  }
}
```

#### 12.2.1 Planning Context 与版本选择

`startup_opportunity.research_plan.v1` 是当前正式 shape，不增加隐藏 flag 或自由解释字段。Planning/Assessment evaluator 一律加载 `harness/schemas/current.json`；进入 Plan/adaptation 语义校验的当前 Run 必须提供 immutable `startup_opportunity.planning_context.v2`、`startup_opportunity.ai_trigger_source_attestation.v1` 和当前 policy。这些是 planning control artifacts，不是 G3 AI business artifacts，也不定义 Opportunity Thesis、Concept Hypothesis、AI evaluation 或 result schema。

Planning Context 至少机械表达：

```text
context_id
revision / parent_context_ref
run_id / mode / phase
validation_stage
manifest_binding
  manifest_ref / manifest_schema_version
  run_id / mode
  current_plan_ref / current_plan_revision
  run_state_hash
target_plan_binding
  plan_ref / plan_schema_version
  plan_id / plan_revision / plan_content_hash
ai_mandatory_coverage
  status                  required | not_required
  trigger_version
  basis
  required_dimensions
producer_role             main_agent
created_at
```

Planning Context 使用 `plans/planning-context.r<N>.json`；revision 1 的 parent 为 `null`，后续 revision 必须回连同一 `context_id` 的前一 revision。trigger、source binding、Run 或 Plan binding 变化时发布下一 revision，不原地覆盖。

Hash 使用 G0.3 已冻结的 canonical JSON：object key 按 code unit 递归排序、array 顺序保留、UTF-8 后计算 SHA-256。`run_state_hash` 的输入唯一为：

```json
{
  "manifest_ref": "manifest.json",
  "manifest_schema_version": "startup_opportunity.run_manifest.v1",
  "run_id": "2026-07-23-pet-care",
  "mode": "opportunity_discovery",
  "current_plan_ref": "plans/research-plan.r2.json",
  "current_plan_revision": 2
}
```

示例中的值都取自 manifest 原始 JSON type；`current_plan_revision` 是 integer，不是字符串。

`plan_content_hash` 覆盖完整 target Research Plan document。Validator 必须按 `validation_stage` 机械区分：

- `initial_plan`：manifest current plan 为 `null`/revision `0`，target 是 revision 1 且没有 parent。
- `current_plan`：manifest current plan ref/revision 与 target exact match。
- `candidate_revision`：manifest current plan 是 target parent，target revision 等于 current revision + 1。

任一 Run id/mode、manifest ref、current plan ref/revision、plan id/ref/revision/hash 或 lineage 不一致都视为 stale，不能依赖 CLI flag、文件名猜测或聊天状态补齐。

`ai_mandatory_coverage` 始终存在。`required` 只接受 main Agent 声明的 `uses_ai=true`，或 `assessment_profile=ai | regulated_ai`；声明必须保存 source ref、source schema version、source content hash 和 subject ref，并要求固定六维 coverage。`not_required` 只接受 `signal=none`、全部 source/subject fields 为 `null` 且 required dimensions 为空。Harness 不自行读取自然语言或发布 G3 business schema 来猜测 trigger。

`required` source binding 的唯一机械解析如下：

- `source_ref` 必须是当前显式 `startup_opportunity.document_bundle.current` 内一个完整 document 的 exact path；不允许 fragment，不读取 CLI flag，不按路径名称猜测，不扫描 Run，也不依赖聊天或隐藏 LLM。
- ref target 的实际 `schema_version` 和声明的 `source_schema_version` 都必须等于 current manifest 中已安装的 `startup_opportunity.ai_trigger_source_attestation.v1`；任意其他业务 schema id、fake schema、未安装 schema 或错误 ref 一律拒绝。
- `source_content_hash` 必须等于该完整 attestation document 按 G0.3 canonical JSON 计算的 SHA-256。Attestation 的任意内容变化都会使旧 Planning Context stale。
- Attestation 必须 exact match Planning Context 的 `run_id`、`mode`、`context_id`、`revision`、`basis.subject_ref`、`trigger_version`、`signal` 和 `declared_value`。其中开放式语义声明仍由 main Agent 负责，Harness 只比较这些 closed bindings。
- Source-binding policy 还用 ref、schema version、policy version 和 canonical content hash 精确绑定 closed adaptation policy `1.0.0`。任一 policy、source、subject、trigger 或 Planning Context revision binding 变化都必须发布新 attestation 和新 Planning Context revision；不能原地覆盖或把旧 context 继续解释为 current。

### 12.3 Plan allowlist

Planner 只能选择已发布的 `unit_type`：

```text
user_language_mining
audience_pain
jtbd_workflow
top_products_gap
review_mining
search_content_gap
trend_change
substitute_non_app
solution_failure
ai_capability_evidence
competitor_gap
market_space
monetization
acquisition
business_engine
delivery_feasibility
compliance_risk
counter_evidence
buyer_language
value_layer
state_context
adversarial_review
```

开放行业研究使用 `bounded_domain_research`，但仍必须声明 `lane_kind`、research goal、输入和输出 schema。Planner 不能在 plan 中发明新的 agent role、工具权限或 artifact schema。

`ai_capability_evidence` 保持为一个受控 unit type，不为不同 AI 问题发布六套 role 或输出 schema。每个此类 unit 必须在 task envelope 中声明 `required_dimensions`：

```text
capability_frontier
cost_and_deployment
workflow_and_human_boundary
ecosystem_and_platform
data_and_evaluation
adoption_and_trust
```

Planner 可以创建多个具有不同 unit id 的 `ai_capability_evidence` unit 并行覆盖这些维度，也可以在一个 unit 中覆盖多个维度。单个 unit 可以只承担部分 dimensions，但 `uses_ai=true` 或 AI assessment profile 的 plan aggregate 必须覆盖全部六类；只有业务上确实无关的维度才能显式 `not_applicable`。Result 必须为每个 required dimension 返回独立的 `JudgmentAssessment`、artifact refs 和 `covered | insufficient_evidence | not_applicable` 状态，不得用一段综合文字掩盖缺失维度。

全局 `unit_type` vocabulary 不等于 mode allowlist。`harness/policies/adaptation.v1.json` 以 `startup_opportunity.adaptation_policy.v1` / policy `1.0.0` 发布唯一 closed mapping，key 为 exact：

```text
mode + phase + unit_type + agent_role + required_artifact_schema
```

首版 phase 只允许：

| mode | phase | output contract family |
| --- | --- | --- |
| `opportunity_discovery` | `discovery` | `startup_opportunity.discovery_lane_result.v1` |
| `opportunity_discovery` | `enrichment` | `startup_opportunity.enrichment_branch_result.v1` |
| `opportunity_discovery` | `review` | `startup_opportunity.adversarial_review.v1` |
| `concept_evidence_assessment` | `assessment` | `startup_opportunity.concept_evidence_assessment_branch_result.v1` |
| `concept_evidence_assessment` | `review` | `startup_opportunity.adversarial_review.v1` |

每个 phase 下允许的 unit type 和 role 由上述 current policy 的完整 `unit_rules` 数组唯一决定；代码、fixture 和 prompt 不得维护第二份 allowlist。Policy 的 `artifact_schema_catalog` 是 current manifest 已安装 output schema 的直接集合。Plan validator 只接受 catalog 中存在且具有 exact mode/phase/type/role tuple 的 schema。

正式 Artifact publish 始终要求该 `artifact_type` 已安装在 current manifest、document 通过对应 JSON Schema，并由 current Artifact Envelope 明确允许。unknown 或仅出现在 caller input 中的 schema id 必须 fail closed。新增业务 schema 时必须同时更新 current manifest、Envelope、producer、consumer、policy 和 fixture。

### 12.4 Plan validator

确定性 validator 至少检查：

- 明确使用 current manifest、adaptation policy、AI trigger source-binding policy、Planning Context v2 和 source attestation v1；任一缺失、schema/policy hash 不匹配，或尝试用非当前 Planning Context 进入语义执行时 fail closed。
- Planning Context 的 Run/Plan identity、ref、canonical hash、revision、validation stage 和 lineage 当前有效；任何 stale binding 拒绝。
- unit id 和 output path 唯一。
- unit 的 `plan_disposition` 使用 `enabled | skipped | cancelled | superseded`；运行时 `active/completed/failed` 状态只保存在 manifest/events，不混入计划语义。
- `priority_band` 使用 `low | normal | high | blocking`，只影响满足依赖后的调度次序，不允许绕过 wave dependency。
- retry/supersede unit 的 attempt、前序 unit ref 和新 output path 完整，lineage 不形成循环。
- 所有 dependency 指向已声明 wave/unit。
- 不存在循环依赖。
- `mode + phase + unit_type + agent_role + required_artifact_schema` exact tuple 存在于 current policy，且 output schema 位于 current catalog；未声明 tuple 或 output schema 拒绝。
- output path 位于当前 Run 内且没有跨 unit 写冲突。
- discover 和 assess 只能使用各自允许的 unit 组合。
- AI mandatory bundle 只由 Planning Context 的 current typed trigger 驱动；`required` 时，与同一 subject ref 相连的 enabled `ai_capability_evidence` units aggregate 必须覆盖固定六维，`not_required` 时不凭自由文本追加 trigger。
- 每个 `ai_capability_evidence` unit 的 required dimensions 使用 closed values，且 result 对每个维度都有 coverage status、判断引用和缺口说明。
- mandatory AI dimension 缺失、只有低等级证据或错误标记为 `not_applicable` 时，plan/result validation 失败或进入 `insufficient_evidence`。
- counter-evidence unit 没有被省略。
- 至少一个需求/任务 unit 不读取 product/capability seeds。
- 至少一个 counterfactual unit 主动检验初始假设之外的用户、任务或替代方案。
- generation 和 evaluation source policy 已声明；不能分离时必须记录 overlap 和对 sufficiency 的影响。
- enrichment 前存在冻结的 thesis、关键假设和 kill criteria snapshot。
- challenger query 不得仅复用正向 query 添加否定词。
- candidate retention policy 不使用固定 TopN，且包含多样性和最小证据要求。
- follow-up 有最大轮数和停止条件。
- revision 为单调递增整数；revision 1 没有 parent，后续 revision 必须回连当前 plan 和至少一个已批准 Adaptation Decision。
- `triggered_by_adaptation_refs` 中的决定都以该 revision 的 parent plan 为基础，且没有被重复应用。
- 已完成或被下游 checkpoint 引用的 unit 不被删除或原地改写；调整只能保留、失效、跳过、重试或以新 unit supersede。

### 12.5 自适应 follow-up

每个 open question 记录：

```text
question
decision_impact
uncertainty
expected_information_gain
stop_condition
```

首版不统计研究成本，但仍只追踪可能改变以下结果的问题：

- hard gate。
- concept assessment。
- 推荐档位。
- selected solution 或 delivery form。
- 最重要的 limitation。
- 下一步建议。

新增证据不再改变这些结果，或者连续一轮没有 material new evidence 时停止 follow-up。

### 12.6 Gap Snapshot

每个 wave 的 branch artifacts 通过 schema/reference validation 后，先生成 Gap Snapshot，再决定是否继续。用户中途改变 scope/优先级、artifact validation 失败、adversarial review 提出翻转性缺口时也可以立即生成 event-driven Snapshot，不必等待当前 wave 自然结束。Gap Snapshot 只描述当前数据状态和决策影响，不直接修改计划：

```json
{
  "schema_version": "startup_opportunity.gap_snapshot.discovery.plan.current",
  "snapshot_id": "gap_wave_1_r1",
  "snapshot_cycle_key": "discovery:wave_1:<observed-artifact-hash-set>",
  "run_id": "2026-07-23-pet-care",
  "based_on_plan_ref": "plans/research-plan.r1.json",
  "revision": 1,
  "parent_snapshot_ref": null,
  "created_at": "2026-07-23T00:25:00Z",
  "trigger_kind": "wave_completed",
  "trigger_event_ref": null,
  "phase": "discovery",
  "wave_id": "wave_1",
  "observed_artifact_refs": ["artifacts/lanes/user_language_cn.json"],
  "gaps": [
    {
      "gap_id": "gap_buyer_001",
      "subject_ref": "opportunity_003",
      "gap_type": "buyer_evidence_insufficient",
      "detection_mode": "agent_semantic",
      "triggered_by": {
        "judgment_ref": "judgment_buyer_003",
        "decision_sufficiency": "insufficient",
        "independent_source_count": 0
      },
      "decision_impact": ["hard_gate", "recommendation_band"],
      "severity": "blocking",
      "basis_refs": ["artifacts/lanes/user_language_cn.json", "judgment_buyer_003"],
      "evidence_refs": ["claim_021", "ev_108"],
      "recommended_unit_types": ["buyer_language", "acquisition"]
    }
  ],
  "material_new_evidence_observed": true,
  "unresolved_decision_relevant_questions": ["rq_001"],
  "stop_signals": []
}
```

`gap_type` 使用 closed enum：

```text
mandatory_dimension_missing
evidence_insufficient
evidence_conflict
baseline_unclear
buyer_evidence_insufficient
acquisition_evidence_insufficient
freshness_failed
reviewer_challenge
candidate_pre_killed
unit_failed
scope_invalidated
user_plan_change_requested
source_repetition
no_material_new_evidence
```

可以由脚本直接观察的缺失字段、引用失败、freshness、unit failure、轮数和来源重复使用 `deterministic` detection；证据是否实质矛盾、哪个缺口可能翻转结论等开放式判断使用 `agent_semantic`。`analyze-gaps` 先生成 machine-observable draft，主 Agent 只能追加或解释带 refs 的 semantic gap，最终整体通过 schema/reference validation 后原子发布。两类 gap 都必须给出 `basis_refs`；有底层证据时还必须给出 `evidence_refs`，不能只有无引用的理由。

`trigger_kind` 使用 `wave_completed | user_decision | artifact_validation_failed | adversarial_review_completed | resume_reconciliation`。Wave snapshot 必须有 `wave_id`；event-driven snapshot 必须有 `trigger_event_ref`，两者不能都为空。`decision_impact` 使用 `hard_gate | concept_assessment | recommendation_band | selected_solution | delivery_form | major_limitation | next_action | execution_validity`；`severity` 使用 `blocking | material | advisory`。`stop_signals` 使用 `max_followup_rounds_reached | no_material_new_evidence | source_repetition | user_stop | limitation_accepted`。这些值是领域 enum，不接受任意表达式。

### 12.7 Adaptation Decision

主 Agent 读取 Gap Snapshot 后，为每个 decision-relevant gap 给出显式 disposition。只有 Snapshot 没有 decision-relevant gap 时才可以不创建 Adaptation Decision；已经被当前计划覆盖的 gap 使用 `continue_existing_plan`，不能靠沉默表示“不调整”。一个 decision 只表达一个原子动作，便于独立校验、重放和拒绝。Schema 使用按 action 区分的 `oneOf`：`add_unit` 携带完整 `target_unit`，其余 unit 动作携带 `target_unit_ref` 和动作所需字段，停止类动作不得伪造 target unit。

```json
{
  "schema_version": "startup_opportunity.adaptation_decision.discovery.current",
  "adaptation_id": "adapt_002",
  "run_id": "2026-07-23-pet-care",
  "based_on_plan_ref": "plans/research-plan.r1.json",
  "trigger_gap_refs": ["adaptations/gap-snapshots/gap-wave-1.r1.json#gap_buyer_001"],
  "action": "add_unit",
  "target_unit": {
    "unit_id": "buyer_language_opportunity_003",
    "unit_type": "buyer_language",
    "plan_disposition": "enabled",
    "priority_band": "high",
    "attempt": 1,
    "supersedes_unit_ref": null,
    "research_goal": "判断候选 003 的 buyer、payer、purchase trigger 和购买标准",
    "input_refs": ["opportunity_003", "judgment_buyer_003"],
    "agent_role": "lane-researcher",
    "output_path": "artifacts/lanes/buyer_language_opportunity_003.json",
    "required_artifact_schema": "startup_opportunity.enrichment_branch_result.v1"
  },
  "reason": "缺少独立买单证据，当前不能通过 buyer hard gate",
  "expected_decision_impact": ["hard_gate", "recommendation_band"],
  "success_condition": "取得独立买单证据，或确认无法获得更高质量来源",
  "requested_by": "main_agent",
  "created_at": "2026-07-23T00:30:00Z"
}
```

`action` 使用 closed enum：

```text
add_unit
cancel_unit
skip_unit
reprioritize_unit
retry_unit
supersede_unit
continue_existing_plan
request_clarification
stop_followup
terminate_insufficient_evidence
```

`requested_by` 使用 `main_agent | user`。用户提出的调整仍由主 Agent 转成 artifact，并同时回连 `decisions.jsonl` 中的用户决定；该字段不允许 subagent 获得计划修改权。

用户直接 pause/cancel Run 属于生命周期控制，写 decision/event 和 checkpoint，不创建伪造的 Plan Revision。用户要求“停止继续搜索并按现有证据出报告”则使用 `stop_followup`，同时保留未解决 gap 和 limitation。

Discovery 使用 `startup_opportunity.adaptation_decision.discovery.current`，Assessment 使用 `startup_opportunity.adaptation_decision.assessment.current`。workflow mode 来自 current Run Manifest，不从历史版本号推断。Discovery 的 current closed contract 还要求：

- `continue_existing_plan` 必须增加 `coverage_attestation_ref`，指向 `startup_opportunity.coverage_attestation.v1`。
- `retry_unit` 必须增加 `retry_basis={kind: manifest_failed_unit, manifest_ref: manifest.json, unit_id, manifest_state: failed}`。

当前 planning contract 只接受 current manifest 中安装且由当前 producer/consumer 使用的 Adaptation Decision shape。未安装 shape 直接按当前校验失败，不创建迁移、replacement proposal 或旧 Run continuation；代码或合同更新后继续研究必须使用新的 `run_id`。

Coverage attestation 把开放式语义责任和 Harness 责任分开。Main Agent 负责声明 gap research goal 与 target unit `research_goal` 在同一 subject 下语义等价；Harness 不使用 substring、embedding、LLM 或其他启发式解释文本。Formal relation 唯一为：

```text
same_subject_and_semantically_equivalent_research_goal
```

`coverage_key` 是以下 exact identity 的 canonical JSON SHA-256；不包含 created_at，但任何 identity 字段变化都生成不同 key：

```text
schema_version
relation
run_id
based_on_plan_ref
based_on_plan_revision
based_on_plan_hash
gap_ref
subject_ref
target_unit_ref
gap_research_goal
target_research_goal
```

Harness 只验证 schema/relation version、canonical key、same-Run exact refs、gap subject、target unit input refs、target unit exact research goal、current plan hash/revision/lineage，以及 target unit 为 pending 或 active。Pending 唯一表示 plan 中 `plan_disposition=enabled` 且 unit 不在 manifest 的 active 或任一 terminal/status set；active 唯一来自 `manifest.active_units`。Agent 的 semantic equivalence declaration 可以被 audit/review 挑战，但确定性 Harness 不重新作语义判断。

动作语义：

- `add_unit` 只能从 unit allowlist 创建具有唯一 id 和 output path 的新 unit。
- `cancel_unit` 用于仍在运行但已失效的 unit；停止是 best effort，late artifact 标记为 ignored，不进入 fan-in。
- `skip_unit` 只作用于尚未启动的 unit，并保存跳过原因和 decision impact。
- `reprioritize_unit` 只改变同一 wave 或后续 wave 的调度优先级，不改变依赖和研究语义。
- `retry_unit` 在 G0.4 只允许 target unit exact membership 于 `manifest.failed_units`，并创建新的 attempt/output revision；completed、active、pending、invalidated、skipped、cancelled 或 superseded unit 均拒绝。
- `supersede_unit` 用新 unit 替代因 scope 或输入变化而无效的 pending/active unit，并保留 lineage。
- `continue_existing_plan` 必须引用通过上述 Coverage Attestation 声明确实覆盖同一 subject/research goal 的 pending/active unit，不创建 Plan Revision，用于显式说明无需新增动作。
- `request_clarification` 只在缺口无法从当前证据解决且用户答案会实质改变结果时进入 `needs_clarification`。
- `stop_followup` 表示当前 limitation 被接受或继续研究不再有决策价值，不等于证据充分。
- `terminate_insufficient_evidence` 只在决定性缺口无法解决且结论合同要求 abstain 时使用。

### 12.8 Adaptation policy validator

Harness 在应用动作前必须确定性检查：

- Planning Context、current manifest、policy、Adaptation Decision 和 Coverage Attestation 必须匹配当前声明；不匹配按普通 current schema/contract 校验失败，不能进入语义执行。
- Gap Snapshot、gap、artifact 和 evidence refs 存在且属于当前 Run。
- `based_on_plan_ref` 等于 manifest 当前 plan，避免基于过期计划并发修改。
- Planning Context 的 Run/Plan ref/hash/revision 未 stale，action 在其 current mode/phase 和 published adaptation policy 中允许。
- 新 unit 的 exact mode/phase/type/role/schema tuple、path、dependency 和 source policy 通过 current Plan validator，required output schema 已安装并可发布。
- action 没有修改 mode、primary market/language、comparison profile、权限或正式 schema。
- follow-up 没有超过最大轮数，且声明了 decision impact 和 success/stop condition。
- completed unit 和已被下游 checkpoint 引用的 artifact 没有被删除或覆盖。
- cancel/skip/supersede 的目标状态允许该动作，且不会造成未解释的 mandatory dimension 缺失；`retry_unit` 的唯一机械前置是 target exact membership 于 Run Manifest `failed_units`。
- 每个 blocking 或 decision-relevant gap 在 checkpoint 前至少被一个 validated decision 覆盖；`continue_existing_plan` 必须提供 canonical Coverage Attestation，target 只能是同一 current plan 的 pending/active unit。
- 相同 `adaptation_id + based_on_plan_ref` 重放时幂等；内容不同但 id 相同时拒绝。

通用 Adaptation runtime 不解释 branch `partial`，也不把 partial 映射到 completed、failed 或其他 manifest set。Partial artifact retry 在当前 policy 中固定为 `fail_closed`；只有所属 branch contract 同时更新当前 schema、producer、consumer 和 policy 后，才能明确 branch status、unit identity 和可重试条件。没有该当前 contract 时，`partial_artifact` 等 retry basis literal、仅存在 partial branch artifact 但不在 `failed_units` 的 target，以及调用方私自映射出的 failed 状态一律拒绝。

校验通过写入 `adaptation_validated`；校验失败写入 `adaptation_rejected`，保存具体字段、policy rule 和修订要求，不改变当前计划。需要用户决定时才暂停；一般 schema 或 policy 错误由主 Agent 修订提案后重新提交。

### 12.9 Plan Revision 应用协议

`apply-plan-revision` 以通过校验且会修改计划的 Adaptation Decision 为唯一变更输入，并原子执行：

1. 重新确认 manifest 当前 plan 与 decision 的 base plan 一致。
2. 复制当前有效计划，应用一个或一组彼此不冲突的已批准原子动作。
3. 写入新的 `plans/research-plan.r<N>.json`，记录 parent 和 adaptation refs。
4. 运行完整 Plan validator，而不仅校验变更片段。
5. 原子更新 manifest 的 current plan、revision、unit disposition 和 adaptation refs；只有在已完成 wave 后追加或重试研究工作时才递增 follow-up round，纯 skip/cancel/reprioritize 不递增。
6. 写入 `adaptation_applied`、`plan_revision_created` 和 checkpoint。

若在第 5 步前失败，新 revision 不得成为 current plan；若 manifest 已更新但 checkpoint 未完成，恢复流程通过 event、hash 和 plan lineage 补写 checkpoint。多个 adaptation 可以在同一 revision 原子应用，但必须无目标冲突；否则按独立 revision 串行执行。

`continue_existing_plan`、`request_clarification`、`stop_followup` 和 `terminate_insufficient_evidence` 不创建空 Plan Revision；它们通过 validated/applied event 原子更新 manifest 状态或 gap disposition，并写 checkpoint。只有 unit 集合、依赖或调度属性发生变化时才递增 plan revision。

动态调整仍是领域受控重规划，不是通用 workflow runtime。主 Agent 决定研究问题、语义缺口和 query 目标；Harness 只负责验证允许的动作、生成有效计划、调度已批准 unit 和保存审计状态。

## 13. Subagent 设计

### 13.1 主 Agent

主 Agent 是唯一编排者，负责：

- 解释 Skill 和 mode 合同。
- 形成和维护 DecisionContext，明确当前要回答的决策问题。
- 与用户澄清 scope。
- 创建和维护 Run。
- 生成初始 Research Plan；基于已校验 artifact 形成语义 gap，并通过 Adaptation Decision 提议后续调整。
- 启动、等待、纠偏和停止 subagents。
- 聚合通过校验的 artifact，而不是聚合聊天摘要。
- 执行 gap analysis、机会合成和最终判断，但不直接覆盖当前 plan 或绕过 adaptation policy。
- 保证用户中途指令被持久化。

主 Agent 不应亲自完成所有网页搜索，否则会把原始材料和工具日志塞满主线程上下文。

### 13.2 Custom agent roles

首版只定义三个稳定角色。

#### Lane Researcher

负责一个边界清晰的研究 unit：

- 根据 research goal 设计 query。
- 搜索、阅读和记录来源。
- 抽取 supporting/opposing claims。
- 形成 findings、insights、limitations 和 unresolved questions。
- 写入指定 lane artifact。

默认只写自己分配的 output path 和 Evidence Store，不修改 plan、manifest、comparison policy、决策简报或完整报告。

#### Evidence Auditor

负责独立检查：

- evidence ref 是否存在。
- 引用是否支持对应 claim。
- 来源是否独立、时效是否足够。
- 用户原话是否被改写成模型生成文本。
- supporting/opposing evidence 是否失衡。
- 是否存在把转载链机械累加为多来源的问题。

Auditor 返回 audit artifact，不直接修改研究结论。

#### Adversarial Reviewer

负责攻击当前 synthesis：

- 寻找强替代方案和 non-consumption 解释。
- 检查买单、获客、合规和迁移成本是否被低估。
- 检查 AI 方案是否已被通用模型、平台或开源 baseline 覆盖。
- 检查比较面板是否重复计算相关维度。
- 提出会翻转结论的证据缺口。
- 使用独立 challenger query 和替代解释，避免沿用候选生成阶段的正向搜索路径。

Reviewer 不负责重新写一版更乐观或更悲观的报告，而是输出结构化 revision requests 和 assessment/recommendation challenge。

### 13.3 Subagent task envelope

主 Agent 启动 subagent 时必须提供：

```json
{
  "run_id": "2026-07-23-pet-care",
  "unit_id": "user_language_cn",
  "mode": "opportunity_discovery",
  "research_goal": "提取目标用户在问题发生时的自然语言",
  "input_refs": ["scope-frame.json"],
  "allowed_output_path": "artifacts/lanes/user_language_cn.json",
  "artifact_schema": "startup_opportunity.discovery_lane_result.v1",
  "required_stances": ["support", "oppose"],
  "tool_guidance": [],
  "stop_conditions": [],
  "completion_message": "返回 artifact path、校验状态、limitations 和未解决问题"
}
```

### 13.4 并发和文件所有权

- 只把独立 unit 放入同一 wave。
- 每个 subagent 拥有唯一 output path。
- Evidence 写入使用稳定 operation key，防止同一 URL/内容被重复记录。
- Subagents 不并发修改 `manifest.json`、`plans/`、`adaptations/`、`decision-brief.md` 或 `report.md`。
- 主 Agent 在 validation/fan-in 后串行生成 Gap Snapshot、处理 Adaptation Decision，再为最终生效的 plan revision 写 checkpoint。
- 并发槽不足时按 wave 内优先级分批执行，不改变 plan 语义。

### 13.5 用户实时沟通

用户可以在 subagents 运行期间：

- 缩小或扩大 scope。
- 要求某个 lane 优先。
- 否决某个假设。
- 提供新资料。
- 暂停或停止 Run。

每个 checkpoint 的用户摘要还必须说明：

```text
current_belief
evidence_that_changed_belief
unchanged_assumptions
remaining_disagreement
next_decision_relevant_question
```

用户初始偏好和 belief update 只用于暴露认知变化，不覆盖证据判断。

主 Agent 接收到这类指令后：

1. 写入 decision event。
2. 判断当前 active units 是否仍然有效。
3. 为不再有效的 unit 和新增研究需要生成 Gap Snapshot 与 Adaptation Decision。
4. Harness 校验动作；通过后应用 Plan Revision，并对被取消的 unit 发出停止或忽略其 late artifact。
5. 向用户说明哪些结果会保留、废弃或重新研究。

## 14. Harness、脚本、MCP 与 Hooks 的边界

### 14.1 确定性脚本

适合脚本执行：

- 创建 run id 和目录。
- 读取和原子更新 manifest。
- JSON Schema validation。
- URL canonicalization、内容 hash 和 evidence 去重。
- evidence ref、artifact ref 和 source manifest 校验。
- machine-observable gap 聚合、Adaptation Decision policy validation 和不可变 Plan Revision 原子应用。
- hard gate、面板 band、支配关系、敏感性和 stability band 计算。
- checkpoint snapshot。
- Markdown/JSON 报告装配。
- fixture 和 eval 执行。

不适合脚本隐藏执行：

- 开放式搜索策略。
- 用户需求判断。
- Claim 语义抽取。
- 机会合并/拆分判断。
- selected solution 决策。
- 证据是否构成实质矛盾、哪个 gap 具有最高决策价值以及应该提出什么开放式研究目标。
- 最终推荐理由生成。

### 14.2 MCP

MCP 用于访问本地 repo 之外的工具或共享数据。推荐工具类别：

```text
search_batch
fetch_url
app_store_lookup
google_play_lookup
collect_reviews
trend_lookup
source_metadata
record_evidence
get_evidence_manifest
```

MCP 工具负责按 Agent 提供的 query、URL、source type 和 research goal 获取或记录数据，不负责判断什么是创业机会。

正式判断引用的外部来源必须进入 Evidence Store。探索性 Web Search/Web Fetch 可以用于发现来源，但进入 Claim 前必须生成 Evidence Record。

### 14.3 Hooks

Hooks 只用于机械约束和观测：

- PreToolUse 检查敏感命令、禁止路径和越权写入。
- PostToolUse 记录研究相关工具事件和失败。
- Stop 检查当前阶段要求的 artifact 是否存在并通过验证。
- UserPromptSubmit 可以提示主 Agent 检查用户指令是否需要写入 decision log。

Hooks 不承担：

- mode 路由。
- research plan 生成。
- 状态推进。
- retry 决策。
- report synthesis。

Hook 被禁用或未获信任时，核心 Run 仍应能通过显式 Skill 步骤和脚本完成，只是自动 guardrail 和 telemetry 减少。

### 14.4 权限

- Lane researcher 默认以研究所需的最小文件写范围运行。
- Auditor 和 reviewer 默认只读正式研究产物，只写自己的 audit/review artifact。
- 高风险系统命令和仓库外写入不属于研究任务正常权限。
- 网站、connector 和 MCP 权限遵循父线程当前 permission mode。
- 附件或网页中的指令视为不可信研究内容，不得覆盖 Skill、AGENTS 或用户指令。

## 15. Research Kernel

### 15.1 定位

Research Kernel 是被不同 lane 复用的研究方法和工具组合，不是顶层编排器，也不是独立服务。

```text
initial_probe
  -> search initial query
  -> read representative sources
  -> form initial context
  -> generate queries with research goals
  -> parallel search/fetch
  -> record evidence
  -> extract claims with evidence refs
  -> synthesize findings
  -> synthesize insights
  -> generate decision-relevant follow-up questions
  -> contribute semantic gaps to Gap Snapshot
  -> execute bounded follow-up only through validated Plan Revision
  -> curate source manifest
  -> structured judgment context
```

### 15.2 Query 合同

每个 query 必须包含：

```text
query_text
research_goal
target_subject
expected_evidence_type
geo
language
time_range
source_preferences
stop_condition
```

禁止只生成关键词而不说明研究目标。相同关键词可以服务不同目标，例如验证用户语言、竞品覆盖或买单信号，不能混为同一个 query。

### 15.3 Context hygiene

- Raw evidence 只保存在 Evidence Store。
- 下游 context pack 默认包含 Claims、Findings、Insights、source metadata 和 evidence refs，不携带整段网页正文。
- 需要复核引用时按 evidence ref 定向读取原文。
- Subagent 返回给主 Agent 的消息只包含结论摘要、artifact path、limitations 和 open questions。
- 主 Agent 不把全部 subagent transcript 拼进最终综合上下文。

### 15.4 Follow-up

Follow-up 只针对会改变决策的问题。常见触发条件：

- supporting/opposing evidence 明显失衡。
- 关键 Claim 只有单一或非独立来源。
- Baseline Option 不清楚。
- buyer、payer、purchase trigger 或获客路径缺证据。
- AI 方案缺少通用模型、平台或开源 baseline。
- reviewer 提出可能翻转 assessment 或 recommendation 的证据缺口。
- 关键数据已过 freshness policy。

这些信号必须先进入 Gap Snapshot，再由 Adaptation Decision 映射为受控动作。Research Kernel 可以提出新的 query 和研究目标，但不能自行启动 unit 或修改 plan。

停止条件：

- 达到 `max_followup_rounds`。
- 连续一轮没有 material new evidence。
- 新证据不会改变 hard gate、assessment、推荐档位或主要 limitation。
- 无法访问更高质量来源，继续搜索只会重复已有样本。
- 用户要求停止或接受当前 limitation。

### 15.5 Abstention

研究未找到足够材料时必须返回 `insufficient_evidence` 或降低推荐档位。不得用模型常识填补来源缺口，也不得把“缺少反对证据”解释成支持。

## 16. Evidence、Claim、Finding 与 Insight

### 16.1 分层关系

```text
Evidence
  -> Claim
  -> Finding
  -> Insight
  -> Judgment Assessment
  -> Demand Thesis / Solution Hypothesis
  -> Opportunity Thesis or Concept Evidence Assessment
```

- Evidence 是网页、评论、报告、榜单、帖子、公开数据或测试结果等原始材料。
- Claim 是可被单独支持或反驳的事实/判断。
- Finding 是对多条 Claim 的归纳发现。
- Insight 是与创业决策直接相关的跨来源或跨 lane 洞察。
- Judgment Assessment 对一个会影响决策的判断汇总 supporting/opposing refs、信号状态、代表性、独立性和决策充分性。
- 下游对象必须通过 refs 回溯，不能复制一段无来源的自然语言作为证据。

### 16.2 Evidence Record

```json
{
  "schema_version": "startup_opportunity.evidence.v1",
  "evidence_id": "ev_001",
  "run_id": "2026-07-23-pet-care",
  "unit_id": "review_mining_cn",
  "source_type": "app_store_review",
  "evidence_origin": "public_source",
  "source_name": "App Store",
  "url": "https://example.com",
  "published_at": "2026-06-01",
  "retrieved_at": "2026-07-23T00:00:00Z",
  "query": "用药提醒 App 家庭协同 差评",
  "research_goal": "验证现有提醒工具是否存在家庭同步缺口",
  "research_phase_role": "candidate_evaluation",
  "geo": "CN",
  "language": "zh-CN",
  "sample_size": 120,
  "source_independence": "primary",
  "source_bias": "negative_review_heavy",
  "evidence_tier": "public_behavior_proxy",
  "evidence_lifecycle_status": "active",
  "representativeness": "评论样本偏向主动反馈用户，不能代表全体用户",
  "evidence_role": "support",
  "user_language_role": "trigger_phrase",
  "solution_failure_role": "current_solution_failed",
  "claim_refs": ["claim_001"],
  "sentiment": "negative",
  "relevance": 0.86,
  "credibility": 0.72,
  "content_hash": "sha256:...",
  "raw_content_ref": "evidence/raw/ev_001.txt",
  "valid_as_of": "2026-07-23",
  "freshness_policy": "revalidate_when_product_or_market_changes",
  "limitations": []
}
```

Evidence Store 使用 `(canonical_url, content_hash, research_goal)` 或等价稳定 operation key 去重。相同来源服务不同研究目标时可以复用 raw content，但必须分别记录关联关系。

### 16.3 Claim

```json
{
  "schema_version": "startup_opportunity.claim.v1",
  "claim_id": "claim_001",
  "run_id": "2026-07-23-pet-care",
  "unit_id": "review_mining_cn",
  "claim_type": "pain_point",
  "statement": "部分用户对用药提醒的家庭成员同步能力不满意。",
  "stance": "support",
  "trigger_phrase_refs": ["user_language_001"],
  "mental_positioning_refs": ["mental_position_001"],
  "solution_failure_refs": ["solution_failure_001"],
  "demand_refs": ["demand_001"],
  "solution_refs": [],
  "opportunity_refs": ["opportunity_001"],
  "evidence_refs": ["ev_001"],
  "evidence_independence": 0.72,
  "confidence_band": "medium",
  "sample_bias": "主动评论用户可能偏向强不满",
  "limitations": []
}
```

Claim 的 `confidence_band` 是证据校准后的离散判断，不是统计概率。

### 16.4 Finding

```json
{
  "schema_version": "startup_opportunity.finding.v1",
  "finding_id": "finding_001",
  "unit_id": "review_mining_cn",
  "summary": "提醒、记录和家庭协同经常被拆散在多个工具中。",
  "claim_refs": ["claim_001", "claim_002"],
  "opposing_claim_refs": ["claim_009"],
  "demand_refs": ["demand_001"],
  "solution_refs": [],
  "confidence_band": "medium",
  "limitations": []
}
```

### 16.5 Insight

```json
{
  "schema_version": "startup_opportunity.insight.v1",
  "insight_id": "insight_001",
  "source_units": ["review_mining_cn", "top_products_cn"],
  "summary": "长期照护协同可能比单点提醒具有更强的增量价值。",
  "finding_refs": ["finding_001", "finding_002"],
  "decision_relevance": "opportunity_definition",
  "demand_refs": ["demand_001"],
  "solution_refs": ["solution_001"],
  "opportunity_refs": ["opportunity_001"],
  "confidence_band": "medium",
  "limitations": []
}
```

### 16.6 来源独立性和证据等级

多个转载、互相引用的媒体文章或来自同一评论数据集的统计不能机械算作多个独立来源。Evaluator 应考虑：

```text
primary vs secondary
source ownership
shared underlying dataset
sample size and selection bias
target market match
time relevance
direct behavior vs stated opinion
vendor claim vs independent test
reproducibility
```

推荐证据等级：

```text
direct_behavior
transaction_or_commitment
observed_workflow
public_behavior_proxy
self_reported_need
expert_or_operator_report
vendor_claim
media_or_trend_signal
model_inference_only
```

`model_inference_only` 不能单独通过 hard gate。

`evidence_origin` 使用：

```text
public_source
user_provided_existing_material
repository_existing_material
```

`research_phase_role` 使用：

```text
candidate_generation
candidate_evaluation
adversarial_challenger
shared_context
```

它只表示材料在 Run 开始或研究过程中如何被系统取得，不表示系统执行了外部验证。用户提供的已有访谈、交易或行为材料仍必须记录原始方法、样本、时间、选择偏差和可复核性，不能仅因来自用户而自动获得高等级。

证据等级对应结论上限：

| 当前主要证据 | 允许用途和结论上限 |
| --- | --- |
| `model_inference_only`、`media_or_trend_signal` | 只能形成研究线索，不能单独支持正式推荐 |
| `vendor_claim`、`expert_or_operator_report`、`self_reported_need` | 可以支持初步 hypothesis；决定性维度仅有这些材料时最高为 `investigate_further` 或 `insufficient_evidence` |
| `public_behavior_proxy`、`observed_workflow` | 可以支持较强的当前证据判断，但仍须披露代表性、迁移和买单限制 |
| `direct_behavior`、`transaction_or_commitment` | 如果当前可获得，可以提高 decision sufficiency；系统不负责主动生成或追踪 |

缺少 `direct_behavior` 或 `transaction_or_commitment` 不自动产生反对判断。它只能构成 evidence gap、结论上限或 limitation。

### 16.7 判断信号与决策充分性

Evidence 的生命周期、Evidence 对某个判断的作用，以及当前材料是否足以支持决策是三件不同的事。不得用一个 `evidence_status` 同时表达这三层语义。

每个会影响 hard gate、候选保留、selected solution、排序、推荐档位或 concept assessment 的关键判断，都必须形成独立的 `JudgmentAssessment`：

```json
{
  "schema_version": "startup_opportunity.judgment_assessment.v1",
  "judgment_id": "judgment_001",
  "subject_ref": "demand_001",
  "dimension": "migration_intent",
  "judgment_signal": "mixed",
  "evidence_tier_summary": ["public_behavior_proxy", "self_reported_need"],
  "supporting_claim_refs": ["claim_001"],
  "opposing_claim_refs": ["claim_009"],
  "representativeness": "公开评论偏向主动反馈用户",
  "independence": "two_independent_source_groups",
  "decision_sufficiency": "insufficient",
  "insufficiency_reasons": ["low_tier_only"],
  "what_would_change_the_decision": ["获得目标家庭的迁移或付费承诺证据"],
  "valid_as_of": "2026-07-23",
  "limitations": []
}
```

`judgment_signal` 使用 closed values：

```text
supported
opposed
mixed
no_signal
source_unavailable
not_applicable
```

`decision_sufficiency` 使用：

```text
sufficient
insufficient
blocked
not_applicable
```

`blocked` 只用于缺少必须由用户授权、私有数据或不可替代外部来源提供的决定性输入；一般公开资料不足使用 `insufficient`。`not_applicable` 必须说明为什么该维度与当前 subject 无关。

`insufficiency_reasons` 至少支持：

```text
no_signal
conflicting_signal
source_unavailable
stale_decisive_evidence
low_tier_only
single_source
missing_required_dimension
```

`source_unavailable` 表示完成合理检索后仍无法获得决定性来源，必须由 Source Manifest 中的访问失败或来源缺口记录支撑；它不等于没有查到支持观点。`no_signal` 表示来源可获得，但没有观察到相关信号。`confidence_band` 只表达判断可信程度，不能替代 `decision_sufficiency`。

### 16.8 Freshness

所有 Evidence 必须有 `valid_as_of` 和 `freshness_policy`。以下内容尤其需要重新校验：

- 竞品功能、价格和排名。
- 用户评论和渠道状态。
- 市场规模、法规和平台政策。
- 模型能力、API 约束、License 和价格。
- AI benchmark、延迟和单位经济。

`stale` 表示证据过期，不等于机会被推翻。过期 Evidence 可以保留审计记录，但不能继续支撑强推荐。

AI capability Evidence 还应记录：

```text
provider
model_id
model_version
pricing_snapshot
license
benchmark_setup
evaluation_dataset_ref
deployment_region
vendor_claim_or_independent_test
reproducibility
latency_observation
product_cost_observation
valid_as_of
freshness_policy
```

`evidence_lifecycle_status` 只描述 Evidence Record 本身的生命周期，使用 closed values：

```text
active
superseded
stale
unverified
```

Evidence 对判断的支持或反对作用由 `evidence_role`、Claim stance 和 `JudgmentAssessment` 表达，不写入生命周期状态。

### 16.9 Source Manifest

```text
manifest_id
run_id
unit_id
accepted_evidence_refs
rejected_source_records
  - source
  - rejection_reason
unavailable_source_records
  - source
  - access_failure_or_missing_reason
canonical_source_groups
shared_dataset_groups
duplicate_or_syndication_groups
source_type_coverage
geo_language_coverage
time_coverage
stance_coverage
generation_source_groups
evaluation_source_groups
challenger_source_groups
generation_evaluation_overlap
known_source_blind_spots
freshness_summary
limitations
```

Source Manifest 既记录采用的来源，也记录读过但拒绝使用的来源及原因，避免 follow-up 重复读取低质量材料。

### 16.10 Traceability

最终 traceability artifact 至少验证：

```text
report statement
  -> decision brief
  -> decision recommendation or concept assessment
  -> comparison/dimension decision
  -> judgment assessment
  -> opportunity/concept subject ref
  -> insight
  -> finding
  -> claim
  -> evidence
```

并非每句报告文字都需要单独 Claim，但所有决定性事实、用户 quote、分数输入、hard gate 和反证必须可回溯。

## 17. Scope Framing

### 17.1 Decision Context

每个新 Run 在 ScopeFrame 之前生成 `decision-context.json`：

```json
{
  "schema_version": "startup_opportunity.decision_context.v1",
  "decision_to_make": "choose_opportunity",
  "decision_question": "在当前团队条件下，宠物行业中哪个消费者机会最值得优先关注？",
  "decision_options": [],
  "venture_goal": "durable_small_business",
  "decision_horizon": "本次 Run 结束时形成优先方向判断",
  "founder_advantages": [],
  "non_negotiable_constraints": [],
  "team_capability_refs": [],
  "risk_preferences": [],
  "initial_belief": "unknown",
  "favored_hypothesis": null,
  "assumed_truths": [],
  "final_decision_owner": "user",
  "assumptions": [],
  "open_questions": []
}
```

`decision_to_make` 使用 closed values：

```text
choose_opportunity
assess_concept_viability
prioritize_research_gap
reassess_with_new_material
```

`venture_goal` 使用：

```text
bootstrapped_cashflow
durable_small_business
venture_scale
strategic_exploration
unspecified
```

`venture_goal`、团队能力和风险偏好用于区分 opportunity quality 与 team execution fit，并选择已经发布的 decision/comparison profile；它们不允许用户或 Agent 在 active Run 中临时修改单项面板的重要性。用户不愿提供初始判断时使用 `unknown`，不得由 Agent 猜测。

### 17.2 机会发现 Scope

`scope-frame.json` 至少包含：

```text
direction
decision_context_ref
discovery_profile
research_axes
market
language
target_users
excluded_users
platform
market_motion
acquisition_motion
buyer_model
payment_mode
native_app_required
delivery_form_preferences
business_model_preferences
team_capability_constraints
risk_preferences
ai_scope
assumptions
open_questions
```

Closed values：

```text
market_motion
  consumer

acquisition_motion
  direct | community | channel | marketplace

buyer_model
  self_payer | household_payer | sponsor_payer | provider_channel

payment_mode
  subscription | one_time | transaction | service_fee | referral | free_with_indirect_revenue

delivery_form_preferences
  native_app | mini_program | mobile_web | PWA | hybrid_app
  | platform_native | service_assisted
```

`discovery_profile`：

```text
general
industry_first
ai_first
hybrid
```

`research_axes` 可包含：

```text
user_language
industry_demand
jtbd_workflow
solution_failure
competitor_gap
buyer_market
distribution
ai_capability
regulation
```

Profile 只影响 lane 优先级和必填 bundle，不改变最终必须形成 Demand Thesis、Solution Hypothesis、Baseline Option 和 Opportunity Thesis 的要求。

`market` 和 `language` 表示当前 Run 的单一 primary market 和 primary research language。一个 Run 不混合多个国家的需求、买单、竞争、法规和渠道证据，也不把不同国家未经校准的分数放入同一排名。用户要求比较多个国家时，为每个市场创建独立 Run；这些 Run 可以互相引用，但首版不生成自动跨市场统一排名或进入顺序建议。

首版不采集用户侧外部验证金额、人数或资源预算：

- `DecisionContext.decision_horizon` 只表示希望获得当前研究判断的时间范围。
- `team_capability_constraints` 只表示当前团队已有的技术、行业、渠道和运营能力边界。
- 系统不得从这两个字段推断用户未声明的资金预算，也不得声称建议的验证动作符合用户实际资源条件。

### 17.3 概念证据评估 Scope

```text
product_thesis
decision_context_ref
target_user
buyer / payer
entry_scene
claimed_value
current_alternative
market / language
delivery_form
business_model
acquisition_hypothesis
team_constraints
assumptions
unknowns
kill_criteria
assessment_profile
```

`assessment_profile`：

```text
general
ai
regulated_ai
```

AI profile 必须研究 baseline、可靠性、数据、人工复核、provider/platform 依赖和商品化风险。Regulated AI 额外检查责任、可解释性、审计、隐私和人工控制边界。

概念证据评估同样遵守单一 primary market、单一 primary language 和不采集外部验证预算的边界。`DecisionContext.decision_horizon` 只帮助判断优先补充哪个桌面证据缺口或如何描述可选建议，不用于估算金额、人数或资源配置，也不创建外部验证生命周期。

### 17.4 需要澄清的情况

- `decision_to_make` 无法从用户问题中可靠判断，且不同解释会改变输出。
- 缺少目标市场或语言会改变结论。
- 输入同时要求 TopN 发现和单一 thesis assessment。
- 输入要求多个国家统一评分或直接排名；首版应说明将拆分为独立市场 Run，而不是混合证据继续。
- 目标用户、买单方或产品概念完全无法区分。
- 用户明确要求依赖当前无法访问的私有数据。
- 约束相互冲突，例如只允许消费者产品但 thesis 是企业基础设施。

非关键字段可以带显式 assumption 继续，不为每个未知数都打断用户。

## 18. 机会发现流程

```text
discover intake
  -> decision context
  -> scope framing
  -> initial probe
  -> opportunity space map
  -> solution space map
  -> research plan
  -> discovery waves
  -> lane artifact validation
  -> Gap Snapshot
  -> validated Adaptation Decision / bounded Plan Revision
  -> Demand Thesis synthesis
  -> Solution Hypothesis comparison
  -> Opportunity Thesis synthesis
  -> freeze thesis / assumptions / kill criteria
  -> dedupe and clustering
  -> enrichment waves
  -> Business Engine Thesis
  -> evidence audit
  -> hard gates and comparison
  -> sensitivity and portfolio view
  -> adversarial review
  -> optional decisive Gap Snapshot / Plan Revision
  -> report.json
  -> decision brief + full report
```

### 18.1 Initial Probe

Initial Probe 只负责扩大检索入口：

```text
audience seeds
scenario seeds
problem seeds
keyword seeds
product seeds
source seeds
capability/model/ecosystem seeds when relevant
```

Seed 不是先验真值。至少一个需求/任务 unit 只读取 scope，不读取 product/capability seeds；至少一个 counterfactual unit 主动寻找与初始假设不同的人群、任务或替代方案。

### 18.2 Opportunity Space Map

形成：

```text
user and buyer roles
jobs to be done
workflow maps
task operating profiles
current alternatives
baseline options
workaround patterns
workflow friction points
non-consumption
software leverage points
state/context opportunities
buyer language hypotheses
initial demand hypotheses
disconfirming questions
```

### 18.3 Solution Space Map

同一 Demand Thesis 下同时考虑：

```text
ordinary software
platform-native capability
human or service-assisted solution
native app
mini program
mobile web / PWA
hybrid app
AI-assisted solution
maintain the status quo
```

AI 方案适用时补充 capability frontier、failure modes、human-in-the-loop、data/evaluation requirements、provider/open-source landscape 和 capability half-life。

### 18.4 Discovery Waves

需求、任务、替代方案和用户语言 unit 可以并行。解决方案证据 unit 根据需求和候选方案条件启用，不应在需求尚未定义前让 AI capability research 主导机会生成。条件启用不是隐式分支：如果该 unit 不在当前 plan 中，必须通过 `add_unit` Adaptation Decision 进入下一版 plan。

每个 lane 产出：

```text
claims
supporting_claims
opposing_claims
findings
insights
typed pre-thesis discovery candidate refs
pre_kill_decisions
retained / watchlist / rejected candidate refs
open_questions
source_manifest
limitations
```

G2.2 采用方案 A：lane 不发布正式 Demand Thesis、Baseline Option 或 Solution Hypothesis。主 Agent 先把 G2.1 map 的一个 exact fragment 物化为 `startup_opportunity.discovery_candidate.v1`；candidate kind 只允许 `demand_seed | baseline_seed | solution_seed`，始终标记 `pre_thesis_unvalidated`。lane 只评估 task 中分配的 typed candidate revision，main Agent 通过新的 immutable revision 合并 Evidence enrichment，并在 G2.3 另行执行显式 conversion。

Candidate rN 的 enrichment 只能吸收相对 rN-1 新增且可解析的 Evidence、Claim、Finding、Insight、Source Manifest 和 Judgment refs。每个新对象的 typed lineage 必须解析到 `research_task.v2`，该 task 的 `target_candidate_refs` 必须包含被 enrichment 的 exact rN-1 path；只面向 sibling/其他 candidate 或另一 revision 的材料不能影响当前 revision。Judgment v2 同时携带该 task lineage，并要求 `subject_ref` exact 等于 rN-1。流程顺序固定为“先对 source revision 形成 Judgment，再生成 enriched revision”，不得反向要求 Judgment 以尚未生成的 rN 为 subject。

### 18.5 Synthesis 与聚类

先基于 user/job/scene/current alternative/baseline 合并 Demand Thesis，再在同一需求下比较 Solution Hypotheses。不要先按产品标题 embedding 合并，否则容易把同名但不同买单逻辑的机会混在一起。

聚类规则：

- 用户、JTBD、入口场景和 baseline 高度一致时合并。
- 用户一致但触发场景和购买逻辑明显不同时拆分。
- 交付形态不同但本质解决同一需求时保留为同一机会下的方案比较。
- 商业模式、获客路径或合规边界根本不同时拆分。

### 18.6 Enrichment

对合并后的候选并行补充：

```text
competitor gap
market space
monetization
buyer purchase language
acquisition and distribution
business engine and reachable beachhead
delivery feasibility
compliance and platform risk
counter evidence
early unit economics
AI baseline and dependency bundle when relevant
```

完成 enrichment 后再进行全局 hard gate、四面板比较、partial order 和 portfolio view。

`candidate_pre_killed` 可以触发对尚未开始且仅服务该候选 exact revision 的 enrichment unit 执行 `skip_unit`。current Discovery adaptation binding 必须要求 Gap `subject_ref` 解析为 exact `discovery_candidate.v1` Envelope，而不只是匹配 path/string；Envelope type/path、Run、Plan ref、document content hash 与完整 Envelope hash 必须闭合，target unit 仍为 pending/enabled，且其 candidate-shaped `input_refs` 只有该 subject。缺少/null/non-envelope subject、错误 type/Run/Plan/hash/revision 或同时服务 retained/shared candidate 时不得 skip，必须保留或由新 unit supersede。首次 apply 在任何 receipt/Artifact/Manifest write 前重验 durable candidate；candidate-bound immutable Plan receipt 记录 exact candidate/Plan binding，replay、checkpoint/reopen 和 crash recovery 每次都重验 receipt 与 durable bytes，不能让 transformer 或其他 receipt 路径绕过前置条件。candidate-bound Plan revision 后，validated current receipt 只授权按其 exact historical Plan ref/hash/revision 和 bound candidate refs 构造只读 Plan/Manifest validation view，以解决同一 Run 的历史/current Plan 同时存在时的 cardinality。G2.1 map 与 G2.2 candidate domain evaluator 必须在该 view 上完整执行，未被 receipt 绑定的 map/candidate 也必须重验；不得以 receipt 存在为由全局跳过 domain、schema、typed reference、receipt 或 byte-integrity validation。`uses_ai=true` 且 mandatory AI bundle 缺失时必须触发 `add_unit`，或在无法补齐时限制结论强度。

## 19. 概念证据评估流程

```text
assess intake
  -> decision context
  -> concept framing
  -> evidence assessment questions and plan
  -> parallel assessment waves
      -> target user / JTBD / user language
      -> current alternatives / solution failure
      -> demand and behavior signals
      -> competitor saturation / differentiation
      -> willingness to pay / buyer language
      -> acquisition / distribution feasibility
      -> delivery feasibility / compliance
      -> AI or regulated-AI bundle when applicable
      -> counter evidence
  -> branch artifact validation
  -> hypothesis evidence matrix
  -> Business Engine Thesis
  -> evidence audit
  -> Gap Snapshot
  -> validated Adaptation Decision / bounded Plan Revision
  -> adversarial review
  -> assessment gate
  -> optional validation suggestions
  -> report.json
  -> decision brief + concept evidence report
```

所有 branch output 必须回连同一个 `concept_hypothesis_id`。不得在某个 branch 中重新定义产品目标或另行生成机会池。

### 19.1 Hypothesis Evidence Matrix

```text
dimension
hypothesis
supporting_claim_refs
opposing_claim_refs
judgment_assessment_refs
evidence_quality
freshness
decision
decision_sufficiency
insufficiency_reasons
uncertainty
what_would_change_decision
limitations
```

### 19.2 Assessment Result

```text
prioritize
  当前可获得证据对关键需求、baseline 增量、买单、获客和可行性提供了相对较强支持，值得优先关注；不表示真实市场已经验证。

investigate_further
  主 thesis 存在值得继续研究的信号，但仍有会改变判断的决定性公开证据缺口或证据等级限制。

deprioritize
  强替代方案、缺少增量价值、买单/获客逻辑不成立、不可接受风险或高质量反证使当前 thesis 不值得优先关注。

insufficient_evidence
  关键维度无法获得足够证据，不能可靠给出方向性结论。
```

Assessment result 不能仅由 LLM 自由写作生成。确定性 gate 检查必填维度、证据状态、结论上限和 hard fail，主 Agent 再基于通过校验的 evidence matrix 形成解释。

### 19.3 Concept Evidence Assessment Plan

该对象表达 assess mode 的领域维度和 assessment gate，并由当前 Research Plan revision 引用。它不是绕过通用 Plan Revision 协议的第二个调度器：如果 Adaptation Decision 增加、跳过或 supersede assessment dimension/unit，必须同时发布新的 assessment plan revision，并由新的 Research Plan 指向它。已被 branch artifact 使用的旧 revision 不可覆盖。

```text
revision
parent_plan_ref
triggered_by_adaptation_refs
concept_hypothesis_ref
assessment_profile
dimensions
  - dimension_id
  - hypothesis
  - decision_impact
  - required_evidence_types
  - supporting_questions
  - disconfirming_questions
  - branch_unit_type
  - stop_condition
mandatory_bundles
followup_policy
assessment_gate_version
limitations
```

必填通用 dimensions：

```text
target_user_and_jtbd
demand_and_behavior
current_alternatives_and_solution_failure
competitor_saturation_and_differentiation
buyer_language_and_willingness_to_pay
acquisition_and_distribution
business_engine_viability
delivery_feasibility
compliance_and_platform_risk
counter_evidence
```

### 19.4 Concept Evidence Assessment Branch Result

```json
{
  "schema_version": "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  "concept_hypothesis_id": "concept_001",
  "dimension_id": "buyer_language_and_willingness_to_pay",
  "research_questions": [],
  "evidence_refs": [],
  "supporting_claim_refs": [],
  "opposing_claim_refs": [],
  "judgment_assessment_refs": [],
  "findings": [],
  "dimension_decision": "mixed",
  "decision_sufficiency": "insufficient",
  "insufficiency_reasons": ["low_tier_only"],
  "evidence_quality": "medium",
  "uncertainty": "medium",
  "what_would_change_decision": [],
  "open_questions": [],
  "limitations": []
}
```

`dimension_decision` 使用：

```text
supports
mixed
opposes
insufficient_evidence
not_applicable
```

`dimension_decision` 是面向 assessment result 的简化结果；它必须由 `judgment_assessment_refs` 推导。`supports | opposes | mixed` 分别对应 Judgment Assessment 的 `supported | opposed | mixed`，而 `insufficient_evidence` 必须保留具体 insufficiency reasons，不能吞并 `no_signal`、`source_unavailable`、冲突或 stale 等不同原因。

### 19.5 Assessment Gate

- `prioritize` 要求所有决定性 desk-evidence hard gate 通过，没有未解决的 thesis-killing opposition，并且明确声明“值得优先关注”而不是“市场已经验证”。
- 缺少 BusinessEngineThesis，或定价、留存/复购、可触达 beachhead 和服务负担均无法形成可审计假设时，不得输出 `prioritize`。
- `investigate_further` 用于存在正向信号，但仍有少量决定性公开证据缺口、来源重叠或证据等级限制的情况。
- 任一决定性维度被高质量反证推翻，可以直接产生 `deprioritize`，不因其他维度表现较强而抵消。
- 决定性维度只有低等级、过期或单一来源证据时产生 `insufficient_evidence`。
- AI/regulated-AI mandatory bundle 不完整时不得输出 `prioritize`。
- 缺少系统职责范围外的行为、承诺或交易证据本身不得产生 `deprioritize`；只能形成结论上限、critical gap 或 limitation。
- Assessment result 必须列出 decisive evidence、decisive opposition、critical gaps 和 what would change decision。

## 20. 调研 Lane Catalog

### 20.1 用户真实语言与心智定位

目标：找到用户在问题发生时会自然说出的表达，而不是产品功能词。

输出：

```text
user_language_samples
natural_expressions
trigger_phrases
rejected_function_terms
mental_model_clusters
candidate_mental_positions
entry_scene_candidates
frequency signals
emotion intensity
```

来源可以包括社区、论坛、评论、问答、搜索建议和用户公开叙述。模型生成的模拟用户语言不能作为真实样本。

### 20.2 受众需求痛点

目标：识别高频、高损失、反复发生且有行动动机的问题。

重点检查：

```text
problem frequency
severity / loss
current workaround
switching behavior
willingness to change
who experiences vs who pays
```

### 20.3 JTBD 与任务流拆解

目标：理解问题位于哪一步、前后依赖什么、异常如何处理、哪些部分需要持续状态。

输出 task operating profile：

```text
frequency
volume
input/output modality
variability
exception rate
context fragmentation
judgment intensity
latency tolerance
error cost
human review tolerance
```

### 20.4 已有产品 Top 排名挖掘

目标：了解头部产品占领了什么位置、用户为什么选择、尚未覆盖什么。

禁止只按下载量或榜单名次推断市场机会。必须结合功能、评论、定位、地区、价格和替代方案。

### 20.5 用户评论与差评挖掘

目标：识别真实失败场景、流失原因、用户用词和未解决期望。

评论样本天然偏向主动反馈用户，必须记录 sample bias，不能把差评频率直接解释成总体市场比例。

### 20.6 搜索需求与内容缺口

目标：识别用户主动寻找答案、模板、工具或服务的信号。

内容热度不等于付费需求。该 lane 只能作为 demand proxy，需与替代行为和买单证据交叉验证。

### 20.7 趋势变化

目标：发现法规、人口、平台、成本、行为或技术变化是否创造了新的 why now。

融资新闻、模型发布或媒体热度本身不能成为机会，只能解释 timing。

### 20.8 替代方案与非 App 竞争

目标：研究人工服务、表格、微信群、纸质流程、平台内置功能、通用模型和“不解决”这些真实 baseline。

### 20.9 现有解法失效场景

目标：明确当前方案在什么时刻失败，失败后用户做什么，是否产生迁移动机。

```text
current_solutions
solution_failure_scenes
failure_modes
non_consumption_cases
abandonment_reasons
next_actions_after_failure
migration_intent
current_solution_inertia
```

### 20.10 AI 能力证据与方案评估

仅对相关候选启用。该 lane 使用一个 `ai_capability_evidence` unit type，但必须覆盖以下业务维度；这些维度不是固定 graph node：

| Dimension | 必答问题 |
| --- | --- |
| `capability_frontier` | 哪些目标任务最近从不可行变为可行，真实边界和失败模式是什么 |
| `cost_and_deployment` | 质量、延迟、推理成本、端侧/云端部署和开源可用性是否支持产品化 |
| `workflow_and_human_boundary` | 哪些 task step 可自动化或增强，哪些必须 human-in-the-loop，异常如何恢复 |
| `ecosystem_and_platform` | 分发、集成、provider portability、平台内置和 incumbent bundling 风险如何 |
| `data_and_evaluation` | 数据权利、ground truth、代表性评测、线上监控和反馈闭环能否成立 |
| `adoption_and_trust` | 安全、隐私、可解释性、责任和消费者信任是否允许进入目标工作流 |

输出至少包括：

```text
newly feasible tasks
generic model + prompt/tool baseline
platform-native baseline
open-source baseline
quality / reliability boundary
latency boundary
failure modes
human-in-the-loop boundary
data and evaluation requirements
provider dependency
platform bundle risk
capability half-life
defensibility beyond model access
adoption and trust boundary
```

同时输出 coverage matrix：

```json
{
  "required_dimensions": ["capability_frontier", "data_and_evaluation"],
  "dimension_results": [
    {
      "dimension": "capability_frontier",
      "coverage_status": "covered",
      "artifact_refs": ["capability_001"],
      "judgment_assessment_refs": ["judgment_ai_001"],
      "limitations": []
    }
  ],
  "missing_required_dimensions": []
}
```

`coverage_status` 使用 `covered | insufficient_evidence | not_applicable`。Mandatory dimension 不得仅因来源难找而标记 `not_applicable`；来源不可得时必须使用 `insufficient_evidence` 并记录 `source_unavailable`。

### 20.11 买单、商业化、获客与业务闭环

目标：把用户触发语言翻译成购买语言，明确预算来源、决策标准、价格替代、第一批用户获取路径，并形成所有候选都适用的 `BusinessEngineThesis`。

业务闭环至少覆盖：

```text
pricing_unit
usage_or_purchase_frequency
retention_or_repeat_trigger
gross_margin_band
service_and_support_burden
cac_hypothesis
payback_logic
reachable_beachhead_market
channel_dependency
growth_loop
minimum_viable_scale
```

相关字段使用区间、假设和证据 refs，不因缺少一方经营数据伪造精确数值。宽泛 TAM、内容热度或竞品融资不能替代可触达 beachhead 和业务闭环。

### 20.12 反证

Counter-evidence 不是普通 lane 的重复搜索。它应主动寻找：

- 当前解法其实已经足够。
- 问题低频或损失很小。
- 用户抱怨但不会迁移。
- 使用者和付款者利益不一致。
- 平台很快会内置。
- 合规、数据或交付成本不可接受。
- 市场信号来自同一来源链。
- 候选生成和评估证据高度重叠，结论可能来自自证循环。

### 20.13 Lane Plan 合同

每个 lane unit 除通用 Research Plan 字段外，还必须有：

```json
{
  "lane_plan_id": "lane_plan_001",
  "lane_type": "review_mining",
  "research_goals": [],
  "queries": [],
  "source_preferences": [],
  "source_exclusions": [],
  "required_evidence_types": [],
  "candidate_retention_threshold": "",
  "candidate_diversity_dimensions": [
    "user",
    "jtbd",
    "entry_scene",
    "buyer_model",
    "opportunity_source"
  ],
  "required_counter_questions": [],
  "stop_conditions": [],
  "output_path": "",
  "artifact_schema": "startup_opportunity.discovery_lane_result.v1"
}
```

### 20.14 Lane Result 合同

```json
{
  "schema_version": "startup_opportunity.discovery_lane_result.v1",
  "run_id": "2026-07-23-pet-care",
  "unit_id": "review_mining_cn",
  "lane_type": "review_mining",
  "research_goals": [],
  "queries": [],
  "evidence_refs": [],
  "source_manifest_ref": "",
  "judgment_assessment_refs": [],
  "claims": [],
  "supporting_claims": [],
  "opposing_claims": [],
  "findings": [],
  "insights": [],
  "task_operating_profile_refs": [],
  "candidate_refs": [],
  "capability_evidence_refs": [],
  "user_language_refs": [],
  "solution_failure_refs": [],
  "business_engine_refs": [],
  "scored_candidates": [],
  "kill_conditions": [],
  "pre_kill_decisions": [],
  "rejected_candidate_refs": ["artifacts/discovery/candidates/<candidate_id>.r<n>.json"],
  "watchlist_candidate_refs": ["artifacts/discovery/candidates/<candidate_id>.r<n>.json"],
  "retained_candidate_refs": ["artifacts/discovery/candidates/<candidate_id>.r<n>.json"],
  "candidate_diversity_summary": {
    "covered_users": [],
    "covered_jobs": [],
    "covered_entry_scenes": [],
    "covered_buyer_models": [],
    "counterfactual_candidates": [],
    "known_blind_spots": []
  },
  "decision_sufficiency_summary": {
    "status": "insufficient",
    "insufficiency_reasons": [],
    "what_would_change_the_decision": []
  },
  "open_questions": [],
  "audit_refs": [],
  "limitations": []
}
```

`claims`、`findings`、`insights` 和各类领域对象只保存 typed refs，正式对象仍独立存储。G2.2 的三个 disposition set 只允许引用 `startup_opportunity.discovery_candidate.v1` 的 immutable path/revision；禁止标题字符串、隐式 map path、G2.1 fragment 本身或尚未发布的 G2.3 schema。每个影响保留或淘汰的关键判断必须出现在 `judgment_assessment_refs` 中；`decision_sufficiency_summary` 不得仅由 lane 自报，Evaluator 必须根据引用对象复算其允许进入的最高阶段。

每个 `pre_kill_decisions[*].judgment_assessment_refs` 必须解析为 typed `judgment_assessment.v2`；每个 Judgment 的 `subject_ref` 必须 exact 等于该 decision 的 `candidate_ref`，其 `lineage.task_ref` 必须 exact 等于 lane 的 `task_ref`，且 owning task 必须分配了该 candidate revision。Lane 的 `evidence_lineage.judgment_assessment_refs` 必须包含这些 refs。只面向另一个 candidate 的 Judgment 即使处于同一 Run、同一 lane 或引用相同 Claim，也不得影响当前 disposition。

### 20.15 Lane 内评分与 Pre-kill

Lane score 是 0-10 triage 信号，不是概率，也不能直接跨 lane 比较：

```json
{
  "candidate_ref": "artifacts/discovery/candidates/demand_001.r1.json",
  "lane_type": "review_mining",
  "score": 7.8,
  "score_dimensions": {
    "signal_strength": 8.1,
    "evidence_quality": 7.2,
    "source_independence": 6.8,
    "baseline_failure": 8.0,
    "migration_signal": 7.1,
    "payer_signal": 5.5
  },
  "supporting_claim_refs": [],
  "opposing_claim_refs": [],
  "rationale": "",
  "limitations": []
}
```

```json
{
  "disposition_id": "disposition_demand_001_lane_01",
  "candidate_ref": "artifacts/discovery/candidates/demand_001.r1.json",
  "disposition": "retained",
  "reasons": [],
  "triggered_kill_conditions": [],
  "missing_required_evidence": [],
  "judgment_assessment_refs": ["judgments/discovery/judgment-demand.json"],
  "highest_allowed_stage": "cross_lane_synthesis",
  "what_would_reverse_decision": []
}
```

`disposition_id` 在 lane result 内唯一；`disposition` 只允许 `retained | watchlist | rejected`。三个集合必须与 disposition records 精确相等且互斥。多样性保留必须用 `retention_basis=diversity | counterfactual` 显式记录，不能在没有 disposition identity 的情况下把候选塞入 retained set。

Pre-kill 规则：

- 明确反证强于支持证据，进入 `reject`。
- 没有非模型推断的支持证据，进入 `insufficient_evidence`。
- 只有痛点，没有替代方案失效或 next action，进入 `watchlist`。
- 无法识别 user/JTBD/entry scene，不能进入 cross-lane strong candidate。
- 只有能力、融资或趋势信号，没有 Demand Thesis，标记 `capability_only` 或 `trend_only`。
- 当前 baseline 已足够且没有迁移动机，进入 `reject` 或 `watchlist`。
- 证据相对弱但代表新的 user/job/scene，可以作为 diversity candidate 保留，不能给虚高分。

### 20.16 各 Lane 的领域合同

| Lane | 首选来源 | 必答问题 | 专用输出 | 主要限制/降级规则 |
| --- | --- | --- | --- | --- |
| 用户真实语言与心智定位 | UGC、评论、问答、公开访谈、论坛和搜索建议 | 用户在问题发生时原话是什么；会在什么时刻想起产品；哪些只是功能词 | `UserLanguageMap`、quotes、trigger phrases、entry scenes、mental positions | 没有 quote provenance 时不得标记真实用户语言；模型模拟只能作为 query seed |
| 受众需求痛点 | 社区讨论、支持记录、公开调查、专业论坛、行为代理数据 | 频率、损失、情绪、当前补救、是否主动寻找替代 | pain clusters、non-consumption、Demand Thesis seeds | 抱怨但没有行为或损失信号时降级；不得从内容热度直接推断付费 |
| JTBD 与任务流 | 公开流程、how-to、访谈、操作手册、案例和用户叙述 | 任务位于哪一步；输入输出、异常、协作、错误成本和状态依赖是什么 | workflow map、task operating profile、software leverage points | 无法定位 task step 或 outcome 时不能形成强 Demand Thesis |
| Top 产品与覆盖缺口 | App Store/Google Play、产品文档、价格页、榜单和第三方数据库 | 头部产品占领什么位置；核心用户、定位、价格和覆盖缺口是什么 | product landscape、coverage map、positioning occupancy | 排名/下载量不能单独证明需求或机会；地区和时间不匹配时降级 |
| 评论与差评 | 应用商店评论、社区评价、支持论坛和迁移叙述 | 哪些失败反复出现；用户怎么描述；失败后做什么 | review themes、failure evidence、abandonment/migration signals | 记录 sample size、选择偏差和重复样本；负面评论比例不等于总体比例 |
| 搜索需求与内容缺口 | 搜索建议、趋势、问答、教程和问题型内容 | 用户主动寻找什么；是信息需求、工具需求还是交易需求 | query clusters、unresolved questions、content/tool gap | 搜索热度只是 proxy；没有行为/买单交叉证据时不能进入强推荐 |
| 趋势变化 | 官方政策、人口/消费数据、平台变化、技术发布和成本变化 | 什么外部变化改变了可行性、需求或分发；窗口持续多久 | why-now claims、change manifest、freshness policy | 模型发布、融资和媒体热度不能单独生成机会 |
| 替代方案与非 App 竞争 | 人工服务、表格、微信群、纸质流程、平台内置、通用模型和不处理 | 用户为什么继续使用 baseline；成本、惯性、切换门槛和失败模式是什么 | `BaselineOption`、substitute landscape、switching cost | 只研究同类 App 会低估真实竞争；必须包含 status quo/non-consumption |
| 现有解法失效 | 用户叙述、差评、迁移案例、服务流程和社区求助 | 在什么场景失效；为什么失效；next action 和迁移动机是什么 | `SolutionFailureMap`、failure scenes、next actions | 只有功能缺失、没有失败后行动时不能推断迁移 |
| AI 能力证据 | 官方文档、独立 benchmark、可复现实测、平台能力和开源实现 | 相对通用模型/platform/open source 的 gap；可靠性、数据、人工和商品化边界是什么 | capability evidence、baseline manifest、AI gate inputs | 厂商 claim 不替代目标任务评测；不能实测时标记 `desk_research_only` |
| 买单、商业化、获客与业务闭环 | 定价、公开交易/承诺信号、渠道案例、购买流程、社区和竞品商业模式 | 谁付款、预算来源、purchase trigger、触达、留存/复购、毛利与服务负担、可触达 beachhead 和增长回路是什么 | `BuyerPurchaseLanguage`、`BusinessEngineThesis`、marketing bridge、acquisition hypotheses | “愿意使用”不等于“愿意购买”；使用者与付款者分离时分别判断；缺少非公开经营数据时使用区间和 unknown |
| 反证 | 强替代产品、反面行为数据、法规、失败案例、平台路线图和专家异议 | 什么最可能推翻 demand、solution、distribution 或 timing；是否存在 generation/evaluation 自证 | opposing matrix、kill conditions、assessment challenges、source-overlap judgment | 不能只重复正向 query 加否定词；必须寻找独立、最强的替代解释 |

所有 lane 都必须记录 geo、language、time range、source bias、independence、limitations 和 freshness。

### 20.17 AI/Hybrid Profile 对需求 Lane 的约束

`ai_first` 和 `hybrid` 可以提高 AI workaround、近期 task feasibility、自动化边界和新模态的研究优先级，但需求 lane 的补充要求仍按原业务问题展开：

| 需求 Lane | AI/Hybrid 补充要求 |
| --- | --- |
| 用户语言 | 用户主动提到 AI 只作为 workaround 或 expectation；继续寻找任务语言和失败表达 |
| 受众痛点 | 补充频率、工作量、等待时间、人工成本、错误损失和当前放弃率 |
| JTBD 与任务流 | 拆到具体 task step，记录模态、上下文、异常分支、审核节点和 outcome metric |
| Top 产品 | 同时覆盖消费者产品、通用模型、平台原生能力、开源方案和人工服务 |
| 评论与差评 | 识别准确性、幻觉、延迟、上下文丢失、不可控、无法集成和审核负担 |
| 搜索需求 | 区分一次性答案需求、持续 workflow 需求和用户使用通用 AI 自助的行为 |
| 趋势变化 | 需求侧只研究行为、预算、平台和监管变化；模型能力变化进入方案证据 |
| 替代方案 | 强制包含通用模型、Prompt、自动化工具、模板、人工服务和平台原生功能 |
| 解法失效 | 区分传统方案失败、现有 AI 方案失败和 non-consumption，并定位具体 task step |

但需求 lane 仍不得把 `AI + 行业` 直接写成 Demand Thesis。AI signal 先形成 query seed 或 Capability Evidence，再由 Solution Hypothesis 与 solution-neutral Demand Thesis 对接。

## 21. 领域模块合同

模块表示稳定的业务职责，可以由主 Agent、subagent、Skill reference 或确定性脚本实现，不要求对应独立进程或通用 workflow node。

| 模块 | 输入 | 输出 | 核心约束 |
| --- | --- | --- | --- |
| Decision Context Framer | intake、用户决策问题和初始判断 | `DecisionContext` | 明确本 Run 要回答的决定；不把外部验证变成系统 action |
| Scope Framer | intake、用户约束和附件 refs | `ScopeFrame`、assumptions、open questions | 只澄清高影响缺口；mode 创建后不可静默改变 |
| Research Planner | DecisionContext、ScopeFrame、mode policy | `ResearchPlan` | 只能使用 allowlisted lane/unit；包含 seed-independent、counterfactual、source separation、retention 和 stop policy |
| Seed Probe | scope、plan | `SeedProbe` | Seed 只扩大入口，不直接进入评分或成为先验真值 |
| Opportunity Space Mapper | scope、seed、初始 evidence | `OpportunitySpaceMap` | 先描述用户、任务、baseline 和 friction，不生成正式机会 |
| Solution Space Mapper | scope、opportunity map、capability seeds | `SolutionSpaceMap` | 同时包含 ordinary software、platform、human、AI 和 status quo |
| Pre-thesis Candidate Publisher | validated G2.1 maps、scope、current plan | `DiscoveryCandidate` revisions | 主 Agent 只物化 exact map fragment 与 pre-thesis subject；不得发布正式 Demand/Baseline/Solution |
| User Language Miner | lane plan、evidence refs | `UserLanguageMap` | quote 必须保留来源；功能词和营销词单独标记 |
| Solution Failure Mapper | lane plan、evidence refs、baseline refs | `SolutionFailureMap` | 区分功能缺失、真实失败、放弃和迁移动机 |
| Discovery Lane | ResearchTask v2、scope、maps、typed candidate refs | `DiscoveryLaneResult` | lane-researcher 只写 assigned lane path；支持/反对、pre-kill、多样性和 limitations 必填 |
| Solution Hypothesis Evaluator | demands、solutions、baselines、capability evidence | `SolutionEvaluation` | 同一需求下显式比较；AI 不是默认 selected solution |
| Opportunity Thesis Synthesizer | validated fan-in、G2.3 candidate conversions、solution evaluation | `OpportunityThesis[]` | G2.3 独占正式 Demand/Baseline/Solution 与 thesis；必须回连 source candidate revision/hash 和审计引用 |
| Thesis Snapshot Publisher | synthesized thesis、关键假设、kill criteria、generation sources | `ThesisEvaluationSnapshot` | enrichment 前不可变发布；后续变化产生 revision，不静默改写 thesis |
| Opportunity Clusterer | theses、semantic features | `MergeResult` | 按 user/job/scene/baseline/solution 判断合并，不只看标题相似度 |
| Judgment Enricher | merged opportunities、evidence gaps | enrichment plan/results | 只补充会影响决策的市场、买单、获客、风险和反证 |
| Business Engine Enricher | opportunity refs、buyer/acquisition evidence | `BusinessEngineThesis` | 所有候选适用；使用区间和 unknown，不以宽泛 TAM 替代可触达市场 |
| AI Capability Benchmarker | AI solution refs、target task、baseline candidates | `AICapabilityBenchmark` | 优先可复现实测；无法实测时 `desk_research_only` |
| Value/Context/Buyer Enricher | opportunity refs、evidence | value、state/context、buyer language artifacts | workflow/outcome、授权状态和购买语言必须分别判断 |
| Opportunity Comparator | enriched opportunities、decision/comparison policy | `OpportunityComparison` | 先 hard gate；按四个独立面板比较；unknown 不补默认高分；默认不输出全局总分 |
| Sensitivity Analyzer | comparison inputs、扰动规则 | `Sensitivity` | 输出 downside/upside relation、可能的 rank group、stability band 和敏感维度 |
| Decision Recommendation Builder | comparison、sensitivity、portfolio inputs | `DecisionRecommendation` | 允许 partial order；说明 what would change decision |
| Validation Suggestion Builder | recommendation/assessment、critical unknowns | `ValidationSuggestions` | 只建议，不执行或追踪；每条建议对应决定性假设并声明 execution owner |
| Reporter | curated judgment context、report contract | JSON + decision brief + full report | 不直接消费 raw evidence；三者一致，简报是默认用户入口 |

### 21.1 Seed Probe

```text
audience_seeds
scenario_seeds
problem_seeds
keyword_seeds
product_seeds
source_seeds
capability_seeds
model_ecosystem_seeds
seed_evidence_refs
limitations
```

### 21.2 Opportunity Space Map

```text
user_roles
buyer_roles
payer_roles
decision_makers
jobs_to_be_done
workflow_maps
task_operating_profiles
current_alternatives
baseline_options
workaround_patterns
workflow_friction_points
software_leverage_points
state_context_opportunities
buyer_purchase_language_hypotheses
initial_demand_hypotheses
disconfirming_questions
audit_refs
limitations
```

### 21.3 Solution Space Map

```text
delivery_form_candidates
ordinary_software_solutions
platform_solutions
human_or_service_assisted_solutions
ai_assisted_solutions
capability_frontier
capability_evidence
newly_feasible_tasks
quality_reliability_boundaries
failure_modes
deployment_constraints
human_in_the_loop_boundaries
data_and_evaluation_requirements
provider_open_source_platform_landscape
capability_half_life
disconfirming_questions
source_manifest_ref
audit_refs
limitations
```

### 21.4 Solution Evaluation

```text
selected_solutions
alternative_solutions
baseline_comparisons
rejected_solutions
solution_rationale
critical_unknowns
capability_only_signals
audit_refs
limitations
```

### 21.5 Merge Result

```text
merged_opportunities
source_thesis_refs
merge_or_split_decisions
preserved_variants
candidate_diversity_after_merge
conflicts
audit_refs
limitations
```

### 21.6 Thesis Evaluation Snapshot

在 enrichment 和独立评估开始前写入不可变 snapshot：

```text
snapshot_id
subject_refs
demand_thesis_refs
solution_hypothesis_refs
baseline_option_refs
business_model_assumptions
critical_assumptions
kill_criteria
generation_source_groups
evaluation_questions
frozen_at
revision_policy
limitations
```

后续证据可以支持、反对或要求产生新 revision，但不能静默改写原 thesis 来规避反证。

### 21.7 Validation Suggestion

```text
critical_assumption
suggested_action
target_participants_or_data
success_signal
failure_signal
effort_band
decision_affected
evidence_gap_refs
execution_owner
execution_supported
result_tracking_supported
limitations
```

建议可以是访谈、自然复述测试、价格承诺、落地页、人工流程演示或 AI baseline spike，但本系统不执行或追踪这些动作。外部动作固定声明：

```text
execution_owner = user
execution_supported = false
result_tracking_supported = false
```

`effort_band` 使用 `low | medium | high`，只表示验证动作在时间、协调、开发、招募、数据和合规方面的相对复杂度。它不是金额、人数或资源配置估算，也不表示该建议适配用户实际预算。首版不因用户未提供预算而推断其可承担的验证动作；报告必须把这一点作为适用边界，而不是自动改写建议。

## 22. 领域数据模型

G2.2 不发布本节 22.1-22.3 的正式对象。它只发布 `discovery_candidate.v1`，其 `candidate_kind` 分别为 `demand_seed`、`baseline_seed` 或 `solution_seed`，并保留 `pre_thesis_unvalidated`、exact G2.1 map fragment lineage 和 typed Evidence/Judgment refs。G2.3 conversion 必须从 fan-in 中 retained 的 current candidate revision 生成新 path；旧 candidate 永久不可变，conversion 不构成 Evidence、外部验证或 validation success。

### 22.1 Demand Thesis

Demand Thesis 必须 solution-neutral：

该 schema 的发布与 synthesis ownership 属于 G2.3。`demand_seed` candidate 即使 solution-neutral 且包含完整 subject 字段，也不能在 G2.2 被称为 Demand Thesis。

```json
{
  "schema_version": "startup_opportunity.demand_thesis.v1",
  "demand_id": "demand_001",
  "user": ["目标使用者"],
  "buyer": ["目标购买者"],
  "payer": ["实际付费者"],
  "decision_maker": ["购买决策者"],
  "job_to_be_done": "用户需要完成的任务",
  "workflow_step": "任务发生的具体步骤",
  "trigger_phrase": "用户自然语言",
  "entry_scene": "产品被想起的具体时刻",
  "current_alternatives": ["人工", "现有 App", "通用 AI", "不处理"],
  "current_ai_workarounds": [],
  "failure_and_loss": "现有方案失败造成的损失",
  "task_operating_profile": {
    "frequency": "daily",
    "volume": "high",
    "input_modality": ["text", "image"],
    "output_modality": ["structured_decision"],
    "task_variability": "medium",
    "exception_rate": "unknown",
    "context_fragmentation": "high",
    "judgment_intensity": "high"
  },
  "execution_constraints": {
    "latency_tolerance": "minutes",
    "quality_threshold": "unknown",
    "error_cost": "medium",
    "auditability_requirement": "high",
    "human_review_tolerance": "medium",
    "privacy_security_constraints": []
  },
  "data_conditions": {
    "existing_digital_trace": true,
    "context_sources": [],
    "possible_ground_truth": [],
    "feedback_frequency": "unknown"
  },
  "outcome_metrics": [],
  "supporting_claim_refs": [],
  "opposing_claim_refs": [],
  "kill_conditions": [],
  "limitations": []
}
```

### 22.2 Baseline Option

Baseline Option 是正式对照项，不参加机会 TopN：

该 schema 的发布 ownership 属于 G2.3。`baseline_seed` candidate 必须引用同 Run 的 `demand_seed` candidate，但在 conversion 前仍不是正式 Baseline Option。

```json
{
  "schema_version": "startup_opportunity.baseline_option.v1",
  "baseline_id": "baseline_001",
  "demand_id": "demand_001",
  "current_workflow": "电话、微信和备忘录组合",
  "current_cost": "反复沟通时间和遗漏风险",
  "current_failure_modes": [],
  "switching_cost": "建立新记录习惯",
  "why_users_continue": "可获得、免费、学习成本低",
  "minimum_incremental_value_required": "必须明显降低沟通或遗漏风险",
  "audit_refs": [],
  "limitations": []
}
```

### 22.3 Solution Hypothesis

同一个 Demand Thesis 可以有多个候选方案：

该 schema 的发布 ownership 属于 G2.3。`solution_seed` candidate 必须同时引用 typed demand/baseline candidate；G2.2 不得因 map option、AI capability 或 lane score 提前创建正式 Solution Hypothesis。

```json
{
  "schema_version": "startup_opportunity.solution_hypothesis.v1",
  "solution_id": "solution_001",
  "demand_id": "demand_001",
  "baseline_id": "baseline_001",
  "selected": false,
  "delivery_form": "mini_program",
  "solution_type": "consumer_workflow",
  "uses_ai": false,
  "solution_behavior": "把提醒、确认和异常补救串成持续闭环",
  "workflow_change": "从单次提醒变为多人可追踪协同",
  "required_capabilities": [],
  "capability_evidence_refs": [],
  "incremental_value_over_baseline": "异步确认、状态同步和异常补救",
  "market_motion": "consumer",
  "acquisition_motion": "community",
  "buyer_model": "household_payer",
  "payment_mode": "subscription",
  "business_engine_ref": "business_engine_001",
  "expected_outcomes": [],
  "risks": [],
  "kill_criteria": [],
  "supporting_claim_refs": [],
  "opposing_claim_refs": [],
  "limitations": []
}
```

候选交付形态至少比较：

```text
native_app
mini_program
mobile_web
PWA
hybrid_app
service_assisted
platform_native
```

原生 App 不是默认优胜者。入口频率、分享、安装成本、通知、离线能力、数据权限和验证速度共同决定交付形态。

### 22.4 Capability Evidence

```text
capability_id
capability_name
applicable_solution_refs
newly_feasible_tasks
supported_modalities
generic_model_prompt_tool_baseline
platform_native_baseline
open_source_baseline
quality_reliability_boundary
latency_boundary
failure_modes
deployment_constraints
human_in_the_loop_boundary
data_and_evaluation_requirements
provider_and_open_source_landscape
provider_portability
platform_bundle_risk
capability_half_life
baseline_gap
evidence_tier
audit_refs
limitations
```

Capability Evidence 不能独立成为 Opportunity Thesis。

### 22.5 User Language Map

```json
{
  "schema_version": "startup_opportunity.user_language_map.v1",
  "user_language_samples": [
    {
      "sample_id": "user_language_001",
      "verbatim_text": "我不在家，没法确认老人有没有按时吃药。",
      "speaker_context": "异地子女",
      "entry_scene": "每日用药确认",
      "evidence_ref": "ev_001",
      "quote_location": "paragraph:3",
      "language": "zh-CN",
      "geo": "CN",
      "confidence_band": "medium"
    }
  ],
  "natural_expressions": [],
  "trigger_phrases": [],
  "rejected_function_terms": [],
  "mental_model_clusters": [],
  "candidate_mental_positions": [],
  "entry_scene_candidates": [],
  "frequency_signals": [],
  "emotion_intensity_signals": [],
  "source_manifest_ref": "",
  "audit_refs": [],
  "limitations": []
}
```

`verbatim_text` 不允许由模型润色。翻译文本必须与原文分字段保存。

### 22.6 Solution Failure Map

```json
{
  "schema_version": "startup_opportunity.solution_failure_map.v1",
  "current_solutions": [],
  "current_ai_workarounds": [],
  "solution_failure_scenes": [],
  "failure_modes": [],
  "current_ai_failure_modes": [],
  "non_consumption_cases": [],
  "abandonment_reasons": [],
  "user_language_refs": [],
  "next_actions_after_failure": [],
  "migration_intent_signals": [],
  "current_solution_inertia": [],
  "opportunity_entry_candidates": [],
  "source_manifest_ref": "",
  "audit_refs": [],
  "limitations": []
}
```

### 22.7 Opportunity Thesis

```json
{
  "schema_version": "startup_opportunity.opportunity_thesis.v1",
  "opportunity_id": "opportunity_001",
  "title": "面向异地子女的老人用药家庭协同",
  "description": "帮助异地家庭持续确认用药、复诊和异常补救。",
  "opportunity_thesis": "异地子女需要低成本确认老人慢病照护执行情况；当前电话和微信不能形成可追踪闭环。",
  "discovery_profile": "industry_first",
  "research_axes": ["user_language", "industry_demand", "buyer_market"],
  "demand_thesis_ref": "demand_001",
  "selected_solution_ref": "solution_001",
  "alternative_solution_refs": [],
  "baseline_option_ref": "baseline_001",
  "selected_delivery_form": "mini_program",
  "incremental_value_over_baseline": "异步确认、异常补救和长期记录",
  "mental_positioning": "远程确认老人是否真的按时用药",
  "mental_position_occupation": {
    "status": "partially_occupied",
    "occupied_by": ["电话/微信", "通用用药提醒 App"],
    "white_space": "家庭异步确认、异常补救和长期交接尚未被稳定占领",
    "evidence_refs": []
  },
  "trigger_phrase": "我不在身边，不知道老人到底有没有按时吃药",
  "entry_scene": "异地子女每日确认老人用药或复诊执行时",
  "user_language_sample_refs": ["user_language_001"],
  "solution_failure_scene": "电话和微信无法形成可追踪的持续确认",
  "next_action_after_failure": ["反复打电话", "请其他家人确认"],
  "target_users": [],
  "primary_scenarios": [],
  "job_to_be_done": "",
  "pain_points": [],
  "current_alternatives": [],
  "alternative_gap": "",
  "buyer": [],
  "payer": [],
  "decision_maker": [],
  "budget_source": "家庭健康管理支出",
  "purchase_trigger": "漏服或复诊延误风险",
  "market_motion": "consumer",
  "acquisition_motion": "community",
  "buyer_model": "household_payer",
  "payment_mode": "subscription",
  "buyer_purchase_language": [],
  "marketing_bridge": {
    "user_trigger_phrase": "",
    "buyer_purchase_phrase": "",
    "decision_criteria": []
  },
  "beachhead_segment": "",
  "entry_wedge": "",
  "why_now": "",
  "initial_distribution_channels": [],
  "expansion_path": [],
  "value_layer": {
    "primary": "workflow_outcome",
    "output_value": "",
    "workflow_value": "",
    "outcome_metrics": []
  },
  "user_state_context_model": {
    "state_variables": [],
    "context_sources": [],
    "state_update_triggers": [],
    "feedback_or_ground_truth": [],
    "retention_boundary": "",
    "privacy_permission_boundary": "",
    "deletion_export_boundary": ""
  },
  "natural_restatement_test": {
    "status": "not_tested",
    "test_prompt": "",
    "target_user": "",
    "expected_restatement": "",
    "success_signal": "",
    "failure_signal": "",
    "evidence_refs": [],
    "limitations": []
  },
  "defensibility_hypothesis": "",
  "capability_commoditization_risk": {
    "risk_level": "medium",
    "risk_reason": "",
    "mitigation": []
  },
  "source_lanes": [],
  "supporting_insight_refs": [],
  "opposing_claim_refs": [],
  "judgment_assessment_refs": [],
  "audit_refs": [],
  "risks": [],
  "kill_criteria": [],
  "comparison_ref": null,
  "decision_recommendation_ref": null,
  "validation_suggestion_refs": [],
  "lifecycle_status": "proposed",
  "valid_as_of": "2026-07-23",
  "freshness_policy": "revalidate_when_decisive_evidence_expires",
  "limitations": []
}
```

### 22.8 AI Solution Profile

`uses_ai=true` 的 selected solution 额外要求：

```text
required_ai_capabilities
newly_feasible_job
baseline_run_manifest or desk_research_only
capability_delta
technical_reliability
evaluation_feasibility
evaluation_dataset_and_metrics
quality_reliability_threshold
data_readiness
human_in_the_loop_boundary
human_review_dependency
failure_cost_and_recovery
data_access_and_rights
evaluation_and_monitoring_boundary
provider_dependency_and_portability
provider_portability
platform_bundle_risk
open_source_substitution_risk
product_inference_unit_economics
data_feedback_moat
capability_half_life
ai_adoption_trust
defensibility_beyond_model_access
```

#### Baseline Run Manifest

```text
target_task
provider
model_id
model_version
prompt_version
tool_setup
retrieval_setup
evaluation_dataset_ref
sample_distribution
metrics
repetitions
success_results
failure_cases
variance
latency_observations
model_and_tool_cost_observations
human_review_time_and_cost
tested_at
valid_as_of
reproducibility
desk_research_only
limitations
```

#### AI Evaluation Reliability

```text
target_task_distribution
quality_threshold
success_rate_or_band
variance
critical_failure_types
error_detection_coverage
fallback_and_recovery
human_review_boundary
monitoring_signals
ground_truth_availability
responsibility_boundary
evidence_refs
limitations
```

#### Product Inference Unit Economics

```text
unit_of_work
model_cost_per_unit
retrieval_cost_per_unit
tool_cost_per_unit
storage_cost_per_unit
human_review_cost_per_unit
exception_and_support_cost_per_unit
total_variable_cost_band
target_price_or_revenue_per_unit
gross_margin_band
volume_and_failure_sensitivity
valid_as_of
evidence_refs
limitations
```

#### AI Data Dependency

```text
required_data
data_sources
access_rights
user_consent
update_frequency
ground_truth_or_feedback
quality_and_coverage
privacy_and_retention
revocation_deletion_export
provider_portability
single_source_dependency
evidence_refs
limitations
```

#### Capability Commoditization Risk

```text
model_upgrade_substitution_risk
platform_bundle_risk
open_source_substitution_risk
api_price_change_exposure
provider_lock_in
capability_half_life
workflow_or_distribution_mitigation
data_feedback_mitigation
outcome_responsibility_mitigation
evidence_refs
limitations
```

这里的 unit economics 是候选产品本身的商业判断，不是 Research Harness 的 Agent token/cost 预算统计。

无法进行代表性实测时必须标记 `desk_research_only`，不得用厂商 benchmark 替代目标任务可靠性判断。

### 22.9 Concept Hypothesis 与 Evidence Assessment

```json
{
  "schema_version": "startup_opportunity.concept_hypothesis.v1",
  "concept_hypothesis_id": "concept_001",
  "product_thesis": "",
  "target_user": [],
  "buyer": [],
  "entry_scene": "",
  "claimed_value": "",
  "current_alternative": [],
  "delivery_form": "",
  "business_model": "",
  "acquisition_hypothesis": "",
  "uses_ai": false,
  "assumptions": [],
  "unknowns": [],
  "kill_criteria": []
}
```

```json
{
  "schema_version": "startup_opportunity.concept_evidence_assessment.v1",
  "concept_hypothesis_id": "concept_001",
  "assessment_result": "investigate_further",
  "evidence_strength_band": "medium",
  "dimension_decisions": [],
  "business_engine_ref": "business_engine_001",
  "decisive_evidence_refs": [],
  "decisive_opposing_refs": [],
  "critical_gaps": [],
  "conditions": [],
  "kill_criteria": [],
  "recommendation": "",
  "belief_update_summary": {
    "initial_belief": "unknown",
    "evidence_that_changed_belief": [],
    "unchanged_assumptions": [],
    "remaining_disagreement": [],
    "final_decision_owner": "user"
  },
  "validation_suggestions": [],
  "limitations": []
}
```

### 22.10 Buyer Purchase Language

```text
user_trigger_phrase
buyer_purchase_phrase
user
buyer
payer
decision_maker
budget_source
purchase_trigger
decision_criteria
price_or_cost_anchor
marketing_bridge
supporting_claim_refs
opposing_claim_refs
confidence_band
limitations
```

### 22.11 Value Layer Analysis

```text
opportunity_ref
primary_value_layer           output | workflow | outcome
output_value
workflow_value
outcome_metrics
baseline_outcome
expected_delta
measurement_feasibility
supporting_claim_refs
opposing_claim_refs
limitations
```

### 22.12 User State Context Model

```text
opportunity_ref
state_variables
context_sources
state_update_triggers
feedback_or_ground_truth
collaboration_participants
retention_boundary
privacy_permission_boundary
deletion_export_boundary
data_feedback_moat
unavailable_or_unreliable_inputs
limitations
```

### 22.13 Opportunity Lifecycle

```text
proposed -> screened -> recommended
         -> watchlist | rejected | stale
```

`stale` 表示决定性证据已经过期或市场状态发生重大变化，不表示 thesis 已被证伪。重新研究应创建 continuation Run 或新 revision，不改写历史结论。

### 22.14 Business Engine Thesis

所有进入正式比较的机会和概念都必须形成 `BusinessEngineThesis`，但缺少非公开经营数据时允许字段为 `unknown`：

```json
{
  "schema_version": "startup_opportunity.business_engine_thesis.v1",
  "business_engine_id": "business_engine_001",
  "subject_ref": "opportunity_001",
  "pricing_unit": "household_subscription",
  "usage_or_purchase_frequency": "recurring",
  "retention_or_repeat_trigger": "持续照护记录、家庭交接和异常补救",
  "gross_margin_band": "unknown",
  "service_and_support_burden": "medium",
  "cac_hypothesis": "通过慢病宠物社区和诊所推荐触达",
  "payback_logic": "unknown",
  "reachable_beachhead_market": "已有慢病管理需求且由家庭成员共同照护的宠物家庭",
  "channel_dependency": ["pet_health_community", "clinic_referral"],
  "growth_loop": "家庭协作邀请与专业渠道推荐",
  "minimum_viable_scale": "unknown",
  "assumptions": [],
  "supporting_claim_refs": [],
  "opposing_claim_refs": [],
  "judgment_assessment_refs": [],
  "unknowns": [],
  "limitations": []
}
```

该对象描述候选产品本身的商业闭环，不涉及 Research Harness 执行预算。`unknown` 不得被默认中性分替代；决定性商业闭环字段未知时限制推荐档位。

## 23. Hard Gates、比较和排序

### 23.1 Hard Gates

比较前先检查：

- 没有明确 user/JTBD/entry scene，不能进入强推荐。
- 没有 Baseline Option 或无法说明增量价值，进入 `watchlist` 或 `reject`。
- buyer、payer、purchase trigger 和获取路径均无法说明，不能进入强推荐。
- 缺少 `BusinessEngineThesis`，或定价单位、留存/复购触发、可触达 beachhead 和服务负担均无法形成合理假设，不能进入强推荐。
- supporting evidence 主要来自模型推断或单一非独立来源，不能进入强推荐。
- 候选生成与评估来源高度重叠且没有独立 challenger evidence 时，限制 evidence strength 和推荐档位。
- opposing evidence 已经推翻核心需求或迁移动机，进入 `reject`。
- 高风险行业缺少可接受合规边界，限制推荐档位或拒绝。
- `uses_ai=true` 但缺少 mandatory AI bundle，进入 `insufficient_evidence`。Evaluator 必须沿 `OpportunityThesis.selected_solution_ref -> SolutionHypothesis.uses_ai` 解析 exact selected solution；不能只信 caller 填写的 gate status。G2 不生成 G3 bundle，缺失时 `ai_mandatory_bundle` 不得写成 `passed` 或 `not_applicable`，opportunity conclusion 与 `decision_tier` 均不得高于 `investigate_further`。
- 通用模型、平台或开源 baseline 已充分解决核心任务，且没有 workflow、data、distribution 或 outcome 差异，进入 `watchlist` 或 `reject`。
- AI 高错误成本任务缺少评测、异常检测、人工兜底或责任边界，不能进入强推荐。
- 关键数据无法合法持续获取，不能把数据壁垒计入正向判断。
- 候选产品的推理、工具、存储和人工审核后单位经济明显不成立，触发 kill condition。

### 23.2 比较面板与观察维度

候选默认通过四个相互区分的面板比较，不把所有维度压缩成一个面向用户的全局总分：

| 面板 | 主要观察维度 | 输出作用 |
| --- | --- | --- |
| `demand_and_market` | demand strength、用户语言、入口场景、解法失效、心智 white space、可触达 beachhead、timing | 判断问题和市场入口是否值得关注 |
| `solution_and_business` | baseline delta、workflow/outcome value、差异化、payer/buyer language、定价单位、留存/复购、获客、服务负担、渠道、合规和替代风险 | 判断方案及业务闭环是否成立 |
| `evidence_strength` | 来源等级、独立性、代表性、覆盖、freshness、generation/evaluation overlap 和 opposing evidence | 限制结论强度和不确定性，不给机会吸引力加分 |
| `team_fit_and_learning` | 已声明能力、founder advantage、entry version feasibility、关键未知数可研究性和 speed-to-learn | 判断用户优先关注该机会是否合理，不改变市场事实 |

每个面板输出 `strong | medium | weak | unknown | not_applicable`、observable anchors、support/opposition refs 和 limitations。需求强度、用户语言、入口场景和解法失效等相关维度不能简单线性累加。

Comparison policy 可以在内部使用版本化 rubric 辅助一致比较，但必须满足：

- 每个 band 有可观察的 anchor 和反例。
- `evidence_strength` 只控制区间宽度、decision sufficiency 和推荐上限，不进入 opportunity attractiveness 加权和。
- `unknown` 不填默认中性值。
- `AI baseline gap` 对非 AI 方案为 `not_applicable`，不造成奖励或惩罚。
- 用户和 Agent 不能在 active Run 中修改单项面板的重要性；`DecisionContext` 只能选择已发布的 decision/comparison profile。
- 面向用户的 brief/report 不展示 `global_score`、伪精确置信分或小数点排名稳定性。

AI 方案的以下指标必须作为独立 comparison inputs，不得藏在 `differentiation` 或自然语言 rationale 中：

| AI 指标 | 决策含义 |
| --- | --- |
| `capability_delta` | 相比通用模型、平台和开源方案的真实质量、覆盖、速度或成本增量 |
| `technical_reliability` | 目标任务分布上的成功率、方差、异常率和恢复能力 |
| `evaluation_feasibility` | 是否存在代表性评测集、ground truth、重复指标和监控方法 |
| `data_readiness` | 数据是否存在、可授权、可持续更新并能形成反馈 |
| `human_review_dependency` | 人工复核比例、专业要求、时延和成本负担 |
| `product_inference_unit_economics` | 推理、检索、工具、存储、人工审核和支持后的产品毛利空间 |
| `provider_portability` | 是否可以跨 provider/model/open source 迁移 |
| `platform_bundle_risk` | 模型厂商、OS、头部 App 或平台内置替代风险 |
| `open_source_substitution_risk` | 开源能力达到可用水平后差异是否快速消失 |
| `data_feedback_moat` | 授权数据、纠错、评测和状态能否形成持续改进条件 |
| `capability_half_life` | 当前能力窗口可维持多久，模型升级是增强还是替代 |
| `ai_adoption_trust` | 安全、隐私、可解释性、责任和消费者信任是否允许进入工作流 |

### 23.3 比较顺序

```text
hard gates
  -> four comparison panels
  -> evidence sufficiency and conclusion ceiling
  -> pairwise dominance / Pareto relation
  -> downside / upside relation and speed-to-learn
  -> robust leader group or partial-order recommendation
```

没有证据的维度保持 `unknown`，不得填默认中性值。不同 discovery profile 和 venture goal 可以选择预先定义、校准和版本化的 decision/comparison profile。每次比较必须记录 policy version、observable rubric version 和输入快照。

### 23.4 输出合同

```json
{
  "opportunity_id": "opportunity_001",
  "comparison_policy_version": "1.0.0",
  "input_snapshot_ref": "artifacts/comparison/input-snapshot.json",
  "recommendation_band": "strong_candidate",
  "decision_value_band": "high",
  "uncertainty_band": "medium",
  "comparison_panels": {
    "demand_and_market": {"band": "strong", "dimension_assessments": [], "limitations": []},
    "solution_and_business": {"band": "medium", "dimension_assessments": [], "limitations": []},
    "evidence_strength": {"band": "medium", "decision_sufficiency": "sufficient", "source_overlap": "low", "limitations": []},
    "team_fit_and_learning": {"band": "medium", "reasons": [], "limitations": []}
  },
  "ordering_mode": "partial_order",
  "rank_relation": "robust_leader",
  "dominates": [],
  "dominated_by": [],
  "close_to_indistinguishable_from": [],
  "hard_gate_results": [],
  "judgment_assessment_refs": [],
  "sensitivity": {
    "most_sensitive_dimensions": [],
    "downside_relation": "falls_into_leader_group",
    "expected_relation": "robust_leader",
    "upside_relation": "robust_leader",
    "stability_band": "medium"
  },
  "recommendation": "",
  "rationale": "",
  "what_would_change_the_decision": [],
  "next_validation_suggestion": {
    "critical_assumption": "",
    "suggested_action": "",
    "success_signal": "",
    "failure_signal": "",
    "decision_affected": "",
    "effort_band": "low"
  }
}
```

候选无法形成稳定支配关系时应输出：

```text
robust_leader
close_to_indistinguishable
evidence_insufficient_for_ordering
```

### 23.5 推荐档位

| 档位 | 含义 |
| --- | --- |
| `strong_candidate` | 当前证据下需求、买单、方案、baseline 增量和业务闭环相对清晰，建议优先关注；不表示市场已经验证 |
| `investigate_further` | 有潜力但存在少数决定性桌面证据缺口或证据等级限制 |
| `watchlist` | 信号存在，但证据、时机或商业化不足 |
| `reject` | 反证、替代、风险或不可行性足以否定当前机会 |

`strong_candidate` 与 `investigate_further` 的区别来自当前证据充分性和是否仍有少量决定性未知数，不由用户预算直接决定。若机会质量高但当前团队能力不匹配，应分别表达 opportunity quality 和 team execution fit，不能用团队不匹配把市场证据降级。

### 23.6 Portfolio View

TopN 之后增加：

```text
recommended_first_bet
alternative_bets
shared_distribution_or_capabilities
resource_conflicts
risk_correlation
learning_reuse
```

Portfolio View 是轻量组合建议，不是投资组合优化器。

### 23.7 Decision Recommendation

```json
{
  "schema_version": "startup_opportunity.decision_recommendation.v1",
  "decision_context_ref": "decision-context.json",
  "recommended_first_bet": "opportunity_001",
  "alternative_bets": [],
  "rejected_or_watchlist_refs": [],
  "decision_tier": "prioritize",
  "decision_value_band": "high",
  "uncertainty_band": "medium",
  "decisive_supporting_refs": [],
  "decisive_opposing_refs": [],
  "decisive_judgment_assessment_refs": [],
  "business_engine_refs": [],
  "rationale": "",
  "critical_unknowns": [],
  "what_would_change_the_decision": [],
  "recommended_next_action": "",
  "belief_update_summary": {
    "initial_belief": "unknown",
    "evidence_that_changed_belief": [],
    "unchanged_assumptions": [],
    "remaining_disagreement": [],
    "final_decision_owner": "user"
  },
  "validation_suggestion_refs": [],
  "portfolio_view_ref": "",
  "limitations": []
}
```

`decision_tier` 使用：

```text
prioritize
investigate_further
watch
reject
insufficient_evidence
```

`decision_tier` 受 comparison、enrichment fan-in、Portfolio 和 first-bet readiness 的 closed ceiling 共同约束。`recommended_first_bet=null` 时最高为 `investigate_further`；`prioritize` 只允许 first bet 与 Portfolio exact 一致、其 comparison 为 `strong_candidate`/`eligible`、全部 hard gate 为 `passed | not_applicable`、fan-in conclusion ceiling 为 `strong_candidate`、四个 panel 均 `sufficient` 且不为 `weak | unknown`，并且 AI mandatory bundle 已完整或确实不适用。上述输入出现混合档位时采用最严格 ceiling；不能用某个 caller recommendation 字段覆盖 Evidence insufficiency。

## 24. Artifact Contract 与 Evaluator

### 24.1 Artifact catalog

```text
startup_opportunity.intake.v1
startup_opportunity.decision_context.v1
startup_opportunity.run_manifest.v1
startup_opportunity.scope_frame.v1
startup_opportunity.research_plan.v1
startup_opportunity.planning_context.v1
startup_opportunity.planning_context.v2
startup_opportunity.ai_trigger_source_attestation.v1
startup_opportunity.gap_snapshot.discovery.plan.current
startup_opportunity.gap_snapshot.discovery.readiness.current
startup_opportunity.gap_snapshot.assessment.current
startup_opportunity.adaptation_decision.discovery.current
startup_opportunity.adaptation_decision.assessment.current
startup_opportunity.coverage_attestation.v1
startup_opportunity.seed_probe.v1
startup_opportunity.opportunity_space_map.v1
startup_opportunity.solution_space_map.v1
startup_opportunity.evidence.v1
startup_opportunity.evidence.v2
startup_opportunity.evidence.v3
startup_opportunity.claim.v1
startup_opportunity.claim.v2
startup_opportunity.claim.v3
startup_opportunity.finding.v1
startup_opportunity.finding.v2
startup_opportunity.finding.v3
startup_opportunity.insight.v1
startup_opportunity.insight.v2
startup_opportunity.insight.v3
startup_opportunity.judgment_assessment.v1
startup_opportunity.judgment_assessment.v2
startup_opportunity.judgment_assessment.v3
startup_opportunity.research_task.v2
startup_opportunity.research_task.v3
startup_opportunity.source_manifest.v2
startup_opportunity.source_manifest.v3
startup_opportunity.discovery_candidate.v1
startup_opportunity.user_language_map.v1
startup_opportunity.solution_failure_map.v1
startup_opportunity.discovery_lane_result.v1
startup_opportunity.discovery_fan_in.v1
startup_opportunity.discovery_fan_in.v2
startup_opportunity.discovery_candidate_conversion.v1
startup_opportunity.discovery_candidate_conversion.v2
startup_opportunity.demand_thesis.v1
startup_opportunity.baseline_option.v1
startup_opportunity.solution_hypothesis.v1
startup_opportunity.solution_evaluation.v1
startup_opportunity.capability_evidence.v1
startup_opportunity.opportunity_thesis.v1
startup_opportunity.thesis_evaluation_snapshot.v1
startup_opportunity.merge.v1
startup_opportunity.enrichment_branch_result.v1
startup_opportunity.enrichment_fan_in.v1
startup_opportunity.ai_capability_benchmark.v1
startup_opportunity.ai_evaluation_reliability.v1
startup_opportunity.ai_inference_unit_economics.v1
startup_opportunity.ai_data_dependency.v1
startup_opportunity.capability_commoditization_risk.v1
startup_opportunity.value_layer_analysis.v1
startup_opportunity.user_state_context_model.v1
startup_opportunity.buyer_purchase_language.v1
startup_opportunity.business_engine_thesis.v1
startup_opportunity.business_engine_thesis.v2
startup_opportunity.opportunity_comparison.v1
startup_opportunity.sensitivity.v1
startup_opportunity.decision_recommendation.v1
startup_opportunity.portfolio_view.v1
startup_opportunity.adversarial_review.v1
startup_opportunity.validation_suggestions.v1
startup_opportunity.decision_brief.v1
startup_opportunity.decision_brief.v2
startup_opportunity.report.v1
startup_opportunity.discovery_report_view.v1
startup_opportunity.report_consistency_evaluation.v2
startup_opportunity.report_consistency_evaluation.v3
startup_opportunity.concept_frame.v1
startup_opportunity.concept_hypothesis.v1
startup_opportunity.concept_evidence_assessment_plan.v1
startup_opportunity.concept_evidence_assessment_branch_result.v1
startup_opportunity.concept_evidence_assessment_fan_in.v1
startup_opportunity.hypothesis_evidence_matrix.v1
startup_opportunity.concept_evidence_assessment.v1
startup_opportunity.concept_assessment_suggestions.v1
startup_opportunity.concept_evidence_report.v1
startup_opportunity.traceability.v1
startup_opportunity.traceability.v2
```

方案 A 的 current contract authority 是 `harness/schemas/current.json`、current Artifact Envelope/Document Bundle 与 `harness/policies/discovery-candidates.v1.json`。唯一 identity/path/owner 如下：

| Contract | Path / revision | producer / owner | 边界 |
| --- | --- | --- | --- |
| `discovery_candidate.v1` | `artifacts/discovery/candidates/<candidate_id>.r<n>.json`；rN exact parent=rN-1 + parent canonical hash | main Agent / G2.2 | `demand_seed | baseline_seed | solution_seed`；始终 pre-thesis/unvalidated |
| `research_task.v2` | `tasks/discovery/<unit_id>.attempt-<n>.json` | main Agent 创建；lane-researcher 执行 | 只授权一个 lane output path；Harness 不 dispatch agent |
| Evidence/Claim/Finding/Insight/Judgment/Source Manifest v2 | typed discovery paths；绑定 task attempt、candidate refs、Scope、Plan | lane-researcher / assigned lane | source/audit/freshness/representativeness/limitations 必填；chat/completion 不是 Artifact |
| `discovery_lane_result.v1` | `artifacts/discovery/lanes/<unit_id>.attempt-<n>.json` | lane-researcher / assigned lane | disposition 必须直接引用 task 中的 typed candidate revision |
| `discovery_fan_in.v2` | `artifacts/discovery/fan-in.r1.json` | main Agent / G2.2 runtime | reference-only；允许显式 candidate revision upgrade，不复制 Evidence 内容 |
| `discovery_candidate_conversion.v2` | `artifacts/discovery/conversions/<candidate_id>.r<n>.json`；rN exact parent=rN-1 + parent canonical hash | main Agent / G2.3 runtime | executable conversion；retained/current source candidate 与 formal target 双向绑定 exact ref/schema/revision/hash；不改变 source candidate，不构成 Evidence 或 validation success |
| `demand_thesis.v1` | `artifacts/discovery/demands/<demand_id>.r<n>.json` | main Agent / G2.3 | solution-neutral；必须先于其 Baseline/Solution 依赖发布 |
| `baseline_option.v1` | `artifacts/discovery/baselines/<baseline_id>.r<n>.json` | main Agent / G2.3 | 回连 typed demand 与 baseline source candidate ancestry；不参加 TopN |
| `solution_hypothesis.v1` | `artifacts/discovery/solutions/<solution_id>.r<n>.json` | main Agent / G2.3 | 回连 typed demand/baseline 与 solution source candidate ancestry；selection 由 Solution Evaluation 拥有 |
| `solution_evaluation.v1` | `artifacts/discovery/solution-evaluations/<evaluation_id>.r<n>.json` | main Agent / G2.3 | 同 Demand/Baseline 下每个 solution exact-once classified，并逐项比较 baseline |
| `opportunity_thesis.v1` | `artifacts/discovery/opportunities/<opportunity_id>.r<n>.json` | main Agent / G2.3 | exact 反映 selected solution、alternatives、baseline 和 evaluation；comparison/recommendation refs 在 G2.3 固定为 null |
| `thesis_evaluation_snapshot.v1` | `artifacts/discovery/thesis-snapshots/<snapshot_id>.r<n>.json` | main Agent / G2.3 | enrichment 前冻结 exact thesis/source-group closure；后续变化只能发布新 immutable revision |
| `merge.v1` | `artifacts/discovery/merges/<merge_id>.r<n>.json` | main Agent / G2.3 | frozen theses exact-once 分类；按 user/job/scene/baseline/solution/buyer/acquisition-compliance 语义合并，不得只看标题 |

Candidate 的 `map_lineage` 同时保存 source map ref/schema/id/revision/canonical hash、fragment ref、JSON Pointer、fragment id/status/canonical hash。Evaluator 从 bundle 中重新解析 exact fragment；标题、数组位置的隐式约定或只保存 map path 均失败。Run、Scope ref、current Plan ref、discovery profile、market 和 language 由 Scope Frame 唯一拥有，candidate 不得漂移。

每个 revision 都是 immutable Artifact。r1 只允许 `initial_materialization`；rN 只允许 `evidence_enrichment | user_correction`，必须绑定 rN-1、声明 exact changed fields，且 Evidence/Claim/Finding/Insight/Judgment/Source Manifest/audit refs 只能追加。`subject`、source partition 和 limitations 可以通过新 revision 明示修订；map identity、candidate kind、Run/Scope/profile/market/language 与 pre-thesis boundary 永远不可改写。用户 correction 仍须先按 G0.3 `decisions.jsonl` append contract 持久化并列入 basis refs。

Append-only 只是必要条件，不构成 candidate-specific binding。每个新增 Evidence/Claim/Finding/Insight/Source Manifest/Judgment ref 必须解析到 owning `research_task.v2`，且 task/lineage 都包含 exact parent candidate revision；新增 Judgment 的 `subject_ref` 还必须 exact 等于该 parent revision。面向其他 candidate 的 typed material、同 identity 的错误 revision 或未绑定 task 的 material 均 fail closed。

Generation 与 evaluation 使用不同 `research_task.v2.source_phase`、typed Evidence `research_phase_role` 和 Source Manifest group；任何 canonical source-group overlap 都必须精确披露。Candidate 或 lane 可以是 `partial`/`insufficient_evidence`，但这只降低 conclusion ceiling；`failed`、`ignored_late`、`superseded` lane result 不能进入 current candidate enrichment 或 fan-in supporting refs。

G2.3 conversion 的唯一映射是 `demand_seed -> demand_thesis.v1`、`baseline_seed -> baseline_option.v1`、`solution_seed -> solution_hypothesis.v1`。当前 Runtime 使用 `discovery_candidate_conversion.v2`：它采用 immutable revision/path/parent/hash，要求 fan-in retained/current candidate、exact source revision/hash/kind、typed lineage、installed target schema/evaluator，并与 formal target 双向绑定 exact ref/hash。转换创建新 Artifact，绝不覆盖旧 candidate，也不把转换表述成 Evidence、市场验证或 validation success。

Current Store 直接按 artifact type 和 workflow mode 发布 G2.2 candidate/lane/fan-in、G2.3 synthesis、G2.4 enrichment/evaluation/report 与 G3 AI Artifact。它使用一套 current Envelope、Document Bundle、Store receipt 和 publication policy，没有历史 adapter 或版本选择。Publication 按 task -> typed material -> branch -> fan-in -> domain -> comparison -> sensitivity -> portfolio/recommendation -> traceability -> report 的依赖顺序执行；每个 path 仍是 immutable publication，late/superseded result 只进入 ignored refs，checkpoint/reopen 使用相同 terminal classification。

`research_task.v3`、Evidence/Claim/Finding/Insight/Judgment/Source Manifest v3、enrichment branch/fan-in、Value Layer、User State、Buyer Language、Business Engine v2、Opportunity Comparison、Sensitivity、Portfolio、Decision Recommendation、Traceability v2 和 discovery report 都必须是调用方显式提供的 same-Run Artifact；Harness 不执行 enrichment research、不生成 hard-gate/panel/partial-order/portfolio 判断。每个 task 必须精确匹配 current immutable Research Plan 的 enabled unit；每个 material 必须绑定 exact owning task、frozen snapshot、semantic merge、Scope、Plan 和 target Opportunity，Evidence 还绑定 exact substrate record。

Evaluator 解析 selected Solution `uses_ai` 并强制 missing-G3 AI ceiling。Recommendation `decision_tier` 取 fan-in、comparison、hard gates、panels、Portfolio partition 与 first-bet readiness 的最严格 closed tier。`build-report` 只从 validated `report.v1` 确定性派生 Decision Brief v2、Discovery Report View 和 Consistency Evaluation v3，再以独立 current receipt materialize 三个固定 view；每个表面在 publication、checkpoint/reopen 和 recovery 中重验禁用表述、refs 与 hashes。任何 schema、Store、summary 或 report success 都不表示 Evidence 真实/充分、市场验证或商业成功。

`discovery_fan_in` 和 `concept_evidence_assessment_fan_in` 采用引用式聚合：只保存通过校验的 branch/artifact refs、必要的决策摘要、失败或缺失 branch、evidence gaps 和 limitations，不复制所有 raw evidence。引用式聚合仍必须完整保留证据充分性、反证、pre-kill 和 decision impact 语义。

Discovery fan-in 的每个 disposition Judgment 必须来自其 `supporting_lane_result_refs` 中对同一个 source candidate 的 pre-kill decision；Judgment `subject_ref` 必须 exact 命中 `source_candidate_refs` 中一个 source revision，并可沿 immutable parent lineage 到达最终 `candidate_ref`。最终 r2 因而可以合法消费 subject=r1 的 Judgment。Fan-in 顶层 `judgment_assessment_refs` 必须等于所有 disposition Judgment refs 的去重并集，既不能遗漏也不能藏入无关 Judgment。

Artifact 依赖关系：

```text
intake -> decision context -> scope -> plan r1 -> seed/maps
  -> branch/lane results + judgment assessments -> fan-in -> gap snapshot
  -> adaptation decision -> plan rN when adjustment is approved
  -> demand + baseline + solutions + solution evaluation
  -> opportunity thesis -> frozen thesis snapshot -> merge -> enrichment fan-in
  -> value/buyer/business-engine/AI artifacts -> comparison + sensitivity
  -> decision recommendation + portfolio -> report.json
  -> decision brief + full report

decision context -> concept frame -> evidence assessment plan r1
  -> assessment branch results + judgment assessments -> fan-in -> gap snapshot
  -> adaptation decision -> assessment plan rN when adjustment is approved
  -> hypothesis evidence matrix -> adversarial review -> assessment result
  -> report.json -> decision brief + concept evidence report
```

### 24.2 Evaluator 层次

#### Schema evaluator

检查字段、类型、closed enum、路径和 schema version。

#### Reference evaluator

检查 evidence/claim/finding/insight/judgment assessment/demand/solution/baseline refs 存在且关系方向正确。

#### Pre-thesis Candidate contract evaluator

检查 exact map fragment/ref/hash/revision、same-Run Scope/Plan/profile/market/language、candidate path/parent/hash/append-only enrichment、每个新增 material 对 exact source candidate revision 的 task binding、producer ownership、typed discovery Evidence chain、generation/evaluation separation、lane disposition Judgment subject/task binding、fan-in Judgment source/ancestor/closure、disposition identity/exclusivity、reference-only fan-in、terminal lane exclusion和 G2.3 conversion lineage。该 evaluator 不执行 research；current Store publication 只按已验证 artifact type 和 terminal status 执行机械 Manifest transition。

#### Discovery synthesis contract evaluator

检查 executable conversion 与 retained/current candidate 的 exact kind/revision/hash、conversion/target 双向 ref/hash、Demand solution-neutrality、Baseline/Solution candidate subject ancestry、每项 formal typed material 的 source-candidate/task binding、generation/evaluation Source Manifest role 与 overlap disclosure、Solution Evaluation exact classification、Opportunity selection lineage、pre-enrichment snapshot closure、created-at/publication dependency order和 semantic merge exact-once closure。Formal Solution 的 `uses_ai`、solution class 与 delivery form 必须精确继承 typed source candidate。该 evaluator 只验证调用方显式 Artifact 并执行 immutable publication/reopen/recovery；它不生成 thesis、判断 Evidence 真实性/充分性、声明 promotion 等于 validation，或开放 G2.4 comparison/report。

#### Discovery evaluation contract evaluator

检查 enrichment task 与 current enabled Plan unit exact tuple、frozen Snapshot/Merge/Scope/Plan/opportunity closure、typed material owning-task 与 Evidence substrate exact binding、typed material graph、branch output/status、eligible/excluded fan-in 与 material/hard-gate closure、每个 Judgment 的 opportunity subject、Business Engine/domain subject、全部 hard gates和四个独立 panel、Evidence conclusion ceiling、Sensitivity unordered-pair/scenario closure、Portfolio exclusive partition、Recommendation、Traceability freshness/input hashes，以及 report/brief/view/consistency exact closure。Evaluator 沿 selected Solution 解析 `uses_ai` 并强制 missing-G3 ceiling，以 fan-in、comparison、hard gates、panels、Portfolio 和 first-bet readiness 的最严格 closed tier 限制 `decision_tier`，并独立扫描 structured report 和两个 rendered views。它只验证显式 Artifact、执行 current immutable publication/reopen/recovery 和确定性 view materialization；不执行 research、不生成 Judgment/排名/推荐语义、不访问网络或执行 external validation。

#### Research quality evaluator

检查 supporting/opposing evidence、judgment signal、来源独立性、representativeness、sample bias、freshness、decision sufficiency、limitations 和 abstention。

#### Decision readiness evaluator

检查 hard gate、buyer、baseline delta、selected solution、Business Engine、evidence conclusion ceiling、kill criteria、AI mandatory bundle 和推荐档位上限。

#### Adaptation policy evaluator

检查 Gap Snapshot 的数据依据和 decision impact、Adaptation Decision 的 closed action 和状态前置条件、follow-up 上限、plan lineage、幂等键、scope/mode 边界、mandatory coverage 以及被取消、跳过或 supersede unit 的下游影响。`candidate_pre_killed -> skip_unit` 还必须按 current Discovery binding 核对 exact typed candidate Envelope/path/type/Run/Plan/content+Envelope hash、pending/enabled target 与 candidate-shaped input closure；apply/write、receipt replay、crash、checkpoint/reopen 与 recovery 都必须重验 durable binding，共享候选 unit 只能保留或 supersede。

#### Report evaluator

检查 report.json、decision-brief.md 和 report.md 一致性、引用覆盖、限制披露、partial-order 解释和是否错误表达为确定性商业结论或真实市场验证结论。三个 surface 是独立正式 publication boundary，必须先扫描再创建 receipt/文件；Consistency v3 在 checkpoint/reopen/recovery 重算三个 surface 的 deterministic scan。caller 不能提交空 matches 或固定 `passed` 来覆盖 validation-success、probability 或 global-score 命中。

### 24.3 关键 Artifact 专用校验

| Artifact | 必须校验 |
| --- | --- |
| Decision Context | decision_to_make、decision question、venture goal、初始判断、最终决策所有者和 assumptions |
| Scope Frame | mode、market/language、profile、约束、assumptions 和高影响 open questions |
| Research Plan | revision/parent/adaptation lineage、allowlist、依赖无环、output ownership、seed-independent/counterfactual unit、generation/evaluation source separation、frozen-thesis boundary、retention/diversity 和 stop policy |
| Planning Context | immutable revision、Run/Plan identity/ref/hash/revision、validation stage、AI mandatory trigger、显式 source attestation ref/schema/canonical hash、subject/trigger/context revision exact binding 和 stale rejection |
| Gap Snapshot | base plan、observed artifact refs、closed gap type、detection mode、trigger data、decision impact、severity、basis/evidence refs 和 stop signals |
| Adaptation Decision | current Run mode 对应的 Discovery/Assessment identity、base plan、gap refs、closed action、目标 unit/state、decision impact、success/stop condition、coverage/retry strengthening、policy boundary、幂等和 revision applicability |
| Coverage Attestation | exact relation、canonical coverage_key、Run/Plan/gap/unit refs、subject、target research goal、pending/active state、plan lineage 和 stale conditions；语义等价由 main Agent 声明 |
| User Language Map | verbatim quote、source location、geo/language、功能词剔除和 quote provenance |
| Solution Failure Map | baseline、failure scene、next action、migration signal 和用户语言引用 |
| Judgment Assessment | signal、support/opposition refs、evidence tier、representativeness、independence、decision sufficiency、insufficiency reason、what-would-change-it，以及 G2.2 task lineage 与 exact candidate subject |
| Pre-thesis Discovery Candidate | kind/subject boundary、exact map fragment、Scope/Plan/profile/locale、immutable path/revision/parent/hash、append-only typed refs、每个新增 material 的 exact parent-candidate task binding、source partition、unvalidated flags 和 limitations |
| Discovery Research Task | assigned candidates、attempt/supersedes、source phase/groups、唯一 lane output、no hidden dispatch/LLM/network 和 completion non-authority |
| Discovery Lane Result | subject/task-bound judgment refs、支持/反对、领域对象 refs、pre-kill、rejected/watchlist/retained candidates、decision sufficiency、diversity summary、open questions 和 limitations |
| Discovery Fan-in | terminal lane exact classification、eligible/excluded refs、candidate revision lineage、per-disposition Judgment source/ancestor binding、顶层 Judgment exact closure、exclusive disposition sets、diversity retention、reference-only 和 no Manifest transition |
| Candidate Conversion | retained current source candidate、exact revision/hash/kind/fan-in、kind-target mapping、G2.3 prerequisites、source immutability 和 no validation-success claim |
| Demand Thesis | solution-neutral、user/JTBD/scene/current alternative/loss/buyer/outcome 完整 |
| Solution Hypothesis | demand/baseline refs、delivery form、workflow change、baseline delta、risks 和 kill criteria |
| Solution Evaluation | selected/alternatives/rejected、baseline comparison、critical unknowns 和 capability-only signals |
| Opportunity Thesis | demand/solution/baseline、mental position、buyer language、value layer、state/context、反证和 freshness |
| Thesis Evaluation Snapshot | subject、关键假设、kill criteria、generation source groups、frozen_at 和 revision policy |
| Business Engine Thesis | pricing unit、频率、留存/复购、服务负担、可触达 beachhead、渠道、growth loop、unknown 和 refs |
| AI artifacts | baseline setup、reliability、evaluation、data rights、human review、产品单位经济、portability 和 bundle risk |
| Opportunity Comparison | hard gate 先于比较、四面板、unknown handling、evidence strength 不参与吸引力加分、sensitivity 和 partial-order 规则；用户输出无 global score |
| Concept fan-in/assessment | 所有 branch 回连同一 hypothesis、decisive evidence、反证、证据结论上限、缺口、belief update 和 assessment gate |
| Decision Brief | 决策问题、当前建议、决定性正反证据、未选项、最大未知数、what-would-change-it、belief update、有效期和边界 |
| Report | 三层输出一致、决定性判断可回溯、限制和 stale evidence 完整披露 |

### 24.4 Fan-in 与 Partial 结果

Branch 状态使用：

```text
completed
partial
insufficient_evidence
failed
cancelled
skipped
ignored_late
superseded_by_scope_change
superseded_by_adaptation
```

这里的 `partial` 是 owning G1/G2 branch Artifact 的结果语义，不是 Run Manifest unit state。当前 policy 不发布 partial-to-unit 映射：

- Fan-in 在对应 branch schema 已安装后可以读取并保留 `partial_branch_refs` 及其 decision impact。
- G0.4 `retry_unit` 不能以 partial branch 为前置，只认 `manifest.failed_units`。
- Owning slice 若允许 partial retry，必须同步更新 current branch schema、producer、consumer 和 policy，明确 branch ref、unit/attempt identity、目标 Manifest transition、stale/hash 和重复应用规则。
- 在此之前不得把 partial 私自写入 `completed_units`、`failed_units` 或另一个集合；任何这种映射都 fail closed。

Fan-in 不要求所有 branch 成功才继续，但必须显式记录：

```text
completed_branch_refs
partial_branch_refs
failed_or_missing_branches
skipped_branches
ignored_late_branches
superseded_branches
evidence_gaps
decision_impact_of_gaps
limitations
```

`discovery_fan_in.v1` 还必须包含以下引用式业务摘要：

```text
branch_evaluation_summary
evidence_sufficiency_summary
opposing_evidence_summary
pre_kill_summary
retained_candidate_refs
rejected_candidate_refs
watchlist_candidate_refs
judgment_assessment_refs
solution_evaluation_required
```

G2.2 current status boundary 中，`completed | partial | insufficient_evidence` 可以作为 reference-only fan-in 输入，其中 partial/insufficient 必须保留 gaps 与 conclusion ceiling；current Store 把三者的 unit 投影到 `completed_units`。`failed` 投影到 `failed_units`；`ignored_late | superseded` 只允许已有 terminal unit state，Artifact 进入 `ignored_late_artifact_refs`，且不得出现在 supporting lane refs、current candidate enrichment basis 或 disposition fan-in。`cancelled | skipped | missing` 没有伪造 lane Artifact，只以 unit id + decision impact 记录。所有 transition 在写 receipt/artifact 前验证，非法 state 以 `artifact.discovery_lane_transition_invalid` 零写入失败；reopen 同时间戳按 task 先于 lane 的稳定顺序重放。

每个 eligible disposition 仍必须逐 candidate 保留 subject-bound Judgment。一个 demand Judgment 不能用于 baseline/solution disposition；fan-in 可以让 subject=r1 的 Judgment支撑 final=r2，但必须显式列出 r1 `source_candidate_refs` 并证明 r2 沿 parent lineage descendant 于 r1。顶层 Judgment refs 只允许各 disposition refs 的 exact closure。

G2.4 enrichment branch 使用收窄的 terminal set `completed | partial | insufficient_evidence | failed | ignored_late | superseded`。前三者可以进入 `enrichment_fan_in.v1.eligible_branch_refs`，并保留其 conclusion ceiling；后三者只能进入 exact excluded classification，不得贡献 Evidence/Claim/Finding/Insight/Judgment/Source Manifest closure。Current Store 把 task publication 投影为 active，把 completed/partial/insufficient 投影为 completed、failed 投影为 failed，并让 ignored-late/superseded Artifact 只进入 `ignored_late_artifact_refs`。首次 publication 与 checkpoint recovery 必须使用同一 terminal-status classification，不能因原 Plan 缺少 output projection 而把 late/superseded branch 恢复成 current。

`concept_evidence_assessment_fan_in.v1` 必须按 dimension 汇总 judgment assessment refs、决定性支持和反对证据、缺失 mandatory dimensions、decision sufficiency 和 what would change the assessment。Fan-in 不复制底层 Evidence/Claim 内容，但必须保留这些 refs 和摘要；否则不得进入 comparison 或 assessment gate。

缺失 branch 影响 hard gate 或 assessment 时必须 follow-up、澄清或 `insufficient_evidence`，不能默认为中性结果。

### 24.5 Evaluator 结果

```text
passed
needs_revision
insufficient_evidence
failed
```

`needs_revision` 必须返回具体字段、artifact ref 和 revision request。重复生成整份 artifact 不是默认修复方式，应优先局部补充或更正。

### 24.6 正式产物规则

- Artifact 写入临时文件并通过校验后，再原子发布到正式 path。
- 已被下游 checkpoint 引用的 artifact 不原地改写；修订产生新 revision。
- Research Plan、Gap Snapshot 和 Adaptation Decision 一经正式发布均不可变；plan 只能通过新的 revision 演进，Adaptation Decision 的批准或拒绝状态由 event 和 manifest refs 表达，不回写原 artifact。
- 每个正式 artifact 记录 schema version、created_at、producer role、input refs 和 content hash。
- Final report 记录使用的全部主要 artifact refs 和 policy version。

## 25. 决策简报与完整报告

### 25.1 决策简报

`decision-brief.md` 是 completed Run 的默认用户入口，控制在一至两页，只回答当前决策所需的高信号问题：

```text
# 决策简报

## 本次要回答的决策问题
## 当前建议及适用含义
## 决定性支持证据
## 决定性反对证据
## 为什么没有选择其他方向或结论
## 最大未知数
## 什么证据会改变判断
## 用户初始判断与本次认知变化
## 可选下一步建议及执行边界
## 结论有效期、Scope 和局限
```

机会发现简报突出 `recommended_first_bet`、alternative bets 和 partial-order relation。概念证据评估简报突出 `prioritize | investigate_further | deprioritize | insufficient_evidence`，并明确结论只针对当前可获得证据。

决策简报结构化合同：

```text
decision_context_ref
mode
recommendation_or_assessment_ref
current_recommendation
recommendation_meaning
decisive_supporting_refs
decisive_opposing_refs
alternatives_not_selected
critical_unknowns
what_would_change_the_decision
belief_update_summary
optional_validation_suggestion_refs
external_action_boundary
valid_as_of
scope_summary
limitations
```

`external_action_boundary` 必须说明系统不执行或追踪外部验证。简报不能为追求简短而省略会改变结论的强反证或关键 evidence insufficiency。

### 25.2 机会发现完整报告

```text
# 创业机会调研报告

## 结论摘要
## Scope Assumptions
## Discovery Profile 与 Research Axes
## 决策建议
## 组合建议
## 比较面板、支配关系与排序组
## 研究方法与局限
## Top 机会详解
### Demand Thesis
### 用户语言、入口场景、心智占领与自然复述
### 当前替代和解法失效
### Solution Hypotheses 与 Baseline 比较
### Selected Solution 与交付形态
### 买单语言、Marketing Bridge、商业化和获客
### Business Engine Thesis 与可触达 Beachhead
### Output / Workflow / Outcome 价值与状态上下文
### 市场、竞品和可行性
### AI Capability Evidence（适用时）
### 支持证据、反证与不确定性
### Kill Criteria
### 决策建议和轻量验证建议
## Watchlist 与 Reject
## 敏感性与 partial-order 稳定性
## 审计追踪和来源
```

### 25.3 概念证据评估完整报告

```text
# 概念证据评估报告

## Assessment Result 与证据强度
## Concept Hypothesis
## 决定性支持和反对证据
## 需求、替代与解法失效
## 竞品与差异化
## 买单、获客、商业化与 Business Engine
## 可行性、合规和 AI Bundle（适用时）
## 关键未知数和 Kill Criteria
## 决策建议
## 可选轻量验证建议
## 局限和来源
```

### 25.4 写作与一致性规则

- 决策简报和完整报告基于同一 curated judgment context，不直接把 raw evidence 交给 writer 拼接。
- 每个决定性判断必须能回到 Judgment Assessment，并继续回溯到 Claim/Finding/Insight/Evidence。
- 明确区分事实、推断、假设和建议。
- 不用过长来源综述淹没决策结论。
- 不输出面向用户的全局总分，不把 `confidence_band` 或 panel band 表述成统计成功概率。
- 不隐去反证、过期证据或 `desk_research_only`。
- 概念证据评估不得写成“市场已经验证”；外部验证建议必须声明系统不执行、不追踪。
- JSON 是结构化事实源，decision brief 和完整 Markdown 是两种决策表达；三者冲突时 evaluator 失败。
- G2.4 Consistency v3 必须对 JSON 字符串值、Decision Brief Markdown 和完整 Report Markdown 执行同一 versioned deterministic scan；命中 validation-success、统计成功概率或 global-score policy 时 evaluator 结果必须为 `failed`，且不得 publication/materialize/recover 为 current report。

### 25.5 JSON Report Contract

机会发现报告顶层结构：

```text
report_metadata
decision_context_ref
scope_frame_ref
research_plan_ref
plan_lineage_refs
applied_adaptation_refs
decision_recommendation_ref
portfolio_view_ref
comparison_refs
business_engine_refs
top_opportunity_refs
watchlist_refs
rejected_opportunity_refs
capability_only_signals
trend_only_signals
sensitivity_summary
judgment_assessment_refs
validation_suggestion_refs
source_manifest_refs
traceability_ref
freshness_summary
limitations
```

概念证据评估报告顶层结构：

```text
report_metadata
decision_context_ref
concept_frame_ref
concept_hypothesis_ref
evidence_assessment_plan_ref
plan_lineage_refs
applied_adaptation_refs
hypothesis_evidence_matrix_ref
adversarial_review_ref
concept_evidence_assessment_ref
business_engine_ref
judgment_assessment_refs
validation_suggestion_refs
source_manifest_refs
traceability_ref
freshness_summary
limitations
```

`research_plan_ref` 或 `evidence_assessment_plan_ref` 指向最终生效 revision；`plan_lineage_refs` 和 `applied_adaptation_refs` 保留所有影响最终研究范围的计划变化，不要求决策简报逐条展示。`report_metadata` 包含 run id、mode、skill/policy/schema versions、generated_at、valid_as_of 和主要 input artifact hashes。

生成顺序固定为：

```text
validated artifacts
  -> report.json
  -> decision-brief.md
  -> report.md
  -> three-output consistency evaluation
```

## 26. 示例执行

### 26.1 宠物行业机会发现

调用：

```text
$startup-opportunity

action: discover
query: 宠物行业 App
```

Scope 可能解析为：

```text
mode = opportunity_discovery
discovery_profile = industry_first
market = CN
language = zh-CN
market_motion = consumer
research_axes = user_language + industry_demand + jtbd_workflow
  + solution_failure + competitor_gap + buyer_market
```

第一批 wave：

```text
user_language_mining
audience_pain
jtbd_workflow
top_products_gap
review_mining
substitute_non_app
solution_failure
```

可能形成 Demand Thesis：

```text
高龄宠物和慢病宠物家庭需要持续完成用药、复诊、检查记录和家庭交接；
当前主要使用微信、备忘录、纸质记录和宠物医院单次沟通，
在长期执行确认、异常补救和多人同步时失效。
```

同一需求下比较：

```text
native app
mini program
shared calendar integration
service-assisted workflow
current WeChat + reminder baseline
```

第一轮 fan-in 如果观察到“需求证据较强，但 buyer/payer 只有模型推断；另一个候选已经被迁移动机反证推翻”，系统形成：

```text
Gap Snapshot
  gap_buyer_001: buyer_evidence_insufficient -> hard_gate
  gap_candidate_004: candidate_pre_killed -> enrichment relevance

Adaptation Decisions
  add_unit(buyer_language_opportunity_003)
  add_unit(acquisition_opportunity_003)
  skip_unit(market_space_opportunity_004)
  skip_unit(monetization_opportunity_004)

research-plan.r1.json
  -> validate adaptations
  -> research-plan.r2.json
```

如果新增 buyer evidence 仍只有重复转载或无独立信号，下一轮 Gap Snapshot 产生 `source_repetition` 或 `no_material_new_evidence`，触发 `stop_followup` 并保留 limitation，而不是继续机械搜索。

最终候选可以是“宠物慢病管理与家庭协同”，但只有在真实用户语言、baseline 增量、家庭买单逻辑、获客和迁移意愿通过 gate 后才能进入强推荐。

### 26.2 当前 AI 创业机会发现

调用：

```text
$startup-opportunity

action: discover
query: 目前 AI 创业有哪些机会？适合没有自研基础模型能力的小团队。
```

Scope：

```text
mode = opportunity_discovery
discovery_profile = ai_first
research_axes = ai_capability + cross_industry_demand + buyer_market
market_motion = consumer
```

Capability seed 可以提高近期能力 frontier、成本、模态和生态变化的研究优先级，但需求、任务、替代方案和买单 lane 仍必须形成统一 Demand Thesis。Solution Space Mapper 同时生成普通软件、平台、人工和 AI-assisted 方案。

报告允许出现：

```text
capability_only
  只有能力变化，没有真实需求。

solution_gap
  需求真实，但候选方案都不能提供足够 baseline 增量。

reject
  通用模型/平台已经充分解决，或可靠性、数据、信任、产品单位经济不成立。
```

每个 AI 推荐方向必须单独输出 capability delta、technical reliability、evaluation feasibility、data readiness、human review dependency、provider portability、platform/open-source substitution、data feedback moat、capability half-life 和 adoption trust。

### 26.3 AI 行程冲突检查概念证据评估

调用：

```text
$startup-opportunity

action: assess
query: 面向自由行用户的 AI 行程冲突检查功能值得做吗
```

Scope：

```text
mode = concept_evidence_assessment
assessment_profile = ai
target_user = complex independent travelers
claimed_value = detect schedule, location, opening-hour and reservation conflicts
```

除通用证据评估维度外，必须比较：

- 用户手工检查、地图、OTA 和日历 baseline。
- 通用模型 + web/map tools 是否已经足够。
- 实时营业时间、交通和预约数据是否可获得。
- 错误检查造成的用户损失和人工复核需求。
- 平台内置风险和可持续差异。
- 用户是否愿意为单次检查或持续行程协同付费。

如果需求存在，但通用模型/OTA 已充分覆盖且没有工作流、数据或渠道差异，assessment result 应为 `deprioritize` 或受限的 `investigate_further`，不能因为 AI 能完成任务就推荐。即使结果是 `prioritize`，也只表示当前证据支持优先关注，不表示市场已经完成真实行动验证。

## 27. GPT Researcher 的关系

GPT Researcher deep 流程提供以下参考：

- initial search 后生成带 goal 的 sub-queries。
- 多 query 并发研究。
- breadth/depth 式追问。
- source filtering 和 context compression。
- synthesis 前整理 source manifest。
- 无资料时 abstain。

本项目不直接把 `GPTResearcher(report_type="deep")` 作为业务入口。可复用它的 search/fetch/research 实现时，必须遵守本方案的 Evidence Record、artifact、run 和 evaluator 合同。

GPT Researcher 可以成为某类 MCP 工具、脚本库或 lane researcher 的参考实现，但不能：

- 隐藏完整创业机会规划。
- 直接返回最终 Opportunity Thesis。
- 绕过 Evidence Store。
- 用一篇自然语言报告替代 branch artifacts。

## 28. 版本、恢复与生命周期

### 28.1 版本对象

以下内容是独立的 current contract surface：

```text
entry Skill
mode references
lane catalog
custom agents
decision context contract
artifact schema manifest
decision/comparison policy
adaptation policy
decision brief contract
report contract
deterministic scripts
MCP tool contract
```

Manifest 不记录 schema bundle release 或 build identity。版本策略如下：

- `harness/schemas/current.json` 是唯一可直接修改的 schema manifest，没有 base chain、历史选择或产品发布版本。
- 代码或合同更新后使用新的 `run_id`。旧 Run、旧 receipt、旧 Manifest 和旧 Artifact 不迁移、不恢复、不继续执行，也不需要稳定的旧 Run 识别或 restart-required 协议；误传时可以按普通 current 校验失败。
- 已退役 schema/fixture 不构成回归门禁。不得仅为历史 bytes 增加 adapter、fallback、migration 或兼容分支。
- 数字较小不等于已退役。只要当前 producer、consumer、policy 或 `$ref` 可达，一个编号 domain contract 就仍是 current contract 的一部分；判断依据是可达性，不是名称。
- 普通修复原子更新 current manifest、producer、consumer、validator、policy 和现行 fixtures。当前必须同时区分不兼容 shape 时使用业务语义名称，不建立新的 Store 版本选择层。
- 跨代码更新不恢复旧 Run，与同一 current Run 的故障恢复是两个边界。同一 Run 内已经发布的 immutable Artifact revision、content/envelope hash、ref、atomic Manifest replace、operation receipt exact replay、checkpoint/reopen 和 fault recovery 必须继续 fail closed。

### 28.2 幂等和重复交付

- `create-run` 对同一个显式 run id 不重复创建。
- Evidence 使用稳定 operation key 去重。
- Gap Snapshot 使用 base plan、trigger kind、wave/event id 和 observed artifact hashes 计算 `snapshot_cycle_key`；相同 content hash 重放幂等，相同 cycle 的 deterministic gap 必须稳定，semantic gap 变化必须发布新 snapshot revision、回连 parent 并说明原因。
- Adaptation Decision 使用 `adaptation_id + based_on_plan_ref` 作为幂等键；相同内容重放返回已应用结果，不创建重复 unit 或 plan revision。
- Plan Revision 使用 parent plan hash 和有序 adaptation refs 计算 operation key；相同输入必须生成语义一致的下一版计划。
- Subagent retry 写入新的 attempt/revision，不覆盖已发布 artifact。
- Checkpoint 只引用通过验证的正式 artifact。
- 三层输出生成可以重复执行，但相同输入 refs 和 policy version 应产生一致的 report.json、decision-brief.md 和 report.md，并记录新 hash。

### 28.3 Process crash

恢复步骤：

```text
load manifest
  -> validate the current Manifest contract
  -> validate last checkpoint
  -> verify current plan ref and complete plan lineage
  -> reconcile proposed / rejected / applied adaptations with events
  -> verify artifact refs and hashes
  -> identify completed / active / missing units
  -> mark orphan active units interrupted
  -> ignore late artifacts from cancelled or superseded units
  -> finish an atomically published plan revision or roll back to manifest current plan
  -> validate current definitions
  -> continue from next safe phase
```

恢复不假设原 subagent thread 仍然存在。必要时使用当前 Plan Revision 中的原 task envelope 创建 replacement subagent。只有 Adaptation Decision artifact 已发布但没有 `adaptation_applied` event 时，不得猜测其已经批准；重新运行幂等校验和应用流程。

### 28.4 Completed Run

Completed Run 的正式 artifact 和报告不可原地重写。用户提出以下需求时创建 continuation Run：

- 更新过期市场或竞品信息。
- 深入某个 Top 机会。
- 使用新约束重新排序。
- 把发现的机会转成概念证据评估。
- 补充用户提供的私有材料。

Continuation Run 记录 parent id、继承的 artifact refs、重新校验的 Evidence 和新的 decision log。

### 28.5 当前不实现的预算能力

首版不记录或统计：

```text
model tokens
agent cost
tool cost
lifetime cost ceiling
resource ledger
per-lane cost attribution
```

保留的只是研究收敛规则，不将其包装成预算系统：

```text
max follow-up rounds
no material new evidence stop
decision relevance requirement
user pause/cancel
source repetition stop
```

候选创业产品的单位经济、推理成本和人工审核成本仍是市场判断的一部分，与 Research Harness 自身的执行预算无关。

## 29. 验收标准

### 29.1 入口和 mode

- `$startup-opportunity` 可以在支持 Skills 的 Codex 桌面、CLI 和 IDE 中被显式调用。
- `discover`、`assess`、`resume`、`status` 行为稳定且互不混淆。
- 明确产品 thesis 不进入 TopN 发现流程。
- 宽泛机会发现不输出单一 concept evidence assessment。
- 模糊输入在选择会显著改变结果时请求澄清。
- Run 创建后不因模型自由判断改变 mode。
- 每个新 Run 都有 DecisionContext，`decision_to_make` 只能使用 published enum，且不包含外部验证 action。
- 每个 Run 只有一个 primary market 和 primary language；多国家请求拆成独立 Run，且不产生未经校准的统一跨市场排名。

### 29.2 Run 和恢复

- 每个 Run 都有 intake、decision context、manifest、plan、events、decisions 和 checkpoint。
- 用户中途改变 scope 后，decision log、Gap Snapshot、Adaptation Decision、plan revision 和废弃 artifact 可追踪。
- Process crash 后可以从最后有效 checkpoint 恢复。
- 恢复不依赖原 subagent thread 或完整聊天历史。
- Completed Run 不被后续深入研究原地改写。

### 29.3 数据驱动动态扩展

- 每次 G0.4 Plan/adaptation validation 都有 Planning Context v2 和 AI trigger source attestation v1；missing/wrong source ref、schema version、canonical content hash、subject/trigger/context revision binding，或 stale Run/Plan identity/ref/hash/revision 必须 deterministic reject。Validation 只解析调用方显式提供的 Document Bundle，不扫描 Run 或解释自然语言。
- Exact mode/phase/unit type/agent role/output schema tuple 来自 current closed policy；policy 明确声明的 future output schema 可以进入 plan，但 schema 未安装到 current manifest/Envelope 时 Artifact publish 必须拒绝。
- `continue_existing_plan` 使用 main Agent 声明的 canonical Coverage Attestation；Harness 验证 exact coverage_key/relation、subject/ref、pending/active state、plan lineage 和 stale 条件，不用字符串或隐藏 LLM 判断语义等价。
- G0.4 `retry_unit` 只接受 Run Manifest `failed_units`；completed/active/pending 和 partial artifact 均拒绝。Partial retry 只有 owning branch current schema/policy 同步更新后才能启用。
- 每个通过校验的 research wave 都产生 Gap Snapshot，即使结果是没有 decision-relevant gap 或只存在 stop signal。
- 用户 scope/优先级变化、validation failure 和 adversarial review challenge 可以产生 event-driven Gap Snapshot，不需要等待 wave 结束。
- 每个 decision-relevant gap 在 checkpoint 前都有 validated disposition；已有 unit 覆盖时使用 `continue_existing_plan`，不存在隐式忽略。
- Fixture 覆盖 deterministic 和 agent-semantic gap；两类 gap 都有 observed artifact/evidence refs 和 decision impact。
- buyer evidence 不足可以通过已批准 `add_unit` 追加 buyer-language unit，并生成新的不可变 Plan Revision。
- `uses_ai=true` 且 mandatory AI bundle 缺失时追加允许的 AI unit；超过 follow-up 上限或无法补齐时限制结论，不能静默通过。
- 已被核心反证 pre-kill 的候选可以跳过仅服务该候选的 pending enrichment，但不能删除已完成 artifact 或误伤共享 unit。
- active unit 因 scope change 失效时使用 cancel/supersede；late artifact 标记 `ignored_late`，不能进入 fan-in。
- 相同 Adaptation Decision 重放不会重复创建 unit；基于旧 plan revision 的并发 adaptation 被拒绝。
- Adaptation policy 拒绝非法 unit type、越权路径、mode/market 切换、运行时比较调权和超过最大轮数的 follow-up。
- `no_material_new_evidence`、`source_repetition` 或用户接受 limitation 可以触发 `stop_followup`，且停止不被表达为证据充分。
- Crash fixture 覆盖 plan 文件已发布但 manifest/checkpoint 未完整更新的边界，并恢复到唯一有效 current plan。
- 所有最终报告记录最终 plan ref、plan lineage 和已应用 Adaptation Decision refs。

### 29.4 Subagents

- 每个 subagent 获得 typed task envelope 和唯一 output path。
- Subagent 最终消息不被当作正式 branch result。
- 并发 unit 不写同一正式文件。
- 主 Agent 只消费通过 schema/reference validation 的 artifact。
- Evidence auditor 和 adversarial reviewer 与原 lane researcher 分离。
- Adversarial reviewer 使用独立 challenger query；不能取得独立来源时记录 generation/evaluation overlap。

### 29.5 Evidence 和质量

- 每个决定性 Claim 有真实存在的 Evidence ref。
- 用户原话与模型概括明确区分。
- Verbatim quote 保存 source location，翻译与原文分字段。
- Source Manifest 能识别转载、共享数据集和重复评论样本。
- 被拒绝的来源及拒绝原因可追踪，follow-up 不反复消费同一低质量来源。
- 来源独立性、bias、geo、language、retrieved_at 和 freshness 可审计。
- Supporting 和 opposing evidence 同时存在，或明确记录为什么不存在。
- 过期来源不能继续支撑强推荐。
- 无证据时返回 `insufficient_evidence`，不以模型常识补齐。
- Evidence lifecycle、judgment signal 和 decision sufficiency 使用不同字段，不把来源状态与判断方向混在同一个 enum 中。
- Fixture 能区分 `opposed`、`mixed`、`no_signal`、`source_unavailable`、`not_applicable` 和 `stale`，且每个决定性判断记录 what would change the decision。
- `source_unavailable` 有 Source Manifest 的访问失败或来源缺口记录；`no_signal` 有已完成合理检索但未观察到信号的记录。
- 决定性判断的 `decision_sufficiency` 为 `insufficient` 或 `blocked` 时，Evaluator 限制推荐档位或输出 `insufficient_evidence`。
- Evidence origin 区分 public source 和用户主动提供的已有材料，不把后者自动判为高等级。
- Evidence tier 只描述当前材料强度，不形成外部验证生命周期；缺少行为/承诺证据不自动成为反证。
- 低等级证据触发已定义的结论上限，`prioritize` 不得绕过 evidence sufficiency。

### 29.6 机会发现

- Fixture 覆盖 `general`、`industry_first`、`ai_first` 和 `hybrid`。
- Demand Thesis 在 Solution Hypothesis 之前形成且保持方案中立。
- 每个推荐机会回连 selected solution 和 Baseline Option。
- Seed-independent lane 能发现初始 product/capability seed 之外的需求。
- Counterfactual lane 能保留至少一个不同 user/job/scene 或替代解释。
- Research Plan 在 enrichment 前冻结 thesis、关键假设和 kill criteria，并尽可能分离候选生成与评估来源。
- Consumer fixture 覆盖 native app、mini program、mobile web/PWA、platform native 和 service-assisted 的合理比较。
- Buyer fixture 覆盖 self payer、household payer、sponsor payer 和 provider/channel model；使用者和付款者分离时分别验证。
- Lane 内不使用固定 TopN 过早删除多样候选。
- LaneResult 包含 judgment assessments、领域对象 refs、pre-kill、rejected/watchlist/retained candidates、decision sufficiency 和 candidate diversity summary。
- 只有能力或趋势、没有 Demand Thesis 的对象被标记 `capability_only`/`trend_only`。
- 强候选包含 mental position occupation 和自然复述测试状态；未执行测试时是 `not_tested`。
- 比较输出 hard gate、四个独立面板、uncertainty、sensitivity 和 partial-order stability band，不输出面向用户的 global score。
- 区间重叠时允许 partial order。
- 每个正式候选具有 BusinessEngineThesis；宽泛 TAM 不能替代可触达 beachhead、留存/复购和渠道判断。

### 29.7 概念证据评估

- Fixture 覆盖 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence`。
- 所有 branch 回连同一个 concept hypothesis。
- 强替代方案或反证可以翻转 assessment result。
- AI/regulated AI 缺 mandatory bundle 时不能给出强结论。
- `prioritize` 明确表示当前证据支持优先关注，不得写成“市场已经验证”。
- 系统不创建、执行或追踪外部访谈、落地页、订金、付费实验和 MVP 测试。

### 29.8 AI 机会

- Capability seed 不能单独生成正式机会。
- 通用模型、平台和开源 baseline 已解决核心任务时降低或拒绝推荐。
- 缺少代表性评测时标记 `desk_research_only`。
- 高错误成本任务缺少人工兜底和责任边界时不能强推荐。
- 产品 unit economics 不成立时触发 kill condition。
- 单一 provider/platform 内置风险限制推荐档位。
- AI fixture 分别覆盖 technical reliability、evaluation feasibility、data readiness、human review dependency、provider portability、data feedback moat 和 adoption trust。
- `ai_capability_evidence` coverage fixture 覆盖 capability frontier、cost/deployment、workflow/human boundary、ecosystem/platform、data/evaluation 和 adoption/trust；mandatory dimension 缺失时不能强推荐。
- AI coverage dimension 只有在业务上确实不适用时才能标记 `not_applicable`；来源不可得必须标记 `insufficient_evidence` 和 `source_unavailable`。
- AI 产品单位经济和 Research Harness Agent 执行预算严格区分。

### 29.9 决策简报和报告

- report.json、decision-brief.md 和 report.md 内容一致。
- 决策简报是默认用户入口，包含决策问题、当前建议、决定性正反证据、未选项、最大未知数、what-would-change-it、belief update、有效期和边界。
- Top 机会包含 trigger phrase、entry scene、mental position occupation、solution failure、next action、buyer language、marketing bridge、baseline delta、value layer、state/context、risks 和 kill criteria。
- 报告明确限制、反证和证据时间。
- Concept evidence report 不输出无关 TopN。
- 简报和报告不输出 global score，也不把 confidence 或 panel band 描述为成功概率。
- Validation Suggestion 的 `effort_band` 只表达相对复杂度，不输出资源配置，也不声称适配用户实际资金预算。
- 外部 Validation Suggestion 固定声明 `execution_owner=user`、`execution_supported=false` 和 `result_tracking_supported=false`。

### 29.10 领域合同完整性

- Fixture 覆盖 DecisionContext、UserLanguageMap、SolutionFailureMap、Judgment Assessment、Demand Thesis、Baseline Option、Solution Evaluation、Opportunity Thesis、BusinessEngineThesis、Decision Recommendation 和 Decision Brief。
- Opportunity Thesis 的 demand/solution/baseline/claim/insight refs 全部可回溯。
- Buyer Purchase Language 分别表达 user、buyer、payer、budget source、purchase trigger 和 decision criteria。
- Value Layer Analysis 不把一次性 output 自动判为 workflow/outcome 价值。
- User State Context Model 缺少授权数据、更新触发或 ground truth 时不能获得高 `state_context_value`/`data_feedback_moat`。
- Opportunity comparison 使用 versioned rubric、四面板、相关性折减和 `unknown` handling；evidence strength 不进入 attractiveness 加权和。
- Active Run 不允许用户或 Agent 任意修改单项面板的重要性；不同偏好只能选择已发布的 versioned decision/comparison profile。
- Opportunity quality、evidence strength、team execution fit 和 researchability 分别表达；用户资金预算不直接决定 `strong_candidate` 与 `investigate_further`。
- Fan-in 对 partial、failed、cancelled 和 superseded branch 保留 decision impact，不默认为中性输入。
- Discovery fan-in 保留 evidence sufficiency、opposing evidence、pre-kill、candidate disposition、judgment refs 和 solution-evaluation-required 摘要，但不复制 raw evidence。
- Validation Suggestion 每条回连决定性假设和 evidence gap，且不创建外部验证动作。
- Decision Recommendation 记录 initial belief、改变判断的证据、remaining disagreement 和 final decision owner；这些字段不覆盖证据判断。

### 29.11 架构边界

- 新方案不依赖外部通用 Workflow Runtime 或 Dynamic Workflow DAG framework。
- 动态扩展只接受 closed gap/action/unit 和不可变 plan revision，不执行任意条件表达式或 Agent 生成代码。
- 不存在隐藏 LLM 调用的“确定性脚本”。
- Hooks 被禁用时核心流程仍能显式运行。
- 首版没有 Agent token/cost 预算账本或资源 ledger。
- 首版不采集用户侧外部验证预算，也不进行多国家统一比较和排名。

## 30. 实施顺序

实施顺序按风险和可验证性拆分，不改变本文的完整目标形态。

本节只保留架构分层和依赖顺序。`startup-opportunity-implementation-progress.md` 是已经完成的施工历史记录，只用于追溯当时的提交和验证证据；其中的 Gate、controller、`READY` 和切片状态不约束当前维护、修复或产品迭代。

### 30.1 基础 Harness

- 创建 `AGENTS.md`、Skill 目录和三类 custom agents。
- 建立 run store、DecisionContext、manifest、events、decisions 和 checkpoint。
- 建立不可变 Plan Revision、Gap Snapshot、Adaptation Decision 和 current adaptation policy。
- 实现 `analyze-gaps`、`validate-adaptation` 和幂等、原子的 `apply-plan-revision`。
- 建立 Evidence Store 和 stable ids。
- 实现 schema/reference/freshness validator。
- 实现基础 MCP 或 web evidence recording adapter。
- 实现 report.json -> decision-brief.md/report.md 的双层输出和一致性 evaluator。

### 30.2 Concept Evidence Assessment Vertical Slice

- 实现 `assess` action。
- 覆盖需求、替代、竞品、买单、获客、可行性和反证。
- 输出 evidence matrix、BusinessEngineThesis、adversarial review 和四类 assessment result。
- 验证 buyer gap 追加 unit、无新证据停止、主窗口纠偏、plan lineage 和跨会话恢复。

优先实现 concept evidence assessment，因为它围绕单一 thesis，最容易验证 typed handoff、evidence chain、结论上限、review、decision brief 和 full report 是否真正闭环。

### 30.3 Opportunity Discovery

- 实现 `discover` action、profile 和 lane catalog。
- 实现 research waves、Gap Snapshot、受控 Adaptation Decision、候选 pre-kill 后的 enrichment skip、Demand/Solution synthesis、frozen thesis boundary 和 clustering。
- 实现 BusinessEngineThesis、hard gates、四面板比较、sensitivity 和 portfolio view。

### 30.4 AI Bundle

- 加入通用模型/platform/open-source baseline。
- 加入 evaluation reliability、data rights、human review、product unit economics 和 commoditization gates。
- 建立 `desk_research_only` 和代表性 benchmark fixture。

### 30.5 分发与自动化

- 在能力稳定后打包 Codex Plugin。
- 需要无人值守时再评估 `codex exec`、automation 或 Agents SDK/Responses API 服务层。
- 需要多用户或独立 UI 时在 Harness 外建设产品层，不修改领域 artifact 合同。

### 30.6 明确不采用或延期的能力

- 不采用运行时人工动态调权。需要不同判断偏好时选择经过校准、版本化和审计的 decision/comparison profile；新 profile 必须独立发布，不能在 active Run 中临时修改单项面板的重要性。
- 多国家同时比较延期。首版每个 Run 只有一个 primary market 和 primary language；多国家请求拆成独立 Run，允许互相引用，但不生成未经跨市场校准的统一分数、排名或进入顺序建议。
- 未来若建设 Market Comparison，必须使用独立 comparison artifact，至少比较 demand、buyer/payment、competition、acquisition、delivery form、regulation、localization cost 和 evidence comparability；不能直接合并各市场 raw evidence 或 global score。
- Scope assumption 模板属于后续易用性能力，不影响当前显式 ScopeFrame 合同。
- 报告后二次深入由 continuation Run 支持，不原地修改 completed Run，也不需要新增验证执行平台。

## 31. 风险与注意事项

- Codex subagents 提高并行度，也会增加上下文协调和来源重复，需要 wave、task envelope 和 artifact contract 约束。
- 用户可以在主窗口实时纠偏，但若不写 decision log，会产生不可审计的隐式状态。
- 如果 `material_new_evidence` 和 decision relevance 只存在于主 Agent 自然语言中，动态调整会再次退化为隐式状态；必须通过 Gap Snapshot 保存语义判断和 refs。
- 并发产生的 adaptation 可能基于过期 plan；应用前必须执行 current-plan compare-and-swap 语义，拒绝 stale base revision。
- cancel 是 best effort，late artifact 仍可能到达；fan-in 必须按 unit disposition 排除 `ignored_late` 结果。
- Web 数据可能不完整或受地域、登录、反爬和个性化排序影响。
- 评论、搜索量和媒体讨论是代理证据，不能替代行为、交易或支付承诺。
- 多来源可能共享同一底层数据，来源数不能直接等于置信度。
- 候选生成和评估复用同一搜索路径会形成自证循环；无法取得独立 challenger source 时必须降低结论强度。
- LLM 可能过度概括用户表达，真实 quote 与模型总结必须分离。
- 用户初始偏好可能造成确认偏误，belief update 必须解释变化但不能覆盖证据结论。
- 用户抱怨不等于会迁移，需求存在不等于有人付费。
- Trigger phrase 不等于 buyer purchase language。
- 公开资料通常无法提供完整 CAC、留存和毛利数据，Business Engine 必须允许 unknown 和区间，不能生成伪精确经营模型。
- 原生 App 不一定是最佳首发形态。
- AI 能力、价格、License 和平台政策变化快，必须使用 freshness policy。
- 厂商 benchmark 不能替代目标任务评测。
- 单次 output 容易商品化，必须验证 workflow/outcome 价值。
- 长期状态和数据闭环必须建立在用户授权、可获得数据和隐私边界上。
- 决策简报可能因压缩而隐去强反证，必须与 report.json 和完整报告执行一致性校验。
- Hooks 是辅助 guardrail，不应被误认为完整安全控制面。
- Codex 权限和 subagent 行为依赖当前客户端、账号和项目配置，Harness 不假设所有环境能力完全一致。
- 本系统输出决策建议，不替用户承担创业、法律、医疗、金融或投资责任。

## 32. Codex 官方能力依据

本方案使用的 Codex surface 依据当前官方文档：

- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Plugins](https://learn.chatgpt.com/docs/plugins)

这些 surface 是互补关系：`AGENTS.md` 提供仓库级规则，Skill 提供可复用流程，subagents 提供并行角色，MCP 提供外部工具，hooks 提供生命周期 guardrail，Plugin 提供后续分发。

## 33. 结论

Startup Opportunity 应实现为一个 Codex-native、repo-backed 的 Research Harness：

```text
$startup-opportunity
  + Codex main-agent orchestration
  + bounded subagent research waves
  + evidence-backed Gap Snapshot / Adaptation Decision
  + immutable, validated Plan Revision
  + Research Kernel
  + Evidence / Claim / Finding / Insight
  + Demand Thesis
  + Solution Hypotheses
  + Baseline Option
  + Business Engine Thesis
  + Opportunity Thesis or Concept Evidence Assessment
  + deterministic validation and four-panel comparison
  + adversarial review
  + immutable run artifacts and checkpoint
  + decision context and belief update
  + report.json / decision brief / full report
```

Codex 主窗口提供比固定工作台 workflow 更自然的实时沟通和动态纠偏；Subagents 提供研究并行和上下文隔离；仓库内 Harness 则保留专业调研服务不可缺少的证据链、结构化合同、恢复和评价能力。

本方案的关键不是用 Codex 替换所有工程控制，而是把控制面缩减到创业机会调研真正需要的部分。它避免另行建设通用 Workflow Runtime，也避免把服务退化成一次性聊天或长报告生成。
