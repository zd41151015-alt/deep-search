---
name: startup-opportunity
description: 发现并评估消费级 Startup Opportunity，评估具体产品或功能 thesis 的当前 Evidence，或检查并恢复仓库支持的研究 Run。适用于 Startup Opportunity 方向研究、concept evidence assessment、替代方案、买方与获客 Evidence、AI baseline 比较和现有 Run 状态。
---

# Startup Opportunity

将此 Skill 作为 Startup Opportunity 研究唯一的 repo-local 入口。RFC 与已发布 contract 是业务/Artifact 边界的权威来源，当前代码与 `doctor` 决定可执行能力；implementation progress 只作为历史施工账本，不门禁维护或后续产品迭代。

## Current Execution Gate

每个任务第一次依赖此仓库前运行一次 `npm run harness -- doctor --json`；同一任务内不要在每个 phase、lane 或 context transition 后重复运行。Harness 提供 caller-supplied Artifact 的确定性 Run、Evidence、validation、adaptation、comparison、scaffold 与 report surface，并从 Lane 研究语义机械生成正式 Audit 的 ID/hash/ref、freshness、coverage closure、ranking/ceiling 和报告投影。Harness 不分派 agent、调用 LLM、执行 lane、benchmark 或 network research，也不替 agent 形成研究语义、comparison、recommendation 或 AI bundle 判断。

## Action Routing

- `discover` 映射到新 Run 的 `opportunity_discovery`；向用户呈现解析后的 action/mode，按 `scripts/create-run.ts` 创建 Run，只读取 `references/opportunity-discovery.md`。进入 G2.4 规划时必须通过 `scaffold-artifact` 的 `planning_capabilities` kind 读取 current capability，不得从测试 fixture 推断 Unit 数量或拓扑。
- `assess` 映射到新 Run 的 `concept_evidence_assessment`；向用户呈现解析后的 action/mode，按 `scripts/create-run.ts` 创建 Run，只读取 `references/concept-evidence-assessment.md`。
- `resume` 需要持久化 `run_id`；先读取 `references/artifact-contracts.md`，再运行 `scripts/load-run.ts` 完成显式恢复，从 validated manifest/checkpoint 继续当前 mode。
- `status` 需要持久化 `run_id`；先读取 `references/artifact-contracts.md`，再运行只读 `scripts/status-run.ts`。同时读取 `derivedExecutionDisposition`、`terminalReportDisposition` 和 `terminalReportIssues`；terminal Manifest 不等于已完成报告交付。绝不启动 subagent、恢复或修改 Run。
- 如果请求混合宽泛 discovery 与具体 thesis，且选择会改变输出 contract，则在创建 Run 前要求澄清。
- 创建任何正式 Run 前，必须取得用户明确给出的地域、B2C/B2B/B2B2C/mixed、目标用户群、决策目标和主要研究语言；不得从用户所用语言推断市场。`create-run` 会拒绝缺少这些参数的请求，并在写入前把支持的人类语言名称规范为用户可见的 BCP-47 值（例如 `中文` 为 `zh-CN`）。
- Scope 只记录三类团队信息：用户明确的硬约束、已知优势或明显短板，以及显式保持 `unknown` 的其他团队条件。用户提供、用户确认的临时假设和未确认假设必须保留 provenance/confirmation truth；未知团队信息不得阻止发现研究，Harness 不主动追问或补全团队档案。
- Run 不得静默改变 mode，并且只包含一个主要市场和一种主要研究语言。

## Non-Negotiable Rules

