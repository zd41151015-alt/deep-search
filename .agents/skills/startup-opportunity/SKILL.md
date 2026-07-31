---
name: startup-opportunity
description: 发现并评估消费级 Startup Opportunity，评估具体产品或功能 thesis 的当前 Evidence，或检查并恢复仓库支持的研究 Run。适用于 Startup Opportunity 方向研究、concept evidence assessment、替代方案、买方与获客 Evidence、AI baseline 比较和现有 Run 状态。
---

# Startup Opportunity

将此 Skill 作为 Startup Opportunity 研究唯一的 repo-local 入口。RFC 与已发布 contract 是业务/Artifact 边界的权威来源，当前代码与 `doctor` 决定可执行能力；implementation progress 只作为历史施工账本，不门禁维护或后续产品迭代。

## Current Execution Gate

依赖此仓库前，先运行 `npm run harness -- doctor --json`。G0-G3 已提供 caller-supplied Artifact 的确定性 Run、Evidence、validation、adaptation、comparison 与 report surface；G4 提供 repo-local Skill、custom agents、可选 hooks 和本地 Evidence MCP adapter。Harness 不分派 agent、调用 LLM、执行 lane、benchmark 或 network research，也不自行形成 coverage、baseline、comparison、recommendation 或 AI bundle 判断。

## Action Routing

- `discover` 映射到新 Run 的 `opportunity_discovery`；向用户呈现解析后的 action/mode，按 `scripts/create-run.ts` 创建 Run，只读取 `references/opportunity-discovery.md`。
- `assess` 映射到新 Run 的 `concept_evidence_assessment`；向用户呈现解析后的 action/mode，按 `scripts/create-run.ts` 创建 Run，只读取 `references/concept-evidence-assessment.md`。
- `resume` 需要持久化 `run_id`；先读取 `references/artifact-contracts.md`，再运行 `scripts/load-run.ts` 完成显式恢复，从 validated manifest/checkpoint 继续当前 mode。
- `status` 需要持久化 `run_id`；先读取 `references/artifact-contracts.md`，再运行只读 `scripts/status-run.ts`。同时读取 `derivedExecutionDisposition`、`terminalReportDisposition` 和 `terminalReportIssues`；terminal Manifest 不等于已完成报告交付。绝不启动 subagent、恢复或修改 Run。
- 如果请求混合宽泛 discovery 与具体 thesis，且选择会改变输出 contract，则在创建 Run 前要求澄清。
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
- 每次 wave 后先验证 Artifact，再形成 Gap Snapshot；需要改计划时按 Adaptation Decision -> policy validation -> immutable Plan Revision -> checkpoint 顺序执行。
- 综合、审计、比较和报告完成后，必须从同一 validated `report.json` 派生 `decision-brief.md` 与 `report.md`，完成 schema、traceability、freshness 和 consistency checks 后才交付。`terminate_insufficient_evidence` 的 apply input 必须携带 main-agent v17 `terminal_report_envelope`；不能先改终态再用 chat 代替 Brief。
- Project hooks 与本地 Evidence MCP 只是可选 guardrail/adapter。hooks 被禁用或 MCP 不可用时，继续使用本节显式 Skill 步骤与 scripts；不得降低 Artifact 验证或 Store 交接要求。
- G1 concept assessment 的 buyer/acquisition follow-up 只能消费 exact same-Run/current Plan/assessment plan/subject/scope/coverage_key/observed Artifact 与 unit-attempt state 绑定的 `gap_snapshot.v2`。Decision 只允许 `add_unit` 或 `stop_followup`；前者发布 Research Plan、assessment plan 和 Planning Context 的同批 immutable revision 后执行 Manifest CAS，后者不创建新 revision。
- 可以建议外部验证，但必须明确由用户负责并标记为不支持执行/跟踪；本系统不执行外部验证。

## Progressive References

- 研究方法与 context hygiene：`references/research-kernel.md`。
- Lane role 与 typed handoff：`references/lane-catalog.md`。
- 正式来源、ownership 和发布规则：`references/artifact-contracts.md`。
- 比较边界：`references/comparison-policy.md`。
- JSON、decision brief 与完整 report 的关系：`references/report-contract.md`。

## Script Surface

`scripts/doctor.ts`、`validate-artifact.ts`、`create-run.ts`、`load-run.ts`、`record-evidence.ts`、`publish-artifact.ts`、`checkpoint-run.ts`、`validate-plan.ts`、`analyze-gaps.ts`、`validate-adaptation.ts`、`apply-plan-revision.ts`、`calculate-comparison.ts`、`calculate-sensitivity.ts`、`audit-traceability.ts` 和 `build-report.ts` 已可运行。默认 bundle `16.0.0` 增加 v17/receipt v15 terminal reporting contract；`build-report` 可消费显式 v17 main-agent source，并只确定性派生本地化 Brief、完整 view 和 Consistency v4。没有 research、benchmark、agent/LLM dispatch 或 hidden judgment command。Store/schema success 不代表 Evidence 真实/充分、决策就绪、research 完成、产品可行或 validation success。
