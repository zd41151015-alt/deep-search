---
name: startup-opportunity
description: 发现并评估消费级 Startup Opportunity，评估具体产品或功能 thesis 的当前 Evidence，或检查并恢复仓库支持的研究 Run。适用于 Startup Opportunity 方向研究、concept evidence assessment、替代方案、买方与获客 Evidence、AI baseline 比较和现有 Run 状态。
---

# Startup Opportunity

将此 Skill 作为 Startup Opportunity 研究唯一的 repo-local 入口。RFC 与已发布 contract 是业务/Artifact 边界的权威来源，当前代码与 `doctor` 决定可执行能力；implementation progress 只作为历史施工账本，不门禁维护或后续产品迭代。

## Current Execution Gate

每个任务第一次依赖此仓库前运行一次 `npm run harness -- doctor --json`；同一任务内不要在每个 phase、lane 或 context transition 后重复运行。Harness 提供 caller-supplied Artifact 的确定性 Run、Evidence、validation、adaptation、comparison、scaffold 与 report surface，并从 Lane 研究语义机械生成正式 Audit 的 ID/hash/ref、freshness、coverage closure、ranking/ceiling 和报告投影。Harness 不分派 agent、调用 LLM、执行 lane、benchmark 或 network research，也不替 agent 形成研究语义、comparison、recommendation 或 AI bundle 判断。

## Action Routing

- `discover` 映射到新 Run 的 `opportunity_discovery`；向用户呈现解析后的 action/mode，按 `scripts/create-run.ts` 创建 Run，只读取 `references/opportunity-discovery.md`。
- `assess` 映射到新 Run 的 `concept_evidence_assessment`；向用户呈现解析后的 action/mode，按 `scripts/create-run.ts` 创建 Run，只读取 `references/concept-evidence-assessment.md`。
- `resume` 需要持久化 `run_id`；先读取 `references/artifact-contracts.md`，再运行 `scripts/load-run.ts` 完成显式恢复，从 validated manifest/checkpoint 继续当前 mode。
- `status` 需要持久化 `run_id`；先读取 `references/artifact-contracts.md`，再运行只读 `scripts/status-run.ts`。同时读取 `derivedExecutionDisposition`、`terminalReportDisposition` 和 `terminalReportIssues`；terminal Manifest 不等于已完成报告交付。绝不启动 subagent、恢复或修改 Run。
- 如果请求混合宽泛 discovery 与具体 thesis，且选择会改变输出 contract，则在创建 Run 前要求澄清。
- 创建任何正式 Run 前，必须取得用户明确给出的地域、B2C/B2B/B2B2C/mixed、目标用户群、决策目标和主要研究语言；不得从用户所用语言推断市场。`create-run` 会拒绝缺少这些参数的请求。
- `create-run` 只把 Scope proposal 作为 revision 1 原子追加到 `decisions.jsonl`，Manifest 状态保持 `awaiting_scope_confirmation`。必须把返回的 exact revision/ref/hash 所绑定 Scope 展示给用户，收到明确确认后再调用 `scripts/confirm-scope.ts`；Harness 只记录 caller-attested confirmation，无法认证聊天身份。当前 Run 内的用户修正先用 `scripts/propose-scope.ts` 追加 proposal，再独立确认；在确认前不得计划或搜索，修正确认后还必须完成 Gap -> Adaptation Decision -> Plan Revision 对账。
- Run 不得静默改变 mode，并且只包含一个主要市场和一种主要研究语言。

## Non-Negotiable Rules