- 按需渐进读取 mode 与 phase reference；默认不得同时加载两套完整工作流。
- 正式结论只能来自已经验证的仓库 Artifact，绝不能来自 chat 或 subagent 完成消息。
- 旧 Run 的 Map、Candidate 或任何结论语义不得直接进入当前 Agent 上下文。单目标兼容入口仍使用 `scripts/admit-prior-input.ts` / `scripts/read-prior-input.ts` 的 exact admission 与保守 provenance taint。用户明确授权复用另一个 current-contract Run 的成组研究时，目标 Run 必须先确认 Scope；Discovery 还必须先发布 current Plan，Assessment 只可用 Harness 标记的 pre-Plan handoff 形成首个 intake Concept，随后按普通 exact closure 发布 Plan。再用 `scripts/create-research-handoff.ts` 提交 exact source run/path/byte hash/content hash、授权声明、目标用途和逐项 role；只有 `scripts/read-research-handoff.ts` 可以从目标 Run 的 immutable handoff Artifact 读取选定 item。`reusable_evidence` 会复制 exact raw bytes 到目标 Evidence Store并保留原 source/provenance；Claim、Finding、Judgment、报告结论只能作为 `prior_synthesis` / `revalidation_required` 背景，不能自动提高 confidence。不得继承 Plan、Task、Gate、排序、执行或终态，不得直接、动态、glob、变量或 `find` 扫描 source Run。以上 provenance 约束不进入 Gate、淘汰、排序、Claim confidence、recommendation ceiling、Lane success 或发布资格。
- 绝不伪造 Evidence、来源 provenance、用户原话、市场数据、验证结果或引用。
- 为每个 subagent 提供 typed task envelope 和唯一 output path。main agent 始终是唯一 orchestrator。
- 语义判断留给 agent；deterministic 验证、存储、版本控制和报告机制留给 Harness。
- 每个 Opportunity 的 `team_fit_and_learning` panel 还由主 Agent提交五维“团队启动负担分析”（启动资本/开发复杂度、持续人工交付、获客与渠道依赖、合规/数据/专业责任、首次有效验证或收入时间），逐维保留 assessment、支持/反对 refs、limitations 和 `partial`/`unknown`/`insufficient_evidence` 等诚实状态。Harness 只验证 same-Run、subject/ref/hash 和报告闭合，不分析 Evidence、不评分、不排除高负担机会。
- 主 Agent 必须把 Scope 中已知团队条件与每个机会的启动负担显式提交为 `match`、`conditional`、`mismatch` 或 `unknown`，并写出未知前提、会改变结论的条件和限制。排序必须引用这些匹配分析，同时继续保留需求、买方、替代、证据强度和反对材料；可以提交并列、局部排序或因 Evidence 不足明确未排序的机会。团队匹配不是 Harness 自动排序或默认硬拒绝，Harness 只机械校验排序闭包和 first bet 与显式顶部排序的一致性。
- 绝不覆盖 current plan。Runtime 调整必须依次经过 Gap Snapshot、一个或多个已验证 Adaptation Decision 和不可变 Plan Revision。
- 新 Run 必须先形成并发布 Intake、DecisionContext 与 ScopeFrame，再生成和验证 `plans/research-plan.r1.json`；不得从聊天摘要跳到 research wave。
- 每个 wave 只使用 typed task envelope 启动 bounded custom agent。agent completion summary 只作通知，父任务必须从唯一 output path 重新读取并验证正式 Artifact。
- G2.1 setup、每个新 dispatch wave、G2.2 fan-in 和 G2.3 synthesis 都必须由 Main Agent 把研究语义提交给 `materialize-formal-stage`：先 `validate_only` 取得零写入 publication plan，再用完全相同请求与 exact `publication_plan` 执行 `publish`。Harness 只从 current Scope/Plan/Dispatch/Lane delivery authority 机械生成 path/revision/ref/hash/binding、Execution/Dispatch/Task 投影、Envelope 和原子发布计划；不选择研究方向、不形成候选处置、不推断对象关系、不启动 lane。Plan-level discovery adversarial review 使用 `stage_kind="review"`、`lane_role="review"`、`candidate_scope.kind="none"`、`source_phase="adversarial_challenger"`，物化为 `startup_opportunity.research_task.discovery_review.current`，输出 `artifacts/reviews/*.json` 的 `startup_opportunity.discovery_adversarial_review.current`，后续由 `adversarial_reviewer` 通过 `materialize-lane-result validate_only -> publish` 交付。G2.2 fan-in 的唯一当前权威仍是 `startup_opportunity.discovery_fan_in.v2`；Main Agent 可在 fan-in 物化具体 pre-candidate、显式 split/merge relation 和 retained/watchlist/rejected disposition，Harness 只校验 exact set/ref/hash/current revision/same-Run/publication 闭包。G2.3 synthesis 只能正式化 retained concrete pre-candidate，不在 conversion/formalization 时隐式拆分或合并候选。发布成功前不得启动任何 lane，不得先发布 Dispatch 激活 unit 再补 task。`compile-artifacts` 仅用于这些 stage 接口之外的通用 caller-supplied formal Artifacts。
- 同一 dispatch batch 中彼此独立的 lane 在 `dispatch_mode=parallel_immediate` 发布后，严格按下述 Model Dispatch Protocol 启动；Harness 只验证机械投影，不调度 agent。
- 搜索规划以 60%-70% 用户/商业行为、15%-20% 经营披露/监管/市场结构、不超过 20% 学术机制/边界/反证为默认提示，不要求实际查询次数严格命中比例，也不以偏差作为 Gate。实际采用来源分布只能由 Evidence Register 机械推导，不能使用 agent 自报比例；比例偏差只进入审计观察。真实性、安全、exact ref/hash、数值/proxy 语义和强结论 Evidence ceiling 是强门禁；覆盖不足或来源偏弱只降低 confidence、ranking 或 recommendation ceiling。
- 商业覆盖必须标为 `observed`、`inferred` 或 `unknown`。缺少直接材料时保留合理推测，但必须写出依据引用、推理起点、推理过程、不确定性和待验证项；`inferred` 可满足报告内容完整性，不得冒充已观察事实或满足排序 Gate。多候选 Lane 的 unresolved gap 要提供可推导的 subject 语义（单候选可省略，真正共享可显式列多个 subject）；Harness 会机械补齐 exact task/Audit binding 并投影 subject-local 正式 gap，不得把一个候选的 gap 复制到其他候选。
- Incumbent Absorption & Response Risk 只在候选或 concept 已形成后开展：candidate generation 必须 `not_assigned`，formed candidate evaluation 使用 bounded `lightweight_scan`，shortlist/retained opportunity 或 assessment commercial stage 才使用计划明确分配的 `targeted_deep_dive`。Execution Plan 是 assignment 唯一权威；每个响应研究 stage 恰有一个 `owner`，额外复核只能显式标为 `independent_review`，其余 Lane 必须 `not_assigned/none`。包括 `not_assigned` 在内的每个 assignment 都必须按 Plan -> Dispatch -> Research Task -> 正式 Audit exact subject/role/depth 投影；缺少任一层或发生漂移都属于 integrity error，Task 没有 fallback 权威。Lane 一次性交付 responder 研究语义，Harness 只生成稳定 ID/hash/ref、coverage/缺口行和报告投影。
- 潜在响应者可为同类 incumbent、platform owner、suite incumbent、adjacent leader、channel/distribution controller、data owner、marketplace 或其他控制关键入口的主体。分析必须分别说明 ability/capability adjacency、implementation/operational/compliance/data/distribution cost、incentive 与 disincentive/cannibalization、response horizon、distribution leverage、response mode、可覆盖的 thesis 范围和 residual differentiation；“能做”不能推导“会做”，复制单一 feature 不能推导完整价值主张已被覆盖。
- Incumbent Response 只作 judgment context，不是 Gate，不自动淘汰或 unrank，不自动降低 Claim confidence，不产生 recommendation ceiling，也不阻塞 Lane、候选、Audit 或报告发布。Agent 对 `assessed` 只提交 responder、能力、成本、动机、时间、分发、thesis coverage、residual differentiation、Evidence roles、推理边界与不确定性等结构化研究维度，不提交 pass/fail、淘汰、行动或 ceiling 指令；Harness 独占并确定性注入 validator 可验证的固定 reference-only `strategic_implication` 与决策边界。没有相关 responder 时只提交 `not_applicable` 与理由，缺少足够材料形成完整判断时提交 `unknown`、uncertainty、unknowns、data gaps，并可选保留 supporting/opposing/background Evidence refs，Harness 再扩展为统一安全报告行。`unknown` 的正式 rationale 只说明已提交材料与语义不足以形成完整 responder-specific conclusion，不声称没有 assessment 或没有任何 Evidence；其能力、成本、动机、时间、thesis coverage、residual differentiation 和 confidence 仍安全展开为 unknown/空。可选 refs 继续接受 same-Audit Evidence Register、exact ref/hash、Run 与安全校验。`unknown` 必须进入 Search Closure 与报告 gap，`not_applicable` 不算 gap；每张正式响应风险表无论有无数据都固定声明 context-only/非门禁。新闻、评论、论坛、厂商、监管、API/数据集、proxy/estimate 以及 supporting/opposing/background Evidence 全部保留并标注角色，不要求 adopted 才能作为 opposing/background；只有伪造、broken exact ref/hash、跨 Run、敏感信息、访问控制或错误引用继续 fail closed，不设置来源、provider 或 API 白名单。
- 每个计划 lane 都必须在 `completed`、证据不足、early stop 或搜索失败等终态留下 Search Closure；纯综合/校验使用 `search_not_required`，搜索前失败使用 `failed_before_search`。只对正式提交的 search results 与 Evidence Register 对账；`telemetry_basis=unavailable` 时提交研究目标、主要 route、采用来源、已有记录和停止原因即可，`query_log_complete=false` 是正常披露，不得伪装为 Harness 已验证的完整浏览器日志。
- G2.3 的 main Agent 必须在正式 Merge 中为每个 frozen Opportunity 恰好声明一次机会家族关系：独立机会、共享机会家族下的细分人群变体、交付/实施变体或 unknown。Agent声明 family identity/title、共享价值/方案机制及其 state、共享假设与失败风险、member-specific 差异的 dimension/state/description、supporting/opposing/background/unknown refs、limitations 和 unresolved questions；不得根据标题、embedding、文本相似度、`uses_ai` 或字段相同自动聚类。Harness 只从 exact Opportunity 与 selected Solution 机械投影 hash、`uses_ai`、`solution_type` 和 `delivery_form`，并验证闭包、same-Run、lineage、merge/family 交叉一致性和报告一致性；多成员 `decision=merge` 只能落在同一个 shared family 的 segment/delivery members 内，split/preserve 不反向强制拆开 shared family。
- 机会家族不折叠或删除任何 Opportunity、segment、Evidence、hard gate、comparison、ranking 或 ceiling。G2.4 继续逐 Opportunity研究、比较和排序，同时展示共享机制与风险相关性。用户请求“3–5 个机会”等数量时，按正式 family projection 准确报告“X 个机会家族、Y 个具体方向”；同一 family 的多个 segment 不得无条件称为多个独立创业机会。只有一个 family 是合法结果，不得为满足数量制造、删除或强行改造方向。
- Wave 1 没有需求、买方或购买信号时，立即以证据不足收口，不进入具体方案评估。
- 每次 wave 后先验证 Artifact，再形成 Gap Snapshot；需要改计划时按 Adaptation Decision -> policy validation -> immutable Plan Revision -> checkpoint 顺序执行。
- 综合、审计、比较和报告完成后，必须从原 Run 的完整 validated Manifest/Evidence 集和同一个 final report model 派生 `report.json`、`decision-brief.md`、`report.md` 与 `audit-appendix.md`，并完成 schema、traceability、freshness 和 consistency checks。Manifest-authoritative snapshot 的每个 current/final subject 必须先形成一个 exact same-Run `decision_subject_synthesis`；Harness 只从这些 synthesis 投影完整 Direction 和验证计划，caller 不得让历史或其他主体正文补位。dropped/superseded Candidate、Opportunity Thesis 或 Concept 只有在各自 direct immutable revision、终止 snapshot 后由 Store 正式发布且进入新 formation/synthesis closure 的依据，以及 `scripts/reform-decision-subject.ts` 生成的 exact Decision 全部闭合后才能重新形成；同 ref、自引用、无关或仅终止前依据均禁止。所有 validated Evidence 必须被采用或给出排除理由。`terminate_insufficient_evidence` 或 `record_runtime_failure` 的 apply input 必须携带 main-agent terminal report source；后者只处置 blocking `runtime_blocked` Gap，并把原 Run 如实终止为运行失败。不能创建 reporting continuation Run、先改终态或用 chat 代替 Brief。
- Project hooks 与本地 Evidence MCP 只是可选 guardrail/adapter。hooks 被禁用或 MCP 不可用时，继续使用本节显式 Skill 步骤与 scripts；不得降低 Artifact 验证或 Store 交接要求。
- 活动正式 Run 遇到需要修改 `harness/`、schema/policy、Skill/hook 或冻结工具链的 blocker 时，必须先通过 `record_runtime_failure` 在原 Run 生成 terminal report 并终止为 `failed`。不得修改生产代码后继续、恢复或重验同一 `run_id`；修复和工程验证完成后必须创建新的 `run_id`。
- 正常研究 Run 不执行 `npm test`、lint、typecheck、fixture/schema 全量验证或 clean-checkout suite。它只运行一次 doctor，以及当前 Artifact、Plan、Gap/adaptation、report、traceability/consistency 和 `status-run` 所需的确定性检查；全量仓库验证只属于代码、contract、schema、policy、Skill/hook 或工具链变更任务。
- G1 concept assessment 的 buyer/acquisition follow-up 只能消费 exact same-Run/current Plan/assessment plan/subject/scope/coverage_key/observed Artifact 与 unit-attempt state 绑定的 `gap_snapshot.v2`。Decision 只允许 `add_unit` 或 `stop_followup`；前者发布 Research Plan、assessment plan 和 Planning Context 的同批 immutable revision 后执行 Manifest CAS，后者不创建新 revision。
- 可以建议外部验证，但必须明确由用户负责并标记为不支持执行/跟踪；本系统不执行外部验证。

