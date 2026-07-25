---
name: startup-opportunity
description: 发现并评估消费级 Startup Opportunity，评估具体产品或功能 thesis 的当前 Evidence，或检查并恢复仓库支持的研究 Run。适用于 Startup Opportunity 方向研究、concept evidence assessment、替代方案、买方与获客 Evidence、AI baseline 比较和现有 Run 状态。
---

# Startup Opportunity

将此 Skill 作为 Startup Opportunity 研究唯一的 repo-local 入口。RFC 是业务与 Artifact contract 的权威来源，implementation progress 账本是当前可执行切片的权威来源。

## Current Execution Gate

依赖此仓库前，先运行 `npm run harness -- doctor --json`。G1.4 已实现 closed schema/reference 验证、受限 Run/reopen、Artifact/Evidence Store、checkpoint/recovery、G0 Plan/Adaptation runtime、显式 Research Task/Evidence/Claim/Finding/Insight/Source Manifest/branch publication、buyer/acquisition dynamic adaptation，以及 Evidence audit、Adversarial Review、Assessment/Hard Gate、Traceability 和 concept report publication/recovery。这些入口只验证、发布、materialize 和恢复调用方给出的 Artifact；不会分派 agent、调用 LLM、执行 network research，也不会把 `discover`、`assess`、`resume` 或 `status` 变成完整研究动作。

## Action Routing

- `discover` 映射到 `opportunity_discovery`；仅在该 mode 下读取 `references/opportunity-discovery.md`。
- `assess` 映射到 `concept_evidence_assessment`；仅在该 mode 下读取 `references/concept-evidence-assessment.md`。
- `resume` 和 `status` 需要持久化的 `run_id`；处理存储状态前读取 `references/artifact-contracts.md`。`status` 只读，绝不启动 subagent。
- 如果请求混合宽泛 discovery 与具体 thesis，且选择会改变输出 contract，则在创建 Run 前要求澄清。
- Run 不得静默改变 mode，并且只包含一个主要市场和一种主要研究语言。

## Non-Negotiable Rules

- 按需渐进读取 mode 与 phase reference；默认不得同时加载两套完整工作流。
- 正式结论只能来自已经验证的仓库 Artifact，绝不能来自 chat 或 subagent 完成消息。
- 绝不伪造 Evidence、来源 provenance、用户原话、市场数据、验证结果或引用。
- 为每个 subagent 提供 typed task envelope 和唯一 output path。main agent 始终是唯一 orchestrator。
- 语义判断留给 agent；deterministic 验证、存储、版本控制和报告机制留给 Harness。
- 绝不覆盖 current plan。Runtime 调整必须依次经过 Gap Snapshot、一个或多个已验证 Adaptation Decision 和不可变 Plan Revision。
- G1 concept assessment 的 buyer/acquisition follow-up 只能消费 exact same-Run/current Plan/assessment plan/subject/scope/coverage_key/observed Artifact 与 unit-attempt state 绑定的 `gap_snapshot.v2`。Decision 只允许 `add_unit` 或 `stop_followup`；前者发布 Research Plan、assessment plan 和 Planning Context 的同批 immutable revision 后执行 Manifest CAS，后者不创建新 revision。
- 可以建议外部验证，但必须明确由用户负责并标记为不支持执行/跟踪；本系统不执行外部验证。

## Progressive References

- 研究方法与 context hygiene：`references/research-kernel.md`。
- Lane role 与 typed handoff：`references/lane-catalog.md`。
- 正式来源、ownership 和发布规则：`references/artifact-contracts.md`。
- 比较边界：`references/comparison-policy.md`。
- JSON、decision brief 与完整 report 的关系：`references/report-contract.md`。

## Script Surface

`scripts/doctor.ts`、`validate-artifact.ts`、`create-run.ts`、`load-run.ts`、`record-evidence.ts`、`publish-artifact.ts`、`checkpoint-run.ts`、`validate-plan.ts`、`analyze-gaps.ts`、`validate-adaptation.ts`、`apply-plan-revision.ts`、`audit-traceability.ts` 和 `build-report.ts` 已可运行。`audit-traceability --bundle` 只审计显式 closed bundle；`build-report --file` 只消费一个已形成的 v7 concept report envelope，按 receipt 顺序发布 sidecar 并 materialize 三个 view。`analyze-gaps` 不替 agent 选择语义或获取 Evidence。Store、schema、Plan/Adaptation、audit 或 report 成功不代表 Evidence 真实/充分、决策就绪、thesis 成立或 research 已完成。其余 RFC 命名 script 在 owning slice 开放前继续 fail closed；不得把失败转换成 mock Artifact 或成功结果。