- 按需渐进读取 mode 与 phase reference；默认不得同时加载两套完整工作流。
- 正式结论只能来自已经验证的仓库 Artifact，绝不能来自 chat 或 subagent 完成消息。
- 绝不伪造 Evidence、来源 provenance、用户原话、市场数据、验证结果或引用。
- 为每个 subagent 提供 typed task envelope 和唯一 output path。main agent 始终是唯一 orchestrator。
- 语义判断留给 agent；deterministic 验证、存储、版本控制和报告机制留给 Harness。
- 绝不覆盖 current plan。Runtime 调整必须依次经过 Gap Snapshot、一个或多个已验证 Adaptation Decision 和不可变 Plan Revision。
- 新 Run 必须先形成并发布 Intake、DecisionContext 与 ScopeFrame，再生成和验证 `plans/research-plan.r1.json`；不得从聊天摘要跳到 research wave。
- 每个 wave 只使用 typed task envelope 启动 bounded custom agent。agent completion summary 只作通知，父任务必须从唯一 output path 重新读取并验证正式 Artifact。
- 每个新 dispatch wave 必须把 execution overlay 和完整 Dispatch batch 放进同一个 `compile-artifacts` publish request；Discovery research lane 还必须同包包含该 batch 的全部 canonical task envelopes。发布成功前不得启动任何 lane，不得先发布 Dispatch 激活 unit 再补 task。whole-wave intent 会在 crash recovery 时先补齐全部成员，再投影 Manifest。
- 同一 dispatch batch 中彼此独立的 lane 在 `dispatch_mode=parallel_immediate` 发布后立即并发启动；Harness 只验证机械投影，不调度 agent。
- 搜索规划以 60%-70% 用户/商业行为、15%-20% 经营披露/监管/市场结构、不超过 20% 学术机制/边界/反证为默认提示，不要求实际查询次数严格命中比例，也不以偏差作为 Gate。实际采用来源分布只能由 Evidence Register 机械推导，不能使用 agent 自报比例；比例偏差只进入审计观察。真实性、安全、exact ref/hash、数值/proxy 语义和强结论 Evidence ceiling 是强门禁；覆盖不足或来源偏弱只降低 confidence、ranking 或 recommendation ceiling。
- 商业覆盖必须标为 `observed`、`inferred` 或 `unknown`。缺少直接材料时保留合理推测，但必须写出依据引用、推理起点、推理过程、不确定性和待验证项；`inferred` 可满足报告内容完整性，不得冒充已观察事实或满足排序 Gate。多候选 Lane 的 unresolved gap 要提供可推导的 subject 语义（单候选可省略，真正共享可显式列多个 subject）；Harness 会机械补齐 exact task/Audit binding 并投影 subject-local 正式 gap，不得把一个候选的 gap 复制到其他候选。
- Incumbent Absorption & Response Risk 只在候选或 concept 已形成后开展：candidate generation 必须 `not_assigned`，formed candidate evaluation 使用 bounded `lightweight_scan`，shortlist/retained opportunity 或 assessment commercial stage 才使用计划明确分配的 `targeted_deep_dive`。Execution Plan 是 assignment 唯一权威；每个响应研究 stage 恰有一个 `owner`，额外复核只能显式标为 `independent_review`，其余 Lane 必须 `not_assigned/none`。包括 `not_assigned` 在内的每个 assignment 都必须按 Plan -> Dispatch -> Research Task -> 正式 Audit exact subject/role/depth 投影；缺少任一层或发生漂移都属于 integrity error，Task 没有 fallback 权威。Lane 一次性交付 responder 研究语义，Harness 只生成稳定 ID/hash/ref、coverage/缺口行和报告投影。
- 潜在响应者可为同类 incumbent、platform owner、suite incumbent、adjacent leader、channel/distribution controller、data owner、marketplace 或其他控制关键入口的主体。分析必须分别说明 ability/capability adjacency、implementation/operational/compliance/data/distribution cost、incentive 与 disincentive/cannibalization、response horizon、distribution leverage、response mode、可覆盖的 thesis 范围和 residual differentiation；“能做”不能推导“会做”，复制单一 feature 不能推导完整价值主张已被覆盖。
- Incumbent Response 只作 judgment context，不是 Gate，不自动淘汰或 unrank，不自动降低 Claim confidence，不产生 recommendation ceiling，也不阻塞 Lane、候选、Audit 或报告发布。Agent 对 `assessed` 只提交 responder、能力、成本、动机、时间、分发、thesis coverage、residual differentiation、Evidence roles、推理边界与不确定性等结构化研究维度，不提交 pass/fail、淘汰、行动或 ceiling 指令；Harness 独占并确定性注入 validator 可验证的固定 reference-only `strategic_implication` 与决策边界。没有相关 responder 时只提交 `not_applicable` 与理由，缺少足够材料形成完整判断时提交 `unknown`、uncertainty、unknowns、data gaps，并可选保留 supporting/opposing/background Evidence refs，Harness 再扩展为统一安全报告行。`unknown` 的正式 rationale 只说明已提交材料与语义不足以形成完整 responder-specific conclusion，不声称没有 assessment 或没有任何 Evidence；其能力、成本、动机、时间、thesis coverage、residual differentiation 和 confidence 仍安全展开为 unknown/空。可选 refs 继续接受 same-Audit Evidence Register、exact ref/hash、Run 与安全校验。`unknown` 必须进入 Search Closure 与报告 gap，`not_applicable` 不算 gap；每张正式响应风险表无论有无数据都固定声明 context-only/非门禁。新闻、评论、论坛、厂商、监管、API/数据集、proxy/estimate 以及 supporting/opposing/background Evidence 全部保留并标注角色，不要求 adopted 才能作为 opposing/background；只有伪造、broken exact ref/hash、跨 Run、敏感信息、访问控制或错误引用继续 fail closed，不设置来源、provider 或 API 白名单。
- 每个计划 lane 都必须在 `completed`、证据不足、early stop 或搜索失败等终态留下 Search Closure；纯综合/校验使用 `search_not_required`，搜索前失败使用 `failed_before_search`。只对正式提交的 search results 与 Evidence Register 对账；`telemetry_basis=unavailable` 时提交研究目标、主要 route、采用来源、已有记录和停止原因即可，`query_log_complete=false` 是正常披露，不得伪装为 Harness 已验证的完整浏览器日志。
- Wave 1 没有需求、买方或购买信号时，立即以证据不足收口，不进入具体方案评估。
- 每次 wave 后先验证 Artifact，再形成 Gap Snapshot；需要改计划时按 Adaptation Decision -> policy validation -> immutable Plan Revision -> checkpoint 顺序执行。
- 综合、审计、比较和报告完成后，必须从原 Run 的完整 validated Manifest/Evidence 集派生 `report.json`、`decision-brief.md` 与 `report.md`，并完成 schema、traceability、freshness 和 consistency checks。所有 validated Evidence 必须被采用或给出排除理由。`terminate_insufficient_evidence` 或 `record_runtime_failure` 的 apply input 必须携带 main-agent terminal report source；后者只处置 blocking `runtime_blocked` Gap，并把原 Run 如实终止为运行失败。不能创建 reporting continuation Run、先改终态或用 chat 代替 Brief。
- Project hooks 与本地 Evidence MCP 只是可选 guardrail/adapter。hooks 被禁用或 MCP 不可用时，继续使用本节显式 Skill 步骤与 scripts；不得降低 Artifact 验证或 Store 交接要求。
- 活动正式 Run 遇到需要修改 `harness/`、schema/policy、Skill/hook 或冻结工具链的 blocker 时，必须先通过 `record_runtime_failure` 在原 Run 生成 terminal report 并终止为 `failed`。不得修改生产代码后继续、恢复或重验同一 `run_id`；修复和工程验证完成后必须创建新的 `run_id`。
- 正常研究 Run 不执行 `npm test`、lint、typecheck、fixture/schema 全量验证或 clean-checkout suite。它只运行一次 doctor，以及当前 Artifact、Plan、Gap/adaptation、report、traceability/consistency 和 `status-run` 所需的确定性检查；全量仓库验证只属于代码、contract、schema、policy、Skill/hook 或工具链变更任务。
- G1 concept assessment 的 buyer/acquisition follow-up 只能消费 exact same-Run/current Plan/assessment plan/subject/scope/coverage_key/observed Artifact 与 unit-attempt state 绑定的 `gap_snapshot.v2`。Decision 只允许 `add_unit` 或 `stop_followup`；前者发布 Research Plan、assessment plan 和 Planning Context 的同批 immutable revision 后执行 Manifest CAS，后者不创建新 revision。
- 可以建议外部验证，但必须明确由用户负责并标记为不支持执行/跟踪；本系统不执行外部验证。