## Model Dispatch Protocol

对每个已成功发布的 `parallel_immediate` Dispatch batch 执行以下不可省略的模型侧协议：

1. 在任何启动调用前，从已发布 batch 一次性提取并固定 `planned_unit_ids`，同时初始化 `acknowledged_unit_ids=[]`、`failed_unit_ids=[]`。为全部 Unit 预先准备以 exact typed task ref 为权限来源的最短启动 Prompt；不得依靠后续模型轮次回忆剩余 Unit。
2. 只直接调用当前协作层暴露的 `spawn_agent` 工具。绝不从 `functions.exec`、`exec_command`、shell、脚本或其 `tools.*` 命名空间嵌套调用 `spawn_agent`；直接工具不可用时立即报告 dispatch blocked，不得探测替代命名空间或用 shell 模拟。
3. 在同一个 tool round 发出全部独立 Unit 的直接 `spawn_agent` 调用，不在调用之间插入新的模型推理、`true`、`sleep`、空 patch、工具目录查询、状态查询或其他无关操作。Prompt 只携带 exact task ref、唯一 Unit 身份和读取该 task 执行的指令，研究目标与边界继续以已发布 task envelope 为准。
4. 只有收到成功的 spawn acknowledgement 才把 exact `unit_id` 加入 `acknowledged_unit_ids`；调用已发出、Task 已发布或 Manifest unit 为 active 都不等于 agent 已启动。失败或无明确回执的 Unit 加入 `failed_unit_ids`。对本轮实际收到的 acknowledgement，立即以 compiler 返回的 exact Dispatch ref/hash 与 checklist unit/task/attempt identity 调用 `register-dispatch-launches`；允许按 acknowledgement 分批、乱序登记，不登记失败或无明确回执的 Unit。
5. 启动轮结束后调用 `check-dispatch-launches`，从正式 Lane Lifecycle 记录读取 `started_unit_ids` 与 `not_started_unit_ids`，并计算 `missing_unit_ids = planned_unit_ids - acknowledged_unit_ids`。Harness 只验证 caller declaration 与 exact Dispatch 集合一致，不能证明外部 Codex task 真实存在。只有 `set(acknowledged_unit_ids) == set(planned_unit_ids)`、集合检查为 `closed` 且 `failed_unit_ids` 与 `missing_unit_ids` 都为空，才能宣告完整 wave 已并行运行；否则必须准确报告已启动数量、失败和缺失 Unit，不得使用“全部已启动”或等价表述。
6. 部分失败时先通过协作层 agent 列表按稳定 Unit/task identity 排除已成功或仍在启动的重复实例，再只补启动 `missing_unit_ids`；不得重放整个 batch。每次补偿后重复 acknowledgement 登记与集合闭包检查，闭包前不得进入“等待全部 Lane”或 fan-in。`not_started` 只表示 Dispatch 集合差异，不是 failed、partial、no_evidence_found 或研究结论；Main Agent 必须按现有 straggler/adaptation/current contracts 决定等待、重试、接受部分、跳过/取消或调整 Plan，Harness 不替它作处置决定。

