---
name: startup-opportunity
description: 发现并评估消费级 Startup Opportunity，评估具体产品或功能 thesis 的当前 Evidence，或检查并恢复仓库支持的研究 Run。适用于 Startup Opportunity 方向研究、concept evidence assessment、替代方案、买方与获客 Evidence、AI baseline 比较和现有 Run 状态。
---

# Startup Opportunity

将此 Skill 作为 Startup Opportunity 研究唯一的 repo-local 入口。RFC 是业务与 Artifact contract 的权威来源，implementation progress 账本是当前可执行切片的权威来源。

## Current Execution Gate

依赖此仓库前，先运行 `npm run harness -- doctor --json`。G0.4 已实现 closed core schema/reference 验证、受限 Run 创建与 reopen、正式 Artifact 发布、Event/Decision append、Evidence 原始内容去重、checkpoint 与 crash recovery；还实现 Research Plan 语义验证、machine Gap Snapshot draft、Adaptation Decision v2 policy 验证，以及通过 CAS 和不可变 receipt 应用 Plan Revision。这些 deterministic Store/Plan 入口不会分派研究，也不会把 `discover`、`assess`、`resume` 或 `status` 变成已完成的研究动作。下游 reserved script 以非零状态退出并指出其 owning slice。

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
- 可以建议外部验证，但必须明确由用户负责并标记为不支持执行/跟踪；本系统不执行外部验证。

## Progressive References

- 研究方法与 context hygiene：`references/research-kernel.md`。
- Lane role 与 typed handoff：`references/lane-catalog.md`。
- 正式来源、ownership 和发布规则：`references/artifact-contracts.md`。
- 比较边界：`references/comparison-policy.md`。
- JSON、decision brief 与完整 report 的关系：`references/report-contract.md`。

## Script Surface

`scripts/doctor.ts`、`validate-artifact.ts`、`create-run.ts`、`load-run.ts`、`record-evidence.ts`、`checkpoint-run.ts`、`validate-plan.ts`、`analyze-gaps.ts`、`validate-adaptation.ts` 和 `apply-plan-revision.ts` 在 G0.4 已可运行。Store 或 Plan/Adaptation 验证成功不代表 Evidence 充分、决策就绪或研究动作已经完成。`record-evidence` 当前只持久化 G0 substrate，不实现 G1.2 Evidence judgment contract。其余 RFC 命名的 script 在进度账本开放其 owning slice 前会刻意 fail closed；调用方不得把该失败转换成 mock Artifact 或成功结果。