## Progressive References

- 研究方法与 context hygiene：`references/research-kernel.md`。
- Lane role 与 typed handoff：`references/lane-catalog.md`。
- 正式来源、ownership 和发布规则：`references/artifact-contracts.md`。
- 比较边界：`references/comparison-policy.md`。
- JSON、decision brief 与完整 report 的关系：`references/report-contract.md`。

## Script Surface

`scripts/doctor.ts`、`validate-artifact.ts`、`create-run.ts`、`propose-scope.ts`、`confirm-scope.ts`、`load-run.ts`、`status-run.ts`、`record-evidence.ts`、`publish-artifact.ts`、`checkpoint-run.ts`、`validate-plan.ts`、`analyze-gaps.ts`、`validate-adaptation.ts`、`apply-plan-revision.ts`、`calculate-comparison.ts`、`calculate-sensitivity.ts`、`audit-traceability.ts` 和 `build-report.ts` 已可运行。Harness CLI 另提供 `scaffold-artifact`、`compile-artifacts` 与 `materialize-lane-result`。terminal gate 可把后续 unit 标为 `skipped`，但 execution completeness、research conclusion 和 runtime health 仍分别报告；`build-report` 只消费显式 main-agent source 并确定性派生本地化用户 view 和分离的结构化审计数据。没有 research、benchmark、agent/LLM dispatch 或 hidden judgment command。Store/schema success 不代表 Evidence 真实/充分、决策就绪、research 完成、产品可行或 validation success。