## Progressive References

- 研究方法与 context hygiene：`references/research-kernel.md`。
- Lane role 与 typed handoff：`references/lane-catalog.md`。
- 正式来源、ownership 和发布规则：`references/artifact-contracts.md`。
- 比较边界：`references/comparison-policy.md`。
- JSON、decision brief 与完整 report 的关系：`references/report-contract.md`。

## Script Surface

`scripts/doctor.ts`、`validate-artifact.ts`、`create-run.ts`、`propose-scope.ts`、`confirm-scope.ts`、`load-run.ts`、`status-run.ts`、`admit-prior-input.ts`、`read-prior-input.ts`、`create-research-handoff.ts`、`read-research-handoff.ts`、`reform-decision-subject.ts`、`record-evidence.ts`、`publish-artifact.ts`、`checkpoint-run.ts`、`validate-plan.ts`、`analyze-gaps.ts`、`validate-adaptation.ts`、`apply-plan-revision.ts`、`author-plan-adaptation.ts`、`calculate-comparison.ts`、`calculate-sensitivity.ts`、`audit-traceability.ts` 和 `build-report.ts` 已可运行。正式 Run 调用 `validate-plan.ts`、`analyze-gaps.ts` 或 `validate-adaptation.ts` 时传入 `--run-id <RUN_ID> --runs-root <RUNS_ROOT>`，以装配 current Manifest、exact JSONL、历史 Plan binding 与当前 subject/Plan 隔离；省略 `--run-id` 只用于纯 bundle validation。`author-plan-adaptation.ts` 接受 Main Agent 明确提交的 Gap machine/semantic inputs 与 Adaptation actions，在 `validate_only`、正式 Gap/Decision `publish`、精确 ref 的 Plan `apply` 三个阶段间复用 current Manifest CAS 和原子 Plan Revision Runtime，不推断研究含义。Harness CLI 另提供 `scaffold-artifact`、`compile-artifacts`、`materialize-formal-stage`、`materialize-lane-result`、`scaffold-lane-submission`、`register-dispatch-launches` 与 `check-dispatch-launches`；G2.1 setup、dispatch wave（含 discovery review wave）、G2.2 fan-in 和 G2.3 synthesis 的正式路径优先使用 `materialize-formal-stage validate_only` -> exact `publish`，Lane/reviewer 交付使用 `scaffold-lane-submission` -> `materialize-lane-result validate_only` -> exact `publish`。terminal gate 可把后续 unit 标为 `skipped`，但 execution completeness、research conclusion 和 runtime health 仍分别报告；terminal main-agent source 只能随 `apply-plan-revision` 或 `author-plan-adaptation` 的原子终态收口提交，`build-report` 仅消费非终态 assessment/discovery source 并确定性派生本地化用户 view 和分离的结构化审计数据。没有 research、benchmark、agent/LLM dispatch、thread API 或 hidden judgment command。Store/schema/launch registration success 不代表外部 task 真实存在、Evidence 真实/充分、决策就绪、research 完成、产品可行或 validation success。
